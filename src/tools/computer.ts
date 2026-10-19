/**
 * Opt-in Computer Use. Keeps the actual OS manipulation in a small, local,
 * non-shell Python bridge. This file owns the observed screenshot coordinate
 * space, expiration and serialization of all GUI operations.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { ServerResult } from '../types.js';
import { computerToolArgSchemas, type ComputerToolName } from './computer-schemas.js';

const BRIDGE_PATH = fileURLToPath(new URL('../computer-use/bridge.py', import.meta.url));
const MAX_OUTPUT_BYTES = 18 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1_400_000;
export const SCREENSHOT_TTL_MS = 120_000;

export interface BridgeReply {
  ok: boolean;
  error?: string;
  platform?: string;
  logical_width?: number;
  logical_height?: number;
  pixel_width?: number;
  pixel_height?: number;
  image_base64?: string;
  windows?: string[];
  primary_display_only?: boolean;
  display?: string;
  applied?: boolean;
}
export type BridgeRunner = (payload: Record<string, unknown>) => Promise<BridgeReply>;

export function runPythonBridge(payload: Record<string, unknown>): Promise<BridgeReply> {
  return new Promise((resolve, reject) => {
    const python = process.env.DC_COMPUTER_PYTHON || 'python3';
    const child = spawn(python, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, result?: BridgeReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('GUI bridge timed out; the action status is unknown. Screenshot before retrying.'));
    }, payload.action === 'screenshot' ? 20_000 : 14_000);

    child.on('error', error => finish(new Error('Unable to start GUI Python bridge: ' + error.message)));
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('GUI screenshot exceeded bridge output limit'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-1200);
    });
    child.on('close', code => {
      if (settled) return;
      try {
        const data = JSON.parse(stdout) as BridgeReply;
        if (!data || typeof data.ok !== 'boolean') throw new Error('Malformed bridge response');
        if (!data.ok) return finish(new Error(data.error || 'GUI bridge error'));
        if (code !== 0) return finish(new Error('GUI bridge exited with ' + code));
        finish(undefined, data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish(new Error('Invalid GUI bridge response: ' + message + (stderr ? ' (' + stderr.slice(-250) + ')' : '')));
      }
    });
    child.stdin.on('error', () => { /* process closed before it could read stdin */ });
    child.stdin.end(JSON.stringify(payload));
  });
}

export interface ScreenshotFrame {
  id: string;
  capturedAt: number;
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
}

export function imagePointToDesktop(frame: ScreenshotFrame, x: number, y: number): { x: number; y: number } {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    throw new Error('Coordinate lies outside latest screenshot (' + frame.width + 'x' + frame.height + ')');
  }
  return {
    x: Math.min(frame.logicalWidth - 1, Math.round(x * frame.logicalWidth / frame.width)),
    y: Math.min(frame.logicalHeight - 1, Math.round(y * frame.logicalHeight / frame.height)),
  };
}

function positiveInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

export class ComputerController {
  private lastFrame: ScreenshotFrame | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly bridge: BridgeRunner = runPythonBridge, private readonly now: () => number = Date.now) {}

  /** Serializing even reads prevents a screenshot from racing a click. */
  run(name: ComputerToolName, args: unknown): Promise<ServerResult> {
    const task = this.queue.then(() => this.execute(name, args));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private recentFrame(id: string): ScreenshotFrame {
    const frame = this.lastFrame;
    if (!frame || frame.id !== id || this.now() - frame.capturedAt > SCREENSHOT_TTL_MS) {
      throw new Error('Screenshot missing, stale or already used. Call computer_screenshot again before acting.');
    }
    return frame;
  }

  private async screenshot(options: { max_width: number; max_height: number; quality: number }): Promise<ServerResult> {
    this.lastFrame = null;
    const r = await this.bridge({ action: 'screenshot' });
    if (!r.ok || !r.image_base64 || !positiveInteger(r.logical_width) || !positiveInteger(r.logical_height)) {
      throw new Error(r.error || 'Screenshot bridge did not return an image and logical screen dimensions');
    }
    const input = Buffer.from(r.image_base64, 'base64');
    if (!input.length || input.length > MAX_OUTPUT_BYTES) throw new Error('Invalid screenshot image size');
    let image = await sharp(input)
      .resize({ width: options.max_width, height: options.max_height, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: options.quality }).toBuffer();
    if (image.byteLength > MAX_IMAGE_BYTES) {
      image = await sharp(image).resize({ width: 960, height: 720, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 50 }).toBuffer();
    }
    if (image.byteLength > MAX_IMAGE_BYTES) throw new Error('Screenshot is too large; reduce max_width and max_height');
    const meta = await sharp(image).metadata();
    if (!positiveInteger(meta.width) || !positiveInteger(meta.height)) throw new Error('Invalid resized screenshot dimensions');
    const frame: ScreenshotFrame = {
      id: randomUUID(), capturedAt: this.now(),
      width: meta.width, height: meta.height,
      logicalWidth: r.logical_width, logicalHeight: r.logical_height,
    };
    this.lastFrame = frame;
    return {
      content: [
        { type: 'text', text: `screenshot_id: ${frame.id}\nScreenshot dimensions: ${frame.width}x${frame.height} pixels.\nUse positions ON THIS IMAGE in computer_click/scroll/drag, not native OS pixels. The ID expires in 120 seconds or after an action. Primary display only. OS size: ${frame.logicalWidth}x${frame.logicalHeight}.` },
        { type: 'image', mimeType: 'image/jpeg', data: image.toString('base64') },
      ],
      structuredContent: {
        screenshot_id: frame.id, width: frame.width, height: frame.height,
        logical_width: frame.logicalWidth, logical_height: frame.logicalHeight,
        expires_in_ms: SCREENSHOT_TTL_MS, primary_display_only: true,
      },
    };
  }

  private async execute(name: ComputerToolName, args: unknown): Promise<ServerResult> {
    if (process.env.DC_COMPUTER_USE !== '1') {
      return { content: [{ type: 'text', text: 'Computer Use is disabled. Set DC_COMPUTER_USE=1 and restart MCP.' }], isError: true };
    }
    try {
      const data = computerToolArgSchemas[name].parse(args) as Record<string, any>;
      if (name === 'computer_screenshot') return await this.screenshot(data as { max_width: number; max_height: number; quality: number });
      if (name === 'computer_screen_info' || name === 'computer_list_windows') {
        const r = await this.bridge({ action: name === 'computer_screen_info' ? 'screen_info' : 'list_windows' });
        if (!r.ok) throw new Error(r.error || 'GUI bridge failed');
        const detail = name === 'computer_list_windows'
          ? { windows: r.windows || [] }
          : { platform: r.platform, width: r.logical_width, height: r.logical_height, primary_display_only: true };
        return { content: [{ type: 'text', text: JSON.stringify(detail) }], structuredContent: detail };
      }

      if (process.env.DC_COMPUTER_INPUT !== '1') {
        throw new Error('Desktop input is disabled. Set DC_COMPUTER_INPUT=1 explicitly and restart MCP.');
      }
      const frame = this.recentFrame(data.screenshot_id);
      const payload: Record<string, unknown> = {};
      if (name === 'computer_click') {
        Object.assign(payload, { action: 'click', ...imagePointToDesktop(frame, data.x, data.y),
          button: data.button, clicks: data.clicks });
      } else if (name === 'computer_type') {
        Object.assign(payload, { action: 'type', text: data.text });
      } else if (name === 'computer_key') {
        Object.assign(payload, { action: 'key', keys: data.keys });
      } else if (name === 'computer_scroll') {
        if ((data.x === undefined) !== (data.y === undefined)) throw new Error('Provide both x and y, or neither');
        const point = imagePointToDesktop(frame,
          data.x === undefined ? Math.floor(frame.width / 2) : data.x,
          data.y === undefined ? Math.floor(frame.height / 2) : data.y);
        Object.assign(payload, { action: 'scroll', ...point, clicks: data.clicks });
      } else if (name === 'computer_drag') {
        const a = imagePointToDesktop(frame, data.from_x, data.from_y);
        const b = imagePointToDesktop(frame, data.to_x, data.to_y);
        Object.assign(payload, { action: 'drag', from_x: a.x, from_y: a.y, to_x: b.x, to_y: b.y,
          duration_ms: data.duration_ms });
      } else {
        throw new Error('Unsupported Computer Use action');
      }

      // Invalidate before executing. If the bridge fails/timeouts, an action
      // might already have happened; re-observation is mandatory before retry.
      this.lastFrame = null;
      const r = await this.bridge(payload);
      if (!r.ok) throw new Error(r.error || 'Desktop action failed');
      if (data.return_screenshot) {
        try {
          const result = await this.screenshot({ max_width: 1280, max_height: 1000, quality: 72 });
          result.content.unshift({ type: 'text', text: name + ' executed. A fresh screenshot follows.' });
          return result;
        } catch (e) {
          throw new Error(name + ' executed, but follow-up screenshot failed; inspect UI before repeating. ' + (e instanceof Error ? e.message : String(e)));
        }
      }
      return {
        content: [{ type: 'text', text: name + ' executed. Screenshot invalidated; call computer_screenshot before the next action.' }],
        structuredContent: { executed: true, screenshot_required: true },
      };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Computer Use error: ' + (e instanceof Error ? e.message : String(e)) }], isError: true };
    }
  }
}

export const computerController = new ComputerController();
export function handleComputerTool(name: ComputerToolName, args: unknown): Promise<ServerResult> {
  return computerController.run(name, args);
}

/**
 * Opt-in REAL desktop smoke test. Runs only when explicitly invoked by user.
 * Creates its own temporary Tk window, observes it through the actual MCP
 * protocol, clicks only its button and types only in its test entry.
 * No private documents, browser windows, or screenshots are saved.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.DC_COMPUTER_PYTHON || 'python3';
const temp = await mkdtemp(join(tmpdir(), 'dc-gui-live-test-'));
const statePath = join(temp, 'state.json');
const fixture = spawn(python, [join(projectRoot, 'test/manual-computer-fixture.py')], {
  cwd: projectRoot,
  env: { ...process.env, DC_GUI_FIXTURE_STATE: statePath },
  stdio: 'ignore',
});
let client;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const readState = async () => JSON.parse(await readFile(statePath, 'utf8'));

async function awaitFixture() {
  for (let n = 0; n < 120; n++) {
    if (fixture.exitCode !== null) throw new Error('Test GUI fixture exited prematurely');
    try {
      const state = await readState();
      if (state.ready && state.pid === fixture.pid) return state;
    } catch { /* not yet written */ }
    await sleep(150);
  }
  throw new Error('Temporary GUI test window did not become ready. Check tkinter, GUI session and permissions.');
}

function screenshotPoint(frame, x, y) {
  if (x < 0 || y < 0 || x >= frame.logical_width || y >= frame.logical_height) {
    throw new Error(
      'The acceptance window is outside the primary screen. Move/close other windows or extend Computer Use to another monitor; the test refused to click.'
    );
  }
  return {
    x: Math.floor(x * frame.width / frame.logical_width),
    y: Math.floor(y * frame.height / frame.logical_height),
  };
}

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(name + ' failed: ' +
      (result.content || []).filter(x => x.type === 'text').map(x => x.text).join(' ').slice(0, 400));
  }
  return result;
}

async function run() {
  const initial = await awaitFixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js', '--no-onboarding'],
    cwd: projectRoot,
    env: {
      ...process.env,
      DC_COMPUTER_USE: '1',
      DC_COMPUTER_INPUT: '1',
      DC_COMPUTER_PYTHON: python,
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'dc-computer-live-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const shot = await callTool('computer_screenshot', { max_width: 1000, max_height: 800 });
  const frame = shot.structuredContent;
  if (!frame?.screenshot_id || !shot.content?.some(x => x.type === 'image')) {
    throw new Error('MCP screenshot did not include an image and screenshot ID');
  }
  console.log('PASS real MCP screenshot', frame.width + 'x' + frame.height);

  const afterClick = await callTool('computer_click', {
    screenshot_id: frame.screenshot_id,
    ...screenshotPoint(frame, initial.button_x, initial.button_y),
    return_screenshot: true,
  });
  const updated = await readState();
  if (updated.clicked !== initial.clicked + 1) {
    throw new Error('GUI button click was not recorded by the real desktop');
  }
  console.log('PASS real GUI mouse click');

  const next = afterClick.structuredContent;
  if (!next?.screenshot_id) throw new Error('No refreshed screenshot ID after clicking');
  await callTool('computer_type', {
    screenshot_id: next.screenshot_id,
    ...screenshotPoint(next, updated.input_x, updated.input_y),
    text: 'DC-TYPE-AT-OK',
    return_screenshot: false,
  });
  await sleep(350);
  const final = await readState();
  if (final.typed !== 'DC-TYPE-AT-OK') {
    throw new Error('GUI text mismatch; expected DC-TYPE-AT-OK, found ' + JSON.stringify(final.typed));
  }
  console.log('PASS real GUI keyboard text input');
  console.log('REAL_COMPUTER_USE_GUI_PASS');
}

try {
  await run();
} catch (error) {
  console.error('REAL_COMPUTER_USE_GUI_FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  fixture.kill('SIGTERM');
  await rm(temp, { recursive: true, force: true });
}

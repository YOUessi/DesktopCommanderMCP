/**
 * Headless Computer Use tests: fake local driver, no screen access required.
 * Run with npm run test:computer (build first) or node --test test/test-computer-use.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ComputerController, imagePointToDesktop, SCREENSHOT_TTL_MS } from '../dist/tools/computer.js';

const jpeg = await sharp({
  create: { width: 2000, height: 1000, channels: 3, background: { r: 230, g: 235, b: 242 } }
}).jpeg({ quality: 70 }).toBuffer();

function makeFixture() {
  const calls = [];
  let time = 1000;
  const bridge = async payload => {
    calls.push(payload);
    if (payload.action === 'screenshot') {
      return {
        ok: true, platform: 'Darwin',
        logical_width: 1000, logical_height: 500,
        image_base64: jpeg.toString('base64')
      };
    }
    if (payload.action === 'screen_info') {
      return { ok: true, platform: 'Darwin', logical_width: 1000, logical_height: 500 };
    }
    if (payload.action === 'list_windows') return { ok: true, windows: ['Example :: App'] };
    return { ok: true, applied: true };
  };
  return {
    calls,
    clock: () => time,
    advance: ms => { time += ms; },
    controller: new ComputerController(bridge, () => time),
  };
}

test('disabled by default: no screenshot or input and no bridge calls', async () => {
  delete process.env.DC_COMPUTER_USE;
  delete process.env.DC_COMPUTER_INPUT;
  const f = makeFixture();
  const result = await f.controller.run('computer_screenshot', {});
  assert.equal(result.isError, true);
  assert.equal(f.calls.length, 0);
});

test('screenshot returns real MCP image content and scaled pixel coordinates', async () => {
  process.env.DC_COMPUTER_USE = '1';
  const f = makeFixture();
  const r = await f.controller.run('computer_screenshot', {});
  assert.equal(r.isError, undefined);
  assert.equal(r.content[1].type, 'image');
  assert.equal(r.content[1].mimeType, 'image/jpeg');
  assert.match(r.structuredContent.screenshot_id, /^[0-9a-f-]{36}$/);
  assert.equal(r.structuredContent.width, 1280);
  assert.equal(r.structuredContent.height, 640);
  assert.equal(r.structuredContent.logical_width, 1000);
  assert.equal(r.structuredContent.logical_height, 500);
  const decoded = await sharp(Buffer.from(r.content[1].data, 'base64')).metadata();
  assert.equal(decoded.width, 1280);
});

test('click maps screenshot pixels to desktop logical pixels and refreshes image', async () => {
  process.env.DC_COMPUTER_USE = '1';
  process.env.DC_COMPUTER_INPUT = '1';
  const f = makeFixture();
  const shot = await f.controller.run('computer_screenshot', {});
  const id = shot.structuredContent.screenshot_id;
  const clicked = await f.controller.run('computer_click', { screenshot_id: id, x: 640, y: 320 });
  assert.equal(clicked.isError, undefined);
  assert.deepEqual(f.calls[1], { action: 'click', x: 500, y: 250, button: 'left', clicks: 1 });
  assert.equal(f.calls[2].action, 'screenshot');
  assert.notEqual(clicked.structuredContent.screenshot_id, id);
  const stale = await f.controller.run('computer_click', { screenshot_id: id, x: 1, y: 1 });
  assert.equal(stale.isError, true);
  assert.equal(f.calls.length, 3);
});

test('no desktop input without separate opt-in', async () => {
  process.env.DC_COMPUTER_USE = '1';
  delete process.env.DC_COMPUTER_INPUT;
  const f = makeFixture();
  const shot = await f.controller.run('computer_screenshot', {});
  const r = await f.controller.run('computer_type', {
    screenshot_id: shot.structuredContent.screenshot_id, text: 'DO NOT TYPE'
  });
  assert.equal(r.isError, true);
  assert.equal(f.calls.length, 1);
});

test('expires screenshots and rejects out-of-bounds coordinates', async () => {
  process.env.DC_COMPUTER_USE = '1';
  process.env.DC_COMPUTER_INPUT = '1';
  const f = makeFixture();
  const shot = await f.controller.run('computer_screenshot', {});
  const id = shot.structuredContent.screenshot_id;
  const invalid = await f.controller.run('computer_click', { screenshot_id: id, x: 1280, y: 0 });
  assert.equal(invalid.isError, true);
  assert.equal(f.calls.length, 1);
  f.advance(SCREENSHOT_TTL_MS + 1);
  const expired = await f.controller.run('computer_key', { screenshot_id: id, keys: ['ctrl', 'a'] });
  assert.equal(expired.isError, true);
  assert.equal(f.calls.length, 1);
});

test('one screenshot ID cannot authorize concurrent actions', async () => {
  process.env.DC_COMPUTER_USE = '1';
  process.env.DC_COMPUTER_INPUT = '1';
  const f = makeFixture();
  const shot = await f.controller.run('computer_screenshot', {});
  const screenshot_id = shot.structuredContent.screenshot_id;
  const [a, b] = await Promise.all([
    f.controller.run('computer_key', { screenshot_id, keys: ['command', 'l'], return_screenshot: false }),
    f.controller.run('computer_key', { screenshot_id, keys: ['command', 'r'], return_screenshot: false })
  ]);
  assert.equal(a.isError, undefined);
  assert.equal(b.isError, true);
  assert.equal(f.calls.filter(c => c.action === 'key').length, 1);
});

test('scroll, drag and screen info use validated dimensions', async () => {
  process.env.DC_COMPUTER_USE = '1';
  process.env.DC_COMPUTER_INPUT = '1';
  const f = makeFixture();
  const info = await f.controller.run('computer_screen_info', {});
  assert.equal(info.structuredContent.width, 1000);
  const shot = await f.controller.run('computer_screenshot', {});
  const scroll = await f.controller.run('computer_scroll', {
    screenshot_id: shot.structuredContent.screenshot_id, clicks: -3, return_screenshot: true
  });
  assert.equal(scroll.isError, undefined);
  assert.deepEqual(f.calls[2], { action: 'scroll', x: 500, y: 250, clicks: -3 });
  const drag = await f.controller.run('computer_drag', {
    screenshot_id: scroll.structuredContent.screenshot_id,
    from_x: 50, from_y: 20, to_x: 100, to_y: 80,
    duration_ms: 200, return_screenshot: false
  });
  assert.equal(drag.isError, undefined);
  assert.deepEqual(f.calls[4], {
    action: 'drag', from_x: 39, from_y: 16, to_x: 78, to_y: 63, duration_ms: 200
  });
});

test('point mapping never leaves native desktop bounds', () => {
  const frame = { id: 'x', capturedAt: 0, width: 1280, height: 640,
    logicalWidth: 1000, logicalHeight: 500 };
  assert.deepEqual(imagePointToDesktop(frame, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(imagePointToDesktop(frame, 1279, 639), { x: 999, y: 499 });
  assert.throws(() => imagePointToDesktop(frame, -1, 0));
  assert.throws(() => imagePointToDesktop(frame, 10000, 0));
});

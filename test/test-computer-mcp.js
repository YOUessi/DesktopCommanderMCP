/**
 * MCP protocol integration test: starts the real compiled server and lists tools.
 * Requires no display or PyAutoGUI; validates env gating and tool schemas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guiTools = [
  'computer_screenshot', 'computer_screen_info', 'computer_list_windows',
  'computer_click', 'computer_type', 'computer_key', 'computer_scroll', 'computer_drag'
];

async function listTools(computerEnabled) {
  return await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.DC_COMPUTER_USE;
    delete env.DC_COMPUTER_INPUT;
    if (computerEnabled) env.DC_COMPUTER_USE = '1';
    const processMcp = spawn(process.execPath, ['dist/index.js', '--no-onboarding'], {
      cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => fail(new Error('Timed out waiting for MCP tools/list: ' + stderr.slice(-500))), 30_000);
    function done(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      processMcp.kill();
      if (error) reject(error);
      else resolve(result);
    }
    function fail(error) { done(error); }
    const request = (id, method, params) => {
      processMcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    };
    processMcp.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return fail(new Error(JSON.stringify(msg.error)));
          processMcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          request(2, 'tools/list', {});
        }
        if (msg.id === 2) {
          if (msg.error) return fail(new Error(JSON.stringify(msg.error)));
          return done(undefined, msg.result.tools);
        }
      }
    });
    processMcp.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
    processMcp.on('error', fail);
    processMcp.on('close', code => {
      if (!finished) fail(new Error('MCP process exited before tools/list; code ' + code + ': ' + stderr.slice(-500)));
    });
    request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dc-computer-test', version: '1.0.0' },
    });
  });
}

test('Computer Use tools hidden by default; existing DC tools preserved', async () => {
  const tools = await listTools(false);
  const names = new Set(tools.map(t => t.name));
  for (const name of guiTools) assert.equal(names.has(name), false);
  for (const name of ['read_file', 'edit_block', 'start_process']) {
    assert.equal(names.has(name), true);
  }
});

test('opt-in lists all Computer Use tools and correct MCP metadata', async () => {
  const tools = await listTools(true);
  const byName = new Map(tools.map(t => [t.name, t]));
  for (const name of guiTools) {
    assert.equal(byName.has(name), true, name + ' missing');
    assert.equal(byName.get(name).inputSchema.type, 'object');
  }
  assert.equal(byName.get('computer_screenshot').annotations.readOnlyHint, true);
  assert.equal(byName.get('computer_click').annotations.readOnlyHint, false);
  const clickFields = byName.get('computer_click').inputSchema.required;
  for (const key of ['screenshot_id', 'x', 'y']) assert.equal(clickFields.includes(key), true);
});

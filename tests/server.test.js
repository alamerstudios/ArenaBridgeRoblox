import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeServer } from '../src/server.js';
import { DEFAULTS } from '../src/core/config.js';

const baseConfig = {
  ...DEFAULTS,
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent',
  logFile: null,
  sessionFile: null,
  pollTimeoutMs: 500,
  commandTimeoutMs: 1500,
};

async function withBridge(fn, overrides = {}) {
  const bridge = new BridgeServer({ ...baseConfig, ...overrides });
  const info = await bridge.start();
  try {
    await fn(bridge, info);
  } finally {
    await bridge.stop();
  }
}

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test('start prints a fresh url and token, and they differ per start', async () => {
  const tokens = [];
  for (let i = 0; i < 3; i += 1) {
    await withBridge(async (_bridge, info) => {
      assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(info.token, /^nxs_/);
      tokens.push(info.token);
    });
  }
  assert.equal(new Set(tokens).size, 3, 'each start must produce a different token');
});

test('/health is public', async () => {
  await withBridge(async (_bridge, info) => {
    const res = await fetch(`${info.url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'running');
    assert.equal(body.authRequired, true);
    assert.equal(body.token, undefined);
  });
});

test('/status requires a token', async () => {
  await withBridge(async (_bridge, info) => {
    const missing = await fetch(`${info.url}/status`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, 'TOKEN_MISSING');

    const wrong = await fetch(`${info.url}/status`, { headers: auth('nxs_definitely_wrong') });
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json()).error.code, 'TOKEN_INVALID');

    const ok = await fetch(`${info.url}/status`, { headers: auth(info.token) });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.token, undefined, 'status must not leak the raw token');
  });
});

test('token is accepted from all documented locations', async () => {
  await withBridge(async (_bridge, info) => {
    const variants = [
      { headers: { Authorization: `Bearer ${info.token}` } },
      { headers: { 'X-Bridge-Token': info.token } },
      { headers: { 'X-Api-Key': info.token } },
    ];
    for (const variant of variants) {
      const res = await fetch(`${info.url}/ping`, variant);
      assert.equal(res.status, 200);
    }
    const query = await fetch(`${info.url}/ping?token=${encodeURIComponent(info.token)}`);
    assert.equal(query.status, 200);
  });
});

test('token rotation invalidates the previous token', async () => {
  await withBridge(async (_bridge, info) => {
    const rotate = await fetch(`${info.url}/token/rotate`, { method: 'POST', headers: auth(info.token) });
    assert.equal(rotate.status, 200);
    const { token: newToken } = await rotate.json();
    assert.notEqual(newToken, info.token);

    const old = await fetch(`${info.url}/status`, { headers: auth(info.token) });
    assert.equal(old.status, 403);

    const fresh = await fetch(`${info.url}/status`, { headers: auth(newToken) });
    assert.equal(fresh.status, 200);
  });
});

test('/command validates input and times out without Studio', async () => {
  await withBridge(async (_bridge, info) => {
    const missing = await fetch(`${info.url}/command`, { method: 'POST', headers: auth(info.token), body: '{}' });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, 'MISSING_ACTION');

    const unknown = await fetch(`${info.url}/command`, {
      method: 'POST', headers: auth(info.token), body: JSON.stringify({ action: 'nope' }),
    });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.code, 'UNKNOWN_ACTION');

    const timedOut = await fetch(`${info.url}/command`, {
      method: 'POST', headers: auth(info.token), body: JSON.stringify({ action: 'ping', timeoutMs: 1000 }),
    });
    assert.equal(timedOut.status, 504);
    const body = await timedOut.json();
    assert.equal(body.command.state, 'timeout');
  });
});

test('a simulated Studio client completes a command end to end', async () => {
  await withBridge(async (_bridge, info) => {
    const handshake = await fetch(`${info.url}/studio/handshake`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ clientId: 'test-studio', name: 'Mock Studio', version: '1.0.0', place: '123' }),
    });
    assert.equal(handshake.status, 200);

    // Poller acts like the plugin.
    const pollAndAnswer = (async () => {
      const poll = await fetch(`${info.url}/studio/poll`, { headers: { ...auth(info.token), 'X-Client-Id': 'test-studio' } });
      const { command } = await poll.json();
      assert.ok(command, 'poller should receive the queued command');
      assert.equal(command.action, 'get_place_info');
      await fetch(`${info.url}/studio/result`, {
        method: 'POST', headers: auth(info.token),
        body: JSON.stringify({ id: command.id, ok: true, result: { placeId: 42, name: 'TestPlace' } }),
      });
    })();

    const commandPromise = fetch(`${info.url}/command`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ action: 'get_place_info' }),
    });

    const [res] = await Promise.all([commandPromise, pollAndAnswer]);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.command.result, { placeId: 42, name: 'TestPlace' });

    const status = await (await fetch(`${info.url}/status`, { headers: auth(info.token) })).json();
    assert.equal(status.stats.commandsCompleted, 1);
    assert.ok(status.clients.some((c) => c.id === 'test-studio'));
  });
});

test('studio poll returns idle after the poll timeout', async () => {
  await withBridge(async (_bridge, info) => {
    const started = Date.now();
    const res = await fetch(`${info.url}/studio/poll`, { headers: auth(info.token) });
    const body = await res.json();
    assert.equal(body.command, null);
    assert.equal(body.idle, true);
    assert.ok(Date.now() - started >= 400);
  });
});

test('MCP endpoint speaks JSON-RPC 2.0', async () => {
  await withBridge(async (_bridge, info) => {
    const init = await fetch(`${info.url}/mcp`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const initBody = await init.json();
    assert.equal(initBody.jsonrpc, '2.0');
    assert.equal(initBody.result.serverInfo.name, 'nexusai-bridge');

    const tools = await (await fetch(`${info.url}/mcp`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })).json();
    assert.ok(Array.isArray(tools.result.tools));
    assert.ok(tools.result.tools.some((t) => t.name === 'run_luau'));

    const bad = await (await fetch(`${info.url}/mcp`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' }),
    })).json();
    assert.equal(bad.error.code, -32601);

    const unauthorized = await fetch(`${info.url}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    });
    assert.equal(unauthorized.status, 401);
  });
});

test('/logs returns entries and never contains the raw token', async () => {
  await withBridge(async (_bridge, info) => {
    await fetch(`${info.url}/status`, { headers: auth(info.token) });
    const res = await fetch(`${info.url}/logs?limit=50&level=debug`, { headers: auth(info.token) });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.entries));
    assert.equal(JSON.stringify(body.entries).includes(info.token), false, 'logs must not leak the token');
  });
});

test('unknown routes return a 404 with the endpoint catalogue', async () => {
  await withBridge(async (_bridge, info) => {
    const res = await fetch(`${info.url}/nope`, { headers: auth(info.token) });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.ok(Array.isArray(body.error.details.endpoints));
  });
});

test('dashboard is served publicly but contains no token', async () => {
  await withBridge(async (_bridge, info) => {
    const res = await fetch(`${info.url}/dashboard`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('NexusAI'));
    assert.equal(html.includes(info.token), false);
  });
});

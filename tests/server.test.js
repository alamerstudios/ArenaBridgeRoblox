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
      assert.match(info.token, /^asc_/);
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

    const wrong = await fetch(`${info.url}/status`, { headers: auth('asc_definitely_wrong') });
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
    assert.equal(body.ok, false);
    assert.equal(body.command.state, 'timeout');
    assert.equal(body.error.code, 'COMMAND_TIMEOUT');
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
        method: 'POST', headers: { ...auth(info.token), 'X-Client-Id': 'test-studio' },
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
    assert.deepEqual(body.result, { placeId: 42, name: 'TestPlace' });
    assert.equal(body.error, null);

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
    assert.equal(initBody.result.serverInfo.name, 'arena-studio-connecter');

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
    assert.ok(html.includes('Arena Studio Connecter'));
    assert.equal(html.includes(info.token), false);
  });
});

test('/agent/guide is public, target-aware and contains no secret', async () => {
  await withBridge(async (_bridge, info) => {
    await fetch(`${info.url}/studio/handshake`, {
      method: 'POST',
      headers: auth(info.token),
      body: JSON.stringify({
        clientId: 'guide-studio',
        version: '2.0.0',
        placeId: 123,
        placeName: 'Guide Place',
        gameId: 456,
        accountName: 'Builder',
      }),
    });
    const res = await fetch(`${info.url}/agent/guide?clientId=guide-studio`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/markdown/);
    const guide = await res.text();
    assert.ok(guide.includes('Guide Place'));
    assert.ok(guide.includes('targetClientId'));
    assert.ok(guide.includes('guide-studio'));
    assert.equal(guide.includes(info.token), false);
  });
});

test('commands are routed only to the selected Studio Place', async () => {
  await withBridge(async (_bridge, info) => {
    for (const [clientId, placeName] of [['studio-a', 'Place A'], ['studio-b', 'Place B']]) {
      const response = await fetch(`${info.url}/studio/handshake`, {
        method: 'POST',
        headers: auth(info.token),
        body: JSON.stringify({ clientId, placeName, placeId: clientId === 'studio-a' ? 1 : 2, version: '2.0.0' }),
      });
      assert.equal(response.status, 200);
    }

    const ambiguous = await fetch(`${info.url}/command`, {
      method: 'POST',
      headers: auth(info.token),
      body: JSON.stringify({ action: 'ping' }),
    });
    assert.equal(ambiguous.status, 400);
    assert.equal((await ambiguous.json()).error.code, 'TARGET_REQUIRED');

    const pollA = fetch(`${info.url}/studio/poll`, {
      headers: { ...auth(info.token), 'X-Client-Id': 'studio-a' },
    }).then((response) => response.json());
    const pollB = fetch(`${info.url}/studio/poll`, {
      headers: { ...auth(info.token), 'X-Client-Id': 'studio-b' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 25));

    const commandResponse = fetch(`${info.url}/command`, {
      method: 'POST',
      headers: auth(info.token),
      body: JSON.stringify({ action: 'get_place_info', targetClientId: 'studio-b' }),
    });

    const resultB = await pollB;
    assert.equal(resultB.command.action, 'get_place_info');
    await fetch(`${info.url}/studio/result`, {
      method: 'POST',
      headers: { ...auth(info.token), 'X-Client-Id': 'studio-b' },
      body: JSON.stringify({ id: resultB.command.id, ok: true, result: { placeName: 'Place B' } }),
    });

    const completed = await commandResponse;
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).command.assignedClientId, 'studio-b');
    const resultA = await pollA;
    assert.equal(resultA.command, null, 'the other Studio client must not receive the targeted command');
  });
});

test('playtest stop is routed to the session plugin reporter and build commands stay in edit mode', async () => {
  await withBridge(async (bridge, info) => {
    for (const body of [
      { clientId: 'edit-place', dataModelRole: 'edit', playtestActive: true, playtestServerClientId: 'play-server', placeId: 123 },
      { clientId: 'play-server', dataModelRole: 'play-server', editClientId: 'edit-place', placeId: 123 },
    ]) {
      const response = await fetch(`${info.url}/studio/handshake`, {
        method: 'POST', headers: auth(info.token), body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
    }

    const status = await (await fetch(`${info.url}/status`, { headers: auth(info.token) })).json();
    assert.deepEqual(status.clients.map((client) => client.id), ['edit-place'], 'reporter is not a second Place');

    const rejected = await fetch(`${info.url}/command`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ action: 'create_instance', targetClientId: 'play-server', params: {} }),
    });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error.code, 'STUDIO_CLIENT_OFFLINE');

    const playPoll = fetch(`${info.url}/studio/poll`, {
      headers: { ...auth(info.token), 'X-Client-Id': 'play-server' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stopResponse = fetch(`${info.url}/command`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ action: 'stop_game', targetClientId: 'edit-place' }),
    });
    const playCommand = await playPoll;
    assert.equal(playCommand.command.action, 'stop_game');
    await fetch(`${info.url}/studio/result`, {
      method: 'POST', headers: { ...auth(info.token), 'X-Client-Id': 'play-server' },
      body: JSON.stringify({ id: playCommand.command.id, ok: true, result: { stopped: true } }),
    });
    const stopped = await stopResponse;
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).command.assignedClientId, 'play-server');

    bridge.session.removeClient('play-server');
    await fetch(`${info.url}/studio/handshake`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ clientId: 'edit-place', dataModelRole: 'edit', playtestActive: false, placeId: 123 }),
    });
    const editPoll = fetch(`${info.url}/studio/poll`, {
      headers: { ...auth(info.token), 'X-Client-Id': 'edit-place' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 25));
    const buildResponse = fetch(`${info.url}/command`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ action: 'get_place_info', targetClientId: 'edit-place' }),
    });
    const editCommand = await editPoll;
    assert.equal(editCommand.command.action, 'get_place_info');
    await fetch(`${info.url}/studio/result`, {
      method: 'POST', headers: { ...auth(info.token), 'X-Client-Id': 'edit-place' },
      body: JSON.stringify({ id: editCommand.command.id, ok: true, result: { name: 'Edit Place' } }),
    });
    assert.equal((await buildResponse).status, 200);
  });
});

test('desktop local actions work over REST and MCP without a Studio queue or exposing secrets', async () => {
  const localActions = {
    get_blender_status: async () => ({ available: true, version: 'Blender Test', hasApiKey: true }),
    create_blender_mesh: async () => { throw new Error('Blender executable is missing'); },
  };
  await withBridge(async (_bridge, info) => {
    const rest = await fetch(`${info.url}/command`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ action: 'get_blender_status', params: {} }),
    });
    assert.equal(rest.status, 200);
    assert.equal((await rest.json()).command.result.available, true);

    const tools = await fetch(`${info.url}/mcp`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const toolBody = await tools.json();
    assert.ok(toolBody.result.tools.some((tool) => tool.name === 'create_blender_mesh'));
    assert.ok(toolBody.result.tools.some((tool) => tool.name === 'play_game'));

    const mcp = await fetch(`${info.url}/mcp`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_blender_status', arguments: {} } }),
    });
    const mcpBody = await mcp.json();
    assert.equal(mcpBody.result.isError, false);
    assert.match(mcpBody.result.content[0].text, /Blender Test/);

    const failed = await fetch(`${info.url}/command`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ action: 'create_blender_mesh', params: {} }),
    });
    assert.equal(failed.status, 200, 'a completed local action failure is not a Bad Gateway');
    const failure = await failed.json();
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, 'LOCAL_ACTION_FAILED');
    assert.match(failure.error.message, /Blender executable is missing/);
    assert.equal(failure.error.details.action, 'create_blender_mesh');

    const mcpFailure = await fetch(`${info.url}/mcp`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_blender_mesh', arguments: {} } }),
    });
    const mcpFailureBody = await mcpFailure.json();
    assert.equal(mcpFailureBody.result.isError, true);
    assert.equal(mcpFailureBody.result.structuredContent.error.code, 'LOCAL_ACTION_FAILED');
  }, { localActions });
});

test('stop during playtest start waits for the session plugin reporter', async () => {
  await withBridge(async (bridge, info) => {
    const editorId = 'edit-starting-place';
    const reporterId = `${editorId}:play-server`;
    await fetch(`${info.url}/studio/handshake`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({
        clientId: editorId,
        dataModelRole: 'edit',
        playtestActive: true,
        playtestMode: 'play',
        isRunning: false,
        editModeActive: false,
      }),
    });

    const stopResponse = fetch(`${info.url}/command`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ action: 'stop_game', targetClientId: editorId }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(bridge.queue.pending.length, 1);
    assert.equal(bridge.queue.pending[0].targetClientId, reporterId);
    const pendingLookup = await (await fetch(`${info.url}/command/${bridge.queue.pending[0].id}`, { headers: auth(info.token) })).json();
    assert.equal(pendingLookup.ok, true, 'a queued stop is pending, not failed');
    assert.equal(pendingLookup.pending, true);
    assert.equal(pendingLookup.error, null);

    await fetch(`${info.url}/studio/handshake`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ clientId: reporterId, dataModelRole: 'play-server', editClientId: editorId, playtestActive: true }),
    });
    const poll = await (await fetch(`${info.url}/studio/poll`, {
      headers: { ...auth(info.token), 'X-Client-Id': reporterId },
    })).json();
    assert.equal(poll.command.action, 'stop_game');
    await fetch(`${info.url}/studio/result`, {
      method: 'POST', headers: { ...auth(info.token), 'X-Client-Id': reporterId },
      body: JSON.stringify({ id: poll.command.id, ok: true, result: { accepted: true, ending: true } }),
    });
    const stopped = await stopResponse;
    assert.equal(stopped.status, 200);
    const body = await stopped.json();
    assert.equal(body.ok, true);
    assert.equal(body.command.assignedClientId, reporterId);
    assert.equal(body.command.result.ending, true);
    assert.equal(bridge.session.clients.has(reporterId), false, 'a successful EndTest retires only the reporter');
    assert.equal(bridge.session.clients.has(editorId), true, 'the editor Place remains connected');
  });
});

test('Studio action failures return structured details instead of a blanket 502', async () => {
  await withBridge(async (_bridge, info) => {
    await fetch(`${info.url}/studio/handshake`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ clientId: 'studio-errors', dataModelRole: 'edit', playtestActive: false }),
    });
    const pollPromise = fetch(`${info.url}/studio/poll`, {
      headers: { ...auth(info.token), 'X-Client-Id': 'studio-errors' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 25));
    const commandResponse = fetch(`${info.url}/command`, {
      method: 'POST', headers: auth(info.token),
      body: JSON.stringify({ action: 'run_luau', targetClientId: 'studio-errors', params: { code: 'error("details")' } }),
    });
    const poll = await pollPromise;
    await fetch(`${info.url}/studio/result`, {
      method: 'POST', headers: { ...auth(info.token), 'X-Client-Id': 'studio-errors' },
      body: JSON.stringify({
        id: poll.command.id,
        ok: false,
        error: 'Luau runtime failed: detailed traceback',
        action: 'run_luau',
        pluginVersion: '2.1.1',
      }),
    });
    const response = await commandResponse;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.command.state, 'failed');
    assert.equal(body.error.code, 'STUDIO_ACTION_FAILED');
    assert.match(body.error.message, /detailed traceback/);
    assert.equal(body.error.details.commandId, poll.command.id);
    assert.equal(body.error.details.pluginVersion, '2.1.1');
    assert.equal(body.error.details.assignedClientId, 'studio-errors');

    const lookup = await (await fetch(`${info.url}/command/${poll.command.id}`, { headers: auth(info.token) })).json();
    assert.equal(lookup.ok, false);
    assert.equal(lookup.error.code, 'STUDIO_ACTION_FAILED');
    assert.match(lookup.error.message, /detailed traceback/);
  });
});

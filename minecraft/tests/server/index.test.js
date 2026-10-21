import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import feature from '../../server/index.js';
import {
  attachFeatureUpgrades,
  buildShutdownPhases,
  mountFeatureRoutes,
} from '../../../../server/core/features.js';
import { GAME_CLIENT_PERMISSIONS_POLICY, MC_CLIENT_CSP } from '../../../../server/http/csp.js';

test('Minecraft mounts its real client with dedicated security and cache headers', async (context) => {
  const app = express();
  mountFeatureRoutes([feature], app);
  const server = createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  context.after(() => new Promise((done) => server.close(done)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const path of ['/mc/', '/mc/eaglercraft.html']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-security-policy'), MC_CLIENT_CSP);
    assert.equal(response.headers.get('permissions-policy'), GAME_CLIENT_PERMISSIONS_POLICY);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.match(await response.text(), /<!doctype html>/i);
  }
  assert.equal((await fetch(origin + '/mc/missing.html')).status, 404);
  assert.equal((await fetch(origin + '/')).status, 404);
});

test('Minecraft owns one upgrade listener and drains through the feature shutdown phase', async () => {
  const server = createServer();
  assert.equal(feature.status().attached, false);
  attachFeatureUpgrades([feature], server, { accepting: () => false });
  assert.equal(server.listenerCount('upgrade'), 1);
  assert.equal(feature.status().attached, true);
  assert.throws(() => attachFeatureUpgrades([feature], server), /already attached/);
  const phases = buildShutdownPhases([feature], [{ name: 'transports', tasks: {} }]);
  const stopping = phases[0].tasks.minecraft();
  assert.equal(feature.stop(), stopping);
  await stopping;
  assert.equal(server.listenerCount('upgrade'), 0);
});

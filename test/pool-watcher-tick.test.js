const test = require('node:test');
const assert = require('node:assert/strict');
const { runTick, loadWatcherConfig } = require('../lib/pool-watcher');

const cfg = loadWatcherConfig({});          // defaults: target 15, maxPerRun 5, maxFails 2
let clock = 0;
const baseDeps = () => ({
  now: () => (clock += 1000),
  log: () => {},
  nextProxy: () => 'socks5://p@h',
});

test('runTick idles when pool at/above target', async () => {
  const deps = { ...baseDeps(), readPool: async () => 20, register: async () => true };
  const r = await runTick({ config: cfg, snapshots: [], deps });
  assert.equal(r.action, 'idle');
  assert.equal(r.registered, 0);
  assert.equal(r.sleepS, cfg.idleIntervalS);
});

test('runTick registers up to need and stops when re-check catches up', async () => {
  let pool = 13;                    // need 2 to reach 15
  let calls = 0;
  const deps = {
    ...baseDeps(),
    readPool: async () => pool,
    register: async () => { calls += 1; pool += 1; return true; }, // each reg raises pool
  };
  const r = await runTick({ config: cfg, snapshots: [], deps });
  assert.equal(r.action, 'register');
  assert.equal(calls, 2);          // 13 -> 15
  assert.equal(r.registered, 2);
});

test('runTick backs off after maxFails consecutive failures', async () => {
  const deps = { ...baseDeps(), readPool: async () => 2, register: async () => false };
  const r = await runTick({ config: cfg, snapshots: [], deps });
  assert.equal(r.fails, cfg.maxFails);
  assert.equal(r.sleepS, cfg.failBackoffS);
  assert.ok(r.registered === 0);
});

test('runTick returns action=error and keeps snapshots on read failure', async () => {
  const deps = { ...baseDeps(), readPool: async () => { throw new Error('net'); }, register: async () => true };
  const snaps = [{ usable: 10, t: 0 }];
  const r = await runTick({ config: cfg, snapshots: snaps, deps });
  assert.equal(r.action, 'error');
  assert.deepEqual(r.snapshots, snaps);
  assert.equal(r.sleepS, cfg.activeIntervalS);
});

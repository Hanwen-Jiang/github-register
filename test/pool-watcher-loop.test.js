const test = require('node:test');
const assert = require('node:assert/strict');
const { runForever, loadWatcherConfig } = require('../lib/pool-watcher');

test('runForever threads snapshots across ticks and sleeps between', async () => {
  const cfg = loadWatcherConfig({ POOL_IDLE_INTERVAL_S: '7' });
  const sleeps = [];
  let ticks = 0;
  const pools = [20, 20, 20];
  const deps = {
    readPool: async () => pools[ticks] ?? 20,
    register: async () => true,
    nextProxy: () => null,
    now: () => ticks * 1000,
    log: () => {},
  };
  await runForever({
    config: cfg,
    deps,
    sleep: async (s) => { sleeps.push(s); },
    shouldContinue: () => (ticks++ < 3),
  });
  assert.equal(sleeps.length, 3);
  assert.deepEqual(sleeps, [7, 7, 7]);   // idle sleeps
});

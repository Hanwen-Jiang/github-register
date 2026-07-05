const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBatchConfig,
  buildChildEnv,
  runBatch,
} = require('../batch-register-upload');

test('buildBatchConfig generates jhw001-jhw100 proxy pool by default', () => {
  const config = buildBatchConfig({
    BATCH_TOTAL: '3',
    BATCH_CONCURRENCY: '2',
  });

  assert.equal(config.total, 3);
  assert.equal(config.concurrency, 2);
  assert.equal(config.proxies.length, 100);
  assert.equal(config.proxies[0], 'socks5://jhw001-zone-custom:asdf1476@as.rrp.bestgo.work:10000');
  assert.equal(config.proxies[99], 'socks5://jhw100-zone-custom:asdf1476@as.rrp.bestgo.work:10000');
});

test('runBatch assigns a distinct proxy to each concurrent job', async () => {
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const result = await runBatch({
    total: 4,
    concurrency: 4,
    proxies: ['p1', 'p2', 'p3', 'p4'],
    log: () => {},
    runOne: async ({ proxy, slot, index }) => {
      started.push({ proxy, slot, index });
      if (started.length === 4) release();
      await gate;
      return { ok: true };
    },
  });

  assert.equal(result.ok, 4);
  assert.deepEqual(started.map(x => x.proxy).sort(), ['p1', 'p2', 'p3', 'p4']);
});

test('buildChildEnv gives every job an isolated result file and shared merged result file', () => {
  const env = buildChildEnv({
    proxy: 'p1',
    slot: 2,
    index: 9,
    resultDir: '/tmp/batch-results',
    env: { API_NSNZD_COM_ADMIN_KEY: 'admin-test' },
  });

  assert.equal(env.PROXY, 'p1');
  assert.equal(env.RESULT_LOCAL_FILE, '/tmp/batch-results/runs/slot02-job0009.jsonl');
  assert.equal(env.BATCH_SHARED_RESULT_FILE, '/tmp/batch-results/results.jsonl');
  assert.equal(env.UPLOAD_LEDGER_FILE, '/tmp/batch-results/uploaded.jsonl');
  assert.equal(env.CHROME_PROFILE_DIR, '/tmp/batch-results/chrome/slot02-job0009');
});

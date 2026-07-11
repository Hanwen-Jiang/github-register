const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBatchConfig,
  pickDelayMs,
  prepareBatchUploadGroupEnv,
  runBatch,
} = require('../oauth-site-batch');

test('buildBatchConfig defaults to 30-60 second gaps', () => {
  const cfg = buildBatchConfig({ OAUTH_SITE_BATCH_TOTAL: '3' });

  assert.equal(cfg.total, 3);
  assert.equal(cfg.delayMinMs, 30000);
  assert.equal(cfg.delayMaxMs, 60000);
});

test('pickDelayMs returns an inclusive random delay in range', () => {
  assert.equal(pickDelayMs(30000, 60000, () => 0), 30000);
  assert.equal(pickDelayMs(30000, 60000, () => 0.999999), 60000);
});

test('runBatch runs sequentially and sleeps between runs only', async () => {
  const calls = [];
  const res = await runBatch({
    total: 3,
    delayMinMs: 30000,
    delayMaxMs: 60000,
    random: () => 0,
    log: false,
    runOne: async () => {
      calls.push('run');
      return { success: true, results: [{ apiKey: 'sk' }] };
    },
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`);
    },
  });

  assert.deepEqual(calls, ['run', 'sleep:30000', 'run', 'sleep:30000', 'run']);
  assert.deepEqual(res, { total: 3, ok: 3, failed: 0, attempted: 3 });
});

test('runBatch treats total as target successes, not attempts', async () => {
  const outcomes = [false, true, false, true, true];
  let runs = 0;
  const sleeps = [];
  const res = await runBatch({
    total: 3,
    delayMinMs: 30000,
    delayMaxMs: 30000,
    failLimit: 10,
    log: false,
    runOne: async () => ({ success: outcomes[runs++] }),
    sleep: async (ms) => sleeps.push(ms),
  });

  assert.equal(runs, 5);
  assert.deepEqual(sleeps, [30000, 30000, 30000, 30000]);
  assert.deepEqual(res, { total: 3, ok: 3, failed: 2, attempted: 5 });
});

test('buildBatchConfig treats small delay numbers as seconds for CLI convenience', () => {
  const cfg = buildBatchConfig({
    OAUTH_SITE_BATCH_TOTAL: '20',
    OAUTH_SITE_BATCH_DELAY_MIN_MS: '30',
    OAUTH_SITE_BATCH_DELAY_MAX_MS: '120',
  });

  assert.equal(cfg.total, 20);
  assert.equal(cfg.delayMinMs, 30000);
  assert.equal(cfg.delayMaxMs, 120000);
});

test('runBatch stops after consecutive failures reach fail limit', async () => {
  let runs = 0;
  const sleeps = [];
  const logs = [];
  const res = await runBatch({
    total: 20,
    delayMinMs: 30000,
    delayMaxMs: 30000,
    failLimit: 3,
    log: (line) => logs.push(line),
    runOne: async () => {
      runs += 1;
      return { success: false, results: [] };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(runs, 3);
  assert.deepEqual(sleeps, [30000, 30000]);
  assert.deepEqual(res, { total: 20, ok: 0, failed: 3, attempted: 3, stopped: true });
  assert.ok(logs.some(line => line.includes('stop after 3 consecutive failures')));
});

test('runBatch resets consecutive failure count after a success', async () => {
  const outcomes = [false, false, true, false, false, false];
  let runs = 0;
  const res = await runBatch({
    total: 2,
    delayMinMs: 0,
    delayMaxMs: 0,
    failLimit: 3,
    log: false,
    runOne: async () => ({ success: outcomes[runs++] }),
    sleep: async () => {},
  });

  assert.equal(runs, 6);
  assert.deepEqual(res, { total: 2, ok: 1, failed: 5, attempted: 6, stopped: true });
});

test('prepareBatchUploadGroupEnv selects Sub2API group once before oauth batch starts', async () => {
  const env = {
    API_NSNZD_COM_ADMIN_KEY: 'admin-test',
    OAUTH_SITE_IMPORT_API_NSNZD: 'true',
  };
  const order = [];

  const selected = await prepareBatchUploadGroupEnv(env, {
    resolveUploadGroupFn: async ({ adminKey }) => {
      order.push(`group:${adminKey}`);
      return { id: 9, name: 'Claude 渠道' };
    },
  });

  assert.deepEqual(order, ['group:admin-test']);
  assert.deepEqual(selected, { id: 9, name: 'Claude 渠道' });
  assert.equal(env.UPLOAD_GROUP_ID, '9');
  assert.equal(env.UPLOAD_GROUP_NAME, 'Claude 渠道');
  assert.equal(env.UPLOAD_GROUP_PROMPT, 'false');
});

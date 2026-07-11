const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBatchConfig,
  parseBatchArgs,
  pickDelayMs,
  prepareBatchGroupConfig,
  prepareBatchUploadGroupEnv,
  runBatch,
  main,
} = require('../oauth-site-batch');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeGroupConfig } = require('../lib/site-groups');

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

test('parseBatchArgs supports persisted group config selection and reuse', () => {
  assert.deepEqual(parseBatchArgs([]), { reuseGroupConfig: false, groupConfigFile: '' });
  assert.deepEqual(parseBatchArgs(['--reuse-group-config']), { reuseGroupConfig: true, groupConfigFile: '' });
  assert.deepEqual(parseBatchArgs(['--group-config', '/tmp/groups.json', '--reuse-group-config']), {
    reuseGroupConfig: true,
    groupConfigFile: '/tmp/groups.json',
  });
});

test('prepareBatchGroupConfig selects upload group first then probes and prompts every site', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-batch-groups-'));
  const file = path.join(rootDir, 'data', 'chosen.json');
  const env = { API_NSNZD_COM_ADMIN_KEY: 'admin-test', OAUTH_SITE_IMPORT_API_NSNZD: 'true' };
  const targetSites = [
    { name: 'a6api', baseUrl: 'https://a6api.com', tokenGroup: 'default' },
    { name: 'cun.ai', baseUrl: 'https://www.cun.ai', tokenGroup: 'default' },
  ];
  const order = [];

  const prepared = await prepareBatchGroupConfig(env, { reuseGroupConfig: false, groupConfigFile: file }, {
    rootDir,
    targetSites,
    resolveUploadGroupFn: async () => { order.push('upload'); return { id: 9, name: 'Claude 渠道' }; },
    findSessionFn: async site => ({ email: `${site.name}@example.com`, storage_state: { cookies: [{ name: 'user_session' }] } }),
    getSessionCookiesFn: session => session.storage_state.cookies,
    probeSiteGroupsFn: async site => {
      order.push(`probe:${site.name}`);
      return { options: [{ value: 'default', label: `${site.name} default`, source: 'live' }] };
    },
    promptSiteGroupSelectionFn: async (site, options) => {
      order.push(`prompt:${site.name}`);
      return options;
    },
  });

  assert.deepEqual(order, ['upload', 'probe:a6api', 'prompt:a6api', 'probe:cun.ai', 'prompt:cun.ai']);
  assert.equal(prepared.reused, false);
  assert.equal(prepared.file, file);
  assert.deepEqual(prepared.config.uploadGroup, { id: 9, name: 'Claude 渠道' });
  assert.deepEqual(Object.keys(prepared.config.sites), ['a6api', 'cun.ai']);
  assert.equal(fs.existsSync(file), true);
  assert.equal(env.OAUTH_SITE_GROUP_CONFIG_FILE, file);
  assert.equal(env.UPLOAD_GROUP_ID, '9');
});

test('prepareBatchGroupConfig reuses a valid file without resolving or prompting groups', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-batch-reuse-'));
  const file = path.join(rootDir, 'groups.json');
  const config = {
    version: 1,
    savedAt: '2026-07-11T00:00:00.000Z',
    uploadGroup: { id: 3, name: 'Reuse' },
    sites: { a6api: { source: 'live', selected: [{ value: 'default', label: 'Default', source: 'live' }] } },
  };
  writeGroupConfig(file, config);
  const env = {};
  const forbidden = async () => { throw new Error('must not run during reuse'); };

  const prepared = await prepareBatchGroupConfig(env, { reuseGroupConfig: true, groupConfigFile: file }, {
    rootDir,
    targetSites: [{ name: 'a6api' }],
    resolveUploadGroupFn: forbidden,
    probeSiteGroupsFn: forbidden,
    promptSiteGroupSelectionFn: forbidden,
  });

  assert.equal(prepared.reused, true);
  assert.deepEqual(prepared.config, config);
  assert.equal(env.UPLOAD_GROUP_ID, '3');
  assert.equal(env.UPLOAD_GROUP_NAME, 'Reuse');
  assert.equal(env.OAUTH_SITE_GROUP_CONFIG_FILE, file);
});

test('main persists group choices before starting the success-counted batch', async () => {
  const order = [];
  const env = { OAUTH_SITE_BATCH_TOTAL: '1' };
  const result = await main({
    env,
    argv: ['--reuse-group-config'],
    prepareBatchGroupConfigFn: async (_env, args) => {
      order.push(`prepare:${args.reuseGroupConfig}`);
      return { config: { uploadGroup: { id: 1, name: 'default' } }, file: '/tmp/groups.json', reused: true };
    },
    runBatchFn: async config => {
      order.push(`run:${config.total}`);
      return { total: config.total, ok: config.total, failed: 0, attempted: config.total };
    },
    log: false,
  });

  assert.deepEqual(order, ['prepare:true', 'run:1']);
  assert.deepEqual(result, { total: 1, ok: 1, failed: 0, attempted: 1 });
});

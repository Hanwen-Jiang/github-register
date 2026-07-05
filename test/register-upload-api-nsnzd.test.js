const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureProxyConfigured,
  maskProxy,
  pickResidentialProxyIds,
  runRegisterCliAndLoadLatest,
} = require('../register-upload-api-nsnzd');

test('maskProxy hides proxy passwords in logs', () => {
  assert.equal(
    maskProxy('socks5://user:secret@example.com:10000'),
    'socks5://user:***@example.com:10000'
  );
});

test('ensureProxyConfigured picks one proxy from REGISTER_PROXY_LIST when no proxy is configured', () => {
  const oldProxy = process.env.PROXY;
  const oldList = process.env.PROXY_LIST;
  const oldRegisterList = process.env.REGISTER_PROXY_LIST;
  const proxyList = [
    'socks5://first:secret@example.com:10000',
    'socks5://second:secret@example.com:10000',
  ];
  delete process.env.PROXY;
  delete process.env.PROXY_LIST;
  process.env.REGISTER_PROXY_LIST = proxyList.join(',');
  try {
    ensureProxyConfigured();
    assert.ok(proxyList.includes(process.env.PROXY));
  } finally {
    if (oldProxy === undefined) delete process.env.PROXY; else process.env.PROXY = oldProxy;
    if (oldList === undefined) delete process.env.PROXY_LIST; else process.env.PROXY_LIST = oldList;
    if (oldRegisterList === undefined) delete process.env.REGISTER_PROXY_LIST; else process.env.REGISTER_PROXY_LIST = oldRegisterList;
  }
});

test('ensureProxyConfigured keeps an explicitly configured proxy', () => {
  const oldProxy = process.env.PROXY;
  const oldList = process.env.PROXY_LIST;
  const oldRegisterList = process.env.REGISTER_PROXY_LIST;
  process.env.PROXY = 'socks5://manual:secret@example.com:10000';
  delete process.env.PROXY_LIST;
  delete process.env.REGISTER_PROXY_LIST;
  try {
    ensureProxyConfigured();
    assert.equal(process.env.PROXY, 'socks5://manual:secret@example.com:10000');
  } finally {
    if (oldProxy === undefined) delete process.env.PROXY; else process.env.PROXY = oldProxy;
    if (oldList === undefined) delete process.env.PROXY_LIST; else process.env.PROXY_LIST = oldList;
    if (oldRegisterList === undefined) delete process.env.REGISTER_PROXY_LIST; else process.env.REGISTER_PROXY_LIST = oldRegisterList;
  }
});

test('pickResidentialProxyIds selects active Residential Proxies ids', () => {
  const ids = pickResidentialProxyIds([
    { id: 2, name: 'default', status: 'active' },
    { id: 6, name: 'Residential Proxies', status: 'active' },
    { id: 7, name: 'Residential Proxies', status: 'inactive' },
    { id: 8, name: 'Residential Proxies', status: 'active' },
  ]);

  assert.deepEqual(ids, [6, 8]);
});

test('runRegisterCliAndLoadLatest runs registration as a child process and loads its JSONL result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'register-upload-cli-'));
  const resultFile = path.join(root, 'results.jsonl');
  const writer = `
    const fs = require('fs');
    fs.appendFileSync(process.env.RESULT_LOCAL_FILE, JSON.stringify({
      success: true,
      email: 'cli@example.test',
      username: 'nsnzd-cli-user',
      keys: [{ site: 'cun.ai', baseUrl: 'https://www.cun.ai', apiKey: 'sk-test' }]
    }) + '\\n');
  `;

  const result = await runRegisterCliAndLoadLatest({
    command: process.execPath,
    args: ['-e', writer],
    resultFile,
    stdio: 'ignore',
  });

  assert.equal(result.username, 'nsnzd-cli-user');
  assert.equal(result.keys.length, 1);
});

test('runFullRegisterAndUpload marks the ledger after a successful upload', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { runFullRegisterAndUpload } = require('../register-upload-api-nsnzd');
  const { loadUploadedIds } = require('../lib/upload-ledger');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-ledger-'));
  const ledgerFile = path.join(dir, 'uploaded.jsonl');

  const result = { username: 'u-led', uploaded_at: 't-led', source: 'run-led', keys: [{ site: 'a6api', baseUrl: 'https://a6api.com', apiKey: 'sk-x' }] };

  await runFullRegisterAndUpload({
    adminKey: 'admin-test',
    groupId: 1,
    proxyIds: [6],
    registerAndRunSites: async () => result,
    buildAccountsFn: async () => ([{ name: 'n', platform: 'anthropic', type: 'apikey', credentials: { base_url: 'https://a6api.com', api_key: 'sk-x', model_mapping: { 'claude-opus-4-8': 'claude-opus-4-8' } }, concurrency: 1, priority: 1, group_ids: [1] }]),
    uploadFn: async () => ({ success: 1, failed: 0 }),
    ledgerFile,
  });

  const ids = loadUploadedIds(ledgerFile);
  assert.ok(ids.has('run-led'));
});

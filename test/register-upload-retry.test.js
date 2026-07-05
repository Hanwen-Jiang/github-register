const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reuploadUnuploaded } = require('../register-upload-retry');
const { markUploaded, loadUploadedIds } = require('../lib/upload-ledger');

test('reuploadUnuploaded uploads only results missing from the ledger and marks them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reupload-'));
  const resultsFile = path.join(dir, 'results.jsonl');
  const ledgerFile = path.join(dir, 'uploaded.jsonl');

  const r1 = { source: 'r1', username: 'u1', keys: [{ site: 'a6api', baseUrl: 'https://a6api.com', apiKey: 'sk-1' }] };
  const r2 = { source: 'r2', username: 'u2', keys: [{ site: 'a6api', baseUrl: 'https://a6api.com', apiKey: 'sk-2' }] };
  fs.writeFileSync(resultsFile, [JSON.stringify(r1), JSON.stringify(r2)].join('\n'));
  markUploaded(r1, { ledgerFile }); // r1 already uploaded

  const uploaded = [];
  let seenProxyIds = null;
  const res = await reuploadUnuploaded({
    resultsFile, ledgerFile, adminKey: 'admin-test', groupId: 1, proxyIds: [6, 7, 8],
    buildAccountsFn: async (r, opts) => {
      seenProxyIds = opts.proxyIds;
      return [{ name: 'n-' + r.source, platform: 'anthropic', type: 'apikey', credentials: { base_url: 'https://a6api.com', api_key: r.keys[0].apiKey, model_mapping: { x: 'x' } }, group_ids: [1], proxy_id: opts.proxyIds[0] }];
    },
    uploadFn: async (accts) => { uploaded.push(accts[0].name); return { success: 1, failed: 0 }; },
  });

  assert.equal(res.attempted, 1);
  assert.equal(res.succeeded, 1);
  assert.deepEqual(uploaded, ['n-r2']);       // only r2 re-uploaded
  assert.deepEqual(seenProxyIds, [6, 7, 8]);
  assert.ok(loadUploadedIds(ledgerFile).has('r2'));
});

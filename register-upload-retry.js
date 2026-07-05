'use strict';
const path = require('path');
const { readAllResults, findUnuploaded, markUploaded } = require('./lib/upload-ledger');
const {
  buildAnthropicAccountsWithLiveModels,
  uploadAccounts,
  resolveDefaultGroupId,
  normalizeAdminKey,
  loadDotEnv,
} = require('./lib/api-nsnzd-uploader');
const { resolveResidentialProxyIds } = require('./register-upload-api-nsnzd');

function applyDotEnv() {
  const env = loadDotEnv(path.join(__dirname, '.env'));
  for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;
}

async function reuploadUnuploaded(opts = {}) {
  const resultsFile = opts.resultsFile || process.env.RESULT_LOCAL_FILE || path.join(__dirname, 'data', 'results.jsonl');
  const ledgerFile = opts.ledgerFile || process.env.UPLOAD_LEDGER_FILE || path.join(__dirname, 'data', 'uploaded.jsonl');
  const adminKey = opts.adminKey || normalizeAdminKey(process.env.API_NSNZD_COM_ADMIN_KEY || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is required');
  const groupId = opts.groupId || await resolveDefaultGroupId({ adminKey });
  const proxyIds = await resolveResidentialProxyIds({ adminKey, proxyIds: opts.proxyIds });
  const buildAccounts = opts.buildAccountsFn || ((r, o) => buildAnthropicAccountsWithLiveModels(r, o));
  const doUpload = opts.uploadFn || ((a, o) => uploadAccounts(a, o));

  const results = readAllResults(resultsFile);
  const missing = findUnuploaded(results, ledgerFile);
  let succeeded = 0;
  let failed = 0;
  for (const result of missing) {
    try {
      const accounts = await buildAccounts(result, {
        adminKey,
        groupIds: [groupId],
        groupName: 'default',
        concurrency: 1,
        priority: 1,
        proxyIds,
      });
      await doUpload(accounts, { adminKey });
      markUploaded(result, { ledgerFile });
      succeeded += 1;
      console.log(`[Reupload] ok: ${result.username || result.source || 'unknown'}`);
    } catch (err) {
      failed += 1;
      console.log(`[Reupload] fail: ${result.username || result.source || 'unknown'}: ${err.message}`);
    }
  }
  return { attempted: missing.length, succeeded, failed };
}

async function main() {
  applyDotEnv();
  const res = await reuploadUnuploaded({});
  console.log(`[Reupload] done: attempted=${res.attempted} succeeded=${res.succeeded} failed=${res.failed}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error(err.stack || err.message); process.exit(1); });
}

module.exports = { reuploadUnuploaded, main };

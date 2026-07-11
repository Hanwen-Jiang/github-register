'use strict';
const path = require('path');
const { readAllResults, findUnuploaded, markUploaded } = require('./lib/upload-ledger');
const {
  buildAnthropicAccountsWithLiveModels,
  uploadAccounts,
  resolveUploadGroup,
  normalizeAdminKey,
  loadDotEnv,
} = require('./lib/api-nsnzd-uploader');
const { resolveResidentialProxyIds } = require('./register-upload-api-nsnzd');

function applyDotEnv() {
  const env = loadDotEnv(path.join(__dirname, '.env'));
  for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;
}

async function resolveUploadGroupForRetry(opts = {}, adminKey) {
  if (opts.groupId) {
    const id = Number(opts.groupId);
    return {
      id: Number.isFinite(id) ? id : opts.groupId,
      name: opts.groupName || `group-${opts.groupId}`,
    };
  }
  const envGroupId = process.env.UPLOAD_GROUP_ID || '';
  const envGroupName = process.env.UPLOAD_GROUP_NAME || '';
  if (envGroupId && envGroupName) {
    const id = Number(envGroupId);
    return {
      id: Number.isFinite(id) ? id : envGroupId,
      name: envGroupName,
    };
  }

  if (typeof opts.resolveUploadGroupFn === 'function') {
    const selected = await opts.resolveUploadGroupFn({ adminKey });
    if (typeof selected === 'number' || typeof selected === 'string') {
      return { id: Number.isFinite(Number(selected)) ? Number(selected) : selected, name: opts.groupName || `group-${selected}` };
    }
    if (!selected?.id) throw new Error('upload group selection has no id');
    return {
      id: Number.isFinite(Number(selected.id)) ? Number(selected.id) : selected.id,
      name: selected.name || selected.group?.name || selected.group?.group_name || opts.groupName || `group-${selected.id}`,
    };
  }

  if (typeof opts.resolveGroupIdFn === 'function') {
    const id = await opts.resolveGroupIdFn({ adminKey });
    return { id, name: opts.groupName || `group-${id}` };
  }

  return resolveUploadGroup({
    adminKey,
    groupName: opts.groupName,
    promptGroup: opts.promptGroup,
    promptFn: opts.promptFn,
    cache: opts.groupCache,
  });
}

async function reuploadUnuploaded(opts = {}) {
  const resultsFile = opts.resultsFile || process.env.RESULT_LOCAL_FILE || path.join(__dirname, 'data', 'results.jsonl');
  const ledgerFile = opts.ledgerFile || process.env.UPLOAD_LEDGER_FILE || path.join(__dirname, 'data', 'uploaded.jsonl');
  const adminKey = opts.adminKey || normalizeAdminKey(process.env.API_NSNZD_COM_ADMIN_KEY || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is required');

  const results = readAllResults(resultsFile);
  const missing = findUnuploaded(results, ledgerFile);
  if (missing.length === 0) return { attempted: 0, succeeded: 0, failed: 0 };

  const resolveProxyIds = opts.resolveProxyIdsFn || resolveResidentialProxyIds;
  const uploadGroup = await resolveUploadGroupForRetry(opts, adminKey);
  const groupId = uploadGroup.id;
  const groupName = uploadGroup.name || `group-${groupId}`;
  const proxyIds = await resolveProxyIds({ adminKey, proxyIds: opts.proxyIds });
  const buildAccounts = opts.buildAccountsFn || ((r, o) => buildAnthropicAccountsWithLiveModels(r, o));
  const doUpload = opts.uploadFn || ((a, o) => uploadAccounts(a, o));
  let succeeded = 0;
  let failed = 0;
  console.log(`[Reupload] 目标分组: ${groupName} (#${groupId})`);
  for (const result of missing) {
    try {
      const accounts = await buildAccounts(result, {
        adminKey,
        groupIds: [groupId],
        groupName,
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

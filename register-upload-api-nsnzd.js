// Full flow:
//   GitHub registration + target site key creation -> import generated keys into api.nsnzd.com.
//
// Import format:
//   platform: anthropic
//   type: apikey
//   name: register-{site}-anthropic-default-gh-{YYYYMMDDHHmmss}-{suffix}
//   concurrency: 1
//   priority: 1
//   group: default
//   model whitelist: upstream models ∩ known Claude models, represented as credentials.model_mapping identity map

const path = require('path');
const { spawn } = require('child_process');
const {
  buildAnthropicAccountsWithLiveModels,
  loadLatestResult,
  loadDotEnv,
  normalizeAdminKey,
  resolveDefaultGroupId,
  retryAsync,
  summarizeSecret,
  uploadAccounts,
} = require('./lib/api-nsnzd-uploader');
const { markUploaded } = require('./lib/upload-ledger');

const DEFAULT_PROXY_LIST = [];

let registerAndRunSites = null;

function getRegisterAndRunSites() {
  if (!registerAndRunSites) {
    ({ main: registerAndRunSites } = require('./index'));
  }
  return registerAndRunSites;
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function maskProxy(proxy) {
  return String(proxy || '').replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:***@');
}

function loadEnv() {
  const env = loadDotEnv(path.join(__dirname, '.env'));
  for (const [key, value] of Object.entries(env)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

function ensureProxyConfigured() {
  const explicitProxy = process.env.PROXY || '';
  if (explicitProxy) return;
  const proxyList = (process.env.REGISTER_PROXY_LIST || process.env.PROXY_LIST || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (proxyList.length === 0) return;
  const picked = pickRandom(proxyList);
  process.env.PROXY = picked;
  console.log(`[Proxy] 自动选择: ${maskProxy(picked)}`);
}

function readAdminKey() {
  const key = normalizeAdminKey(process.env.API_NSNZD_COM_ADMIN_KEY || '');
  if (!key) throw new Error('API_NSNZD_COM_ADMIN_KEY is required');
  return key;
}

function resolveResultFile(opts = {}) {
  const file = opts.resultFile || process.env.RESULT_LOCAL_FILE || path.join(__dirname, 'data', 'results.jsonl');
  if (String(file).toLowerCase() === 'off') {
    throw new Error('RESULT_LOCAL_FILE=off cannot be used with register:upload; a local result file is required for the upload handoff');
  }
  return file;
}

async function runRegisterCliAndLoadLatest(opts = {}) {
  const resultFile = resolveResultFile(opts);
  const command = opts.command || process.execPath;
  const args = opts.args || [path.join(__dirname, 'index.js')];
  const stdio = opts.stdio || 'inherit';
  const childEnv = {
    ...process.env,
    RESULT_LOCAL_FILE: resultFile,
  };

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd || __dirname,
      env: childEnv,
      stdio,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`registration command failed: ${signal || `exit ${code}`}`));
    });
  });

  return loadLatestResult(resultFile);
}

async function verifyAdminKey() {
  loadEnv();
  const adminKey = readAdminKey();
  const summary = summarizeSecret(adminKey);
  const groupId = await resolveDefaultGroupId({ adminKey });
  console.log(JSON.stringify({
    success: true,
    key: summary,
    defaultGroupId: groupId,
  }, null, 2));
}

async function runFullRegisterAndUpload(opts = {}) {
  loadEnv();
  ensureProxyConfigured();
  const adminKey = opts.adminKey || readAdminKey();

  const groupId = opts.groupId || await resolveDefaultGroupId({ adminKey });
  const startedAt = new Date();
  const ledgerFile = opts.ledgerFile || process.env.UPLOAD_LEDGER_FILE || path.join(__dirname, 'data', 'uploaded.jsonl');
  const uploadRetries = opts.uploadRetries ?? parseInt(process.env.UPLOAD_RETRIES || '2', 10);
  const uploadRetryDelayMs = opts.uploadRetryDelayMs ?? parseInt(process.env.UPLOAD_RETRY_DELAY_MS || '2000', 10);

  const result = opts.registerAndRunSites
    ? await opts.registerAndRunSites()
    : (opts.useInProcessRegister || process.env.REGISTER_UPLOAD_IN_PROCESS === 'true')
      ? await getRegisterAndRunSites()()
      : await runRegisterCliAndLoadLatest({ resultFile: opts.resultFile });
  console.log(`[Upload] 读取本次结果: ${result.username || result.email || 'unknown'} / keys=${Array.isArray(result.keys) ? result.keys.length : 0}`);

  const buildAccounts = opts.buildAccountsFn || ((r, o) => buildAnthropicAccountsWithLiveModels(r, o));
  const doUpload = opts.uploadFn || ((accts, o) => uploadAccounts(accts, o));

  const { accounts, upload } = await retryAsync(async () => {
    const accounts = await buildAccounts(result, {
      adminKey,
      groupIds: [groupId],
      groupName: 'default',
      concurrency: 1,
      priority: 1,
      date: startedAt,
      onRetry: (err, attempt) => {
        console.log(`[Upload] 模型探测重试 ${attempt}: ${err.message}`);
      },
    });
    console.log(`[Upload] 开始导入 api.nsnzd.com: accounts=${accounts.length}`);
    const upload = await doUpload(accounts, { adminKey });
    return { accounts, upload };
  }, {
    retries: uploadRetries,
    delayMs: uploadRetryDelayMs,
    onRetry: (err, attempt) => {
      console.log(`[Upload] 导入重试 ${attempt}: ${err.message}`);
    },
  });

  markUploaded(result, { ledgerFile });
  console.log(`[Upload] 导入完成并记账: success=${upload?.success ?? 'unknown'} failed=${upload?.failed ?? 'unknown'}`);

  return {
    success: true,
    result,
    imported: accounts.map(account => ({
      name: account.name,
      platform: account.platform,
      type: account.type,
      baseUrl: account.credentials.base_url,
      concurrency: account.concurrency,
      priority: account.priority,
      groupIds: account.group_ids,
      modelWhitelistCount: Object.keys(account.credentials.model_mapping || {}).length,
    })),
    upload,
  };
}

async function main() {
  const output = await runFullRegisterAndUpload();
  console.log(JSON.stringify({
    success: output.success,
    email: output.result.email,
    username: output.result.username,
    durationSeconds: output.result.durationSeconds,
    imported: output.imported,
  }, null, 2));
  return output;
}

if (require.main === module) {
  const entry = process.argv.includes('--verify-admin-key') ? verifyAdminKey : main;
  entry().then(() => process.exit(0)).catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_PROXY_LIST,
  ensureProxyConfigured,
  maskProxy,
  runRegisterCliAndLoadLatest,
  verifyAdminKey,
  runFullRegisterAndUpload,
};

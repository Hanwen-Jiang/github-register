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
const {
  buildAnthropicAccountsWithLiveModels,
  loadDotEnv,
  normalizeAdminKey,
  resolveDefaultGroupId,
  summarizeSecret,
  uploadAccounts,
} = require('./lib/api-nsnzd-uploader');

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
  const result = await getRegisterAndRunSites()();
  const accounts = await buildAnthropicAccountsWithLiveModels(result, {
    adminKey,
    groupIds: [groupId],
    groupName: 'default',
    concurrency: 1,
    priority: 1,
    date: startedAt,
  });
  const upload = await uploadAccounts(accounts, { adminKey });

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
  verifyAdminKey,
  runFullRegisterAndUpload,
};

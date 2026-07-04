// oauth-only.js — consume queued GitHub cookie files to run Phase 5.
//
// Behavior:
//   1. If cookie files exist, use the first one to register site keys.
//   2. On success, upload/archive result and delete that cookie file.
//   3. On failure, delete that cookie file and try the next.
//   4. If no cookies remain, automatically run full GitHub registration via index.js.
const fs = require('fs');
const path = require('path');
const { main: registerAndRunSites, TARGET_SITES } = require('./index');
const { runSitesOAuthHttp } = require('./lib/hybrid-oauth');
const { listCookieFiles, loadCookies, deleteCookieFile, defaultCookieFile } = require('./lib/cookie-store');
const { uploadResult } = require('./lib/result-uploader');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function runWithCookieFile(cookieFile) {
  const cookies = loadCookies(cookieFile);
  const results = await runSitesOAuthHttp(TARGET_SITES, cookies, { proxyUrl: process.env.PROXY || '' });
  const result = { success: true, source: 'cookies', cookieFile, keys: results };
  await uploadResult(result, { meta: { source: 'oauth-only', cookieFile } });
  return result;
}

async function runFreshRegistration() {
  console.log('没有可用 GitHub cookies，自动注册新的 GitHub 账号并注册站点...');
  const cookieFile = process.env.GITHUB_COOKIES_FILE || defaultCookieFile(__dirname);
  try {
    return await registerAndRunSites();
  } catch (err) {
    throw err;
  } finally {
    deleteCookieFile(cookieFile);
  }
}

async function runQueuedOrFresh(opts = {}) {
  loadEnv();
  const log = opts.log === false ? () => {} : console.log;
  const error = opts.log === false ? () => {} : console.error;
  const cookieFiles = opts.cookieFiles || listCookieFiles({ rootDir: opts.rootDir || __dirname });
  const runCookie = opts.runWithCookieFile || runWithCookieFile;
  const runFresh = opts.runFreshRegistration || runFreshRegistration;
  const removeCookie = opts.deleteCookieFile || deleteCookieFile;

  for (const cookieFile of cookieFiles) {
    try {
      log(`使用 GitHub cookies: ${cookieFile}`);
      const result = await runCookie(cookieFile);
      removeCookie(cookieFile);
      log(`✅ cookie 已消费并删除: ${cookieFile}`);
      return result;
    } catch (err) {
      error(`❌ cookie 注册站点失败，删除并尝试下一个: ${cookieFile}`);
      error(err.message);
      removeCookie(cookieFile);
    }
  }

  return runFresh();
}

async function main() {
  const result = await runQueuedOrFresh();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { main, runWithCookieFile, runFreshRegistration, runQueuedOrFresh };

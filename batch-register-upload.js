'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { generateProxyPool } = require('./lib/proxy-pool');
const { loadDotEnv, normalizeAdminKey } = require('./lib/api-nsnzd-uploader');
const { reuploadUnuploaded } = require('./register-upload-retry');

function applyDotEnv() {
  const env = loadDotEnv(path.join(__dirname, '.env'));
  for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function buildBatchConfig(env = process.env) {
  const total = num(env.BATCH_TOTAL || env.TOTAL, 10);
  const concurrency = Math.min(num(env.BATCH_CONCURRENCY || env.CONCURRENCY, 5), total);
  const proxyCount = num(env.PROXY_POOL_COUNT, 100);
  const proxies = String(env.BATCH_PROXY_LIST || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return {
    total,
    concurrency,
    failLimit: num(env.BATCH_FAIL_LIMIT, Math.max(5, concurrency * 2)),
    proxies: proxies.length > 0 ? proxies : generateProxyPool({ count: proxyCount }),
    resultDir: env.BATCH_RESULT_DIR || path.join(__dirname, 'data', 'batch'),
    autoRetryUpload: String(env.BATCH_AUTO_RETRY_UPLOAD || 'true') !== 'false',
  };
}

function maskProxy(proxy) {
  return String(proxy || '').replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:***@');
}

function buildChildEnv({ proxy, slot, index, resultDir, env = process.env }) {
  const tag = `slot${String(slot).padStart(2, '0')}-job${String(index).padStart(4, '0')}`;
  const resultFile = path.join(resultDir, 'runs', `${tag}.jsonl`);
  return {
    ...env,
    PROXY: proxy,
    RESULT_LOCAL_FILE: resultFile,
    BATCH_SHARED_RESULT_FILE: path.join(resultDir, 'results.jsonl'),
    UPLOAD_LEDGER_FILE: path.join(resultDir, 'uploaded.jsonl'),
    CHROME_PROFILE_DIR: path.join(resultDir, 'chrome', tag),
    GITHUB_COOKIES_FILE: path.join(resultDir, 'cookies', `${tag}.json`),
    GITHUB_COOKIES_DIR: path.join(resultDir, 'github-sessions'),
    ERROR_SCREENSHOT_FILE: path.join(resultDir, 'errors', `${tag}.png`),
    SIGNUP_FAILED_SCREENSHOT_FILE: path.join(resultDir, 'errors', `${tag}-signup-failed.png`),
    BATCH_SLOT: String(slot),
    BATCH_JOB_INDEX: String(index),
  };
}

function appendFileIfExists(src, dest) {
  if (!src || !dest || !fs.existsSync(src)) return false;
  const text = fs.readFileSync(src, 'utf8');
  if (!text.trim()) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.appendFileSync(dest, text.endsWith('\n') ? text : `${text}\n`);
  return true;
}

function runRegisterUploadChild({ proxy, slot, index, resultDir, env = process.env, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'register-upload-api-nsnzd.js');
    const childEnv = buildChildEnv({ proxy, slot, index, resultDir, env });

    const startedAt = Date.now();
    let child;
    try {
      child = spawnImpl(process.execPath, [script], {
        cwd: __dirname,
        env: childEnv,
        stdio: 'inherit',
      });
    } catch (err) {
      return resolve({ ok: false, proxy, slot, index, error: err.message, durationMs: Date.now() - startedAt });
    }

    child.on('error', err => resolve({ ok: false, proxy, slot, index, error: err.message, durationMs: Date.now() - startedAt }));
    child.on('exit', (code, signal) => {
      // Merge any minted result even when the child exits non-zero later
      // (for example upload/model-probe failure after keys were written).
      // register:upload-retry can then recover it from the shared batch file.
      const merged = appendFileIfExists(childEnv.RESULT_LOCAL_FILE, childEnv.BATCH_SHARED_RESULT_FILE);
      resolve({
        ok: code === 0,
        proxy,
        slot,
        index,
        code,
        signal,
        resultFile: childEnv.RESULT_LOCAL_FILE,
        merged,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function runBatch(opts = {}) {
  const total = opts.total;
  const concurrency = opts.concurrency;
  const proxies = opts.proxies || [];
  const resultDir = opts.resultDir || path.join(__dirname, 'data', 'batch');
  const failLimit = opts.failLimit ?? Math.max(5, concurrency * 2);
  const log = opts.log || console.log;
  const runOne = opts.runOne || runRegisterUploadChild;

  if (!total || !concurrency) throw new Error('total and concurrency are required');
  if (proxies.length < concurrency) throw new Error(`not enough proxies: proxies=${proxies.length}, concurrency=${concurrency}`);

  let nextJob = 0;
  let ok = 0;
  let failed = 0;
  const results = [];

  async function worker(slot) {
    while (nextJob < total && failed < failLimit) {
      const index = nextJob++;
      const proxy = proxies[index % proxies.length];
      log(`[batch] start ${index + 1}/${total} slot=${slot} proxy=${maskProxy(proxy)}`);
      const res = await runOne({ proxy, slot, index, resultDir });
      results.push(res);
      if (res.ok) {
        ok += 1;
        log(`[batch] ok ${index + 1}/${total} slot=${slot} ${(res.durationMs / 1000).toFixed(1)}s`);
      } else {
        failed += 1;
        log(`[batch] fail ${index + 1}/${total} slot=${slot} ${res.error || res.signal || `exit ${res.code}`}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));
  return { total, ok, failed, results };
}

async function main() {
  applyDotEnv();
  const adminKey = normalizeAdminKey(process.env.API_NSNZD_COM_ADMIN_KEY || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is required');
  const config = buildBatchConfig(process.env);
  console.log(`[batch] total=${config.total} concurrency=${config.concurrency} proxies=${config.proxies.length}`);
  const res = await runBatch(config);
  if (config.autoRetryUpload) {
    const resultsFile = path.join(config.resultDir, 'results.jsonl');
    const ledgerFile = path.join(config.resultDir, 'uploaded.jsonl');
    try {
      const retry = await reuploadUnuploaded({ resultsFile, ledgerFile });
      console.log(`[batch] upload recovery: attempted=${retry.attempted} succeeded=${retry.succeeded} failed=${retry.failed}`);
    } catch (err) {
      console.log(`[batch] upload recovery failed: ${err.message}`);
    }
  }
  console.log(`[batch] done total=${res.total} ok=${res.ok} failed=${res.failed}`);
  if (res.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  buildBatchConfig,
  buildChildEnv,
  appendFileIfExists,
  runBatch,
  runRegisterUploadChild,
  maskProxy,
};

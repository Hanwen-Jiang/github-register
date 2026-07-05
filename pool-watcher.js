'use strict';
const path = require('path');
const {
  loadWatcherConfig,
  readUsablePool,
  runOneRegistration,
  makeProxyRotator,
  runTick,
  runForever,
} = require('./lib/pool-watcher');
const { loadDotEnv, normalizeAdminKey } = require('./lib/api-nsnzd-uploader');
const { generateProxyPool } = require('./lib/proxy-pool');
const { reuploadUnuploaded } = require('./register-upload-retry');

function applyDotEnv() {
  const env = loadDotEnv(path.join(__dirname, '.env'));
  for (const [k, v] of Object.entries(env)) {
    if (!(k in process.env)) process.env[k] = v;
  }
}

function resolveProxies(config) {
  // Prefer the explicit REGISTER_PROXY_LIST; if it is empty or tiny, fall back to
  // the generated jhwNNN pool so concurrent runs each get a distinct exit IP.
  if (config.proxies && config.proxies.length > 3) return config.proxies;
  const count = parseInt(process.env.PROXY_POOL_COUNT || '100', 10);
  const generated = generateProxyPool({ count });
  return config.proxies && config.proxies.length > 0
    ? [...config.proxies, ...generated]
    : generated;
}

async function main() {
  applyDotEnv();
  const config = loadWatcherConfig(process.env);
  const adminKey = normalizeAdminKey(process.env.API_NSNZD_COM_ADMIN_KEY || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is required');

  const proxies = resolveProxies(config);
  const nextProxy = makeProxyRotator(proxies);
  const deps = {
    readPool: () => readUsablePool({ adminKey }),
    register: (proxy) => runOneRegistration({ proxy, env: process.env }),
    nextProxy,
    now: () => Date.now(),
    log: (msg) => console.log(msg),
  };

  const sleep = (s) => new Promise(r => setTimeout(r, Math.max(0, s) * 1000));

  // Startup recovery: re-upload any minted-but-un-uploaded keys before looping.
  // Cheap and idempotent thanks to the ledger.
  try {
    const rec = await reuploadUnuploaded({});
    console.log(`[pool] startup recovery: attempted=${rec.attempted} succeeded=${rec.succeeded} failed=${rec.failed}`);
  } catch (err) {
    console.log(`[pool] startup recovery skipped: ${err.message}`);
  }

  if (process.env.POOL_ONESHOT) {
    const res = await runTick({ config, snapshots: [], deps });
    console.log(`[pool] oneshot: action=${res.action} registered=${res.registered}`);
    return;
  }
  console.log(`[pool] watcher starting: target>=${config.targetMin}, lookahead=${config.lookaheadHours}h, proxies=${proxies.length}`);
  await runForever({ config, deps, sleep });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { main };

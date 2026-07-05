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

function applyDotEnv() {
  const env = loadDotEnv(path.join(__dirname, '.env'));
  for (const [k, v] of Object.entries(env)) {
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function main() {
  applyDotEnv();
  const config = loadWatcherConfig(process.env);
  const adminKey = normalizeAdminKey(process.env.API_NSNZD_COM_ADMIN_KEY || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is required');

  const nextProxy = makeProxyRotator(config.proxies);
  const deps = {
    readPool: () => readUsablePool({ adminKey }),
    register: (proxy) => runOneRegistration({ proxy, env: process.env }),
    nextProxy,
    now: () => Date.now(),
    log: (msg) => console.log(msg),
  };

  const sleep = (s) => new Promise(r => setTimeout(r, Math.max(0, s) * 1000));

  if (process.env.POOL_ONESHOT) {
    const res = await runTick({ config, snapshots: [], deps });
    console.log(`[pool] oneshot: action=${res.action} registered=${res.registered}`);
    return;
  }
  console.log(`[pool] watcher starting: target>=${config.targetMin}, lookahead=${config.lookaheadHours}h, proxies=${config.proxies.length}`);
  await runForever({ config, deps, sleep });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { main };

#!/usr/bin/env node
// register-github.js — Stage A: register a GitHub account and PERSIST the session.
// No OAuth, no token minting. The saved session (data/sessions.jsonl) is a reusable
// lead: Stage B (oauth-site.js) later drives it into any guide-site.
//
//   node register-github.js
//   SIGNUP_EMAIL=alice@nsnzd.com node register-github.js
//
// The persisted record starts empty_keys:true so findReusableSession won't pick it
// until Stage B produces keys (mirrors the server-side Python semantics).

const fs = require('fs');
const path = require('path');

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

async function main(opts = {}) {
  loadEnv();
  const register = opts.registerGithubAccount || require('./index').registerGithubAccount;
  const appendSession = opts.appendSession || require('./lib/session-store').appendSession;

  const reg = await register();
  try {
    const record = appendSession({
      email: reg.identity.email,
      username: reg.identity.username,
      password: reg.identity.password,
      proxy_url: reg.proxyUrl || '',
      storage_state: reg.storageState,
      sites_registered: {},
      status: 'active',
      last_result_keys: 0,
      empty_keys: true,
    }, { rootDir: __dirname });
    const out = { success: true, email: record.email, username: record.username, persisted: true, cookies: (reg.storageState.cookies || []).length };
    console.log(JSON.stringify(out, null, 2));
    return out;
  } finally {
    await reg.context.close().catch(() => {});
    if (reg.proxyBridge) await reg.proxyBridge.close().catch(() => {});
    console.log('[Browser] 已关闭');
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error(`❌ [Fatal] ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { main };

#!/usr/bin/env node
// oauth-site.js — Stage B: drive a PERSISTED GitHub session into a guide-site via
// OAuth, mint keys, and record the result back onto the session. Site-agnostic:
// works for cun.ai/a6api today and any future guide-site added to lib/sites.js.
//
//   SITE_LIST=cun.ai node oauth-site.js            # pick a reusable session for cun.ai
//   node oauth-site.js --email alice@nsnzd.com     # use a specific session
//   node oauth-site.js --site a6api --email ...
//
// Reuses lib/hybrid-oauth (playwright-free HTTP OAuth) with the session's stored
// cookies. Only KEYS are uploaded to results.jsonl — storage_state is never sent
// upstream.

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

function parseArgs(argv) {
  const out = { email: '', site: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email') out.email = argv[++i] || '';
    else if (argv[i] === '--site') out.site = argv[++i] || '';
  }
  return out;
}

// Resolve which sessions to run against which sites. For an explicit --email, use
// that one session for all target sites. Otherwise pick a reusable session per site
// (a session already registered on site X becomes a lead for site Y).
function planWork(targetSites, args, deps) {
  const { findSession, findReusableSession } = deps;
  const allowedProxies = deps.allowedProxies; // undefined = no proxy filter (local)
  const plan = [];
  if (args.email) {
    const sess = findSession(args.email, { rootDir: deps.rootDir });
    if (!sess) throw new Error(`no session for ${args.email}`);
    for (const site of targetSites) {
      if ((sess.sites_registered || {})[site.name]) {
        console.log(`  ↷ ${args.email} 已在 ${site.name} 注册过，跳过`);
        continue;
      }
      plan.push({ session: sess, site });
    }
    return plan;
  }
  for (const site of targetSites) {
    const sess = findReusableSession(site.name, { rootDir: deps.rootDir, allowedProxies });
    if (!sess) {
      console.log(`  ⚠️ 没有可复用 session 用于 ${site.name}`);
      continue;
    }
    plan.push({ session: sess, site });
  }
  return plan;
}

async function main(opts = {}) {
  loadEnv();
  const args = opts.args || parseArgs(process.argv.slice(2));
  const sitesLib = opts.sitesLib || require('./lib/sites');
  const store = opts.store || require('./lib/session-store');
  const runSitesOAuthHttp = opts.runSitesOAuthHttp || require('./lib/hybrid-oauth').runSitesOAuthHttp;
  const uploadResult = opts.uploadResult || require('./lib/result-uploader').uploadResult;
  const routingProfiles = opts.routingProfiles || sitesLib.resolveRoutingProfiles();
  const rootDir = opts.rootDir || __dirname;

  const targetSites = sitesLib.resolveTargetSites(args.site || undefined);
  if (targetSites.length === 0) throw new Error(`no target sites match filter: ${args.site}`);

  const plan = planWork(targetSites, args, {
    findSession: store.findSession,
    findReusableSession: store.findReusableSession,
    allowedProxies: opts.allowedProxies,
    rootDir,
  });
  if (plan.length === 0) {
    console.log('无可执行的 (session, site) 组合。');
    return { success: false, results: [] };
  }

  const uploaded = [];
  for (const { session, site } of plan) {
    console.log(`\n━━━ Stage B: ${session.email} → ${site.name} ━━━`);
    const cookies = store.getSessionCookies(session);
    let siteResults;
    try {
      siteResults = await runSitesOAuthHttp([site], cookies, { proxyUrl: session.proxy_url || '', routingProfiles });
    } catch (err) {
      console.error(`  ❌ ${site.name} OAuth 失败: ${err.message}`);
      store.updateSession(session.email, { last_error: String(err.message).slice(0, 500) }, { rootDir });
      continue;
    }
    const keys = siteResults.map(r => ({ apiKey: r.apiKey, profile: r.profile }));
    const userId = siteResults[0] && siteResults[0].userId;
    store.markSiteRegistered(session.email, site.name, { userId, keys }, { rootDir });

    const result = {
      success: true,
      email: session.email,
      username: session.username,
      password: session.password,
      keys: siteResults,
      source: 'stage-b-oauth',
    };
    await uploadResult(result, { meta: { source: 'oauth-site', site: site.name } });
    uploaded.push(...siteResults);
    for (const r of siteResults) console.log(`  🎉 ${r.site} [${r.profile || 'default'}] ${r.apiKey.substring(0, 12)}...`);
  }

  const out = { success: uploaded.length > 0, results: uploaded };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  main().then(r => process.exit(r.success ? 0 : 1)).catch(err => {
    console.error(`❌ [Fatal] ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { main, planWork, parseArgs };

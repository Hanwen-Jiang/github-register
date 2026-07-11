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
  const findAvailableSession = deps.findAvailableSession || findReusableSession;
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
    const sess = findAvailableSession(site.name, { rootDir: deps.rootDir, allowedProxies });
    if (!sess) {
      console.log(`  ⚠️ 没有可复用 session 用于 ${site.name}`);
      continue;
    }
    plan.push({ session: sess, site });
  }
  return plan;
}

function isLocalhostProxy(proxyUrl) {
  if (!proxyUrl) return false;
  try {
    const u = new URL(proxyUrl);
    const host = u.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch (_) {
    return false;
  }
}

function resolveSessionProxyUrl(session = {}, env = process.env) {
  const explicitOauthProxy = String(env.OAUTH_SITE_PROXY || '').trim();
  if (explicitOauthProxy) return explicitOauthProxy;
  const explicitProxy = String(env.PROXY || '').trim();
  if (explicitProxy) return explicitProxy;
  if (session.upstream_proxy_url && !isLocalhostProxy(session.upstream_proxy_url)) return session.upstream_proxy_url;
  if (session.proxy_url && !isLocalhostProxy(session.proxy_url)) return session.proxy_url;
  return '';
}

function normalizeUploadGroup(group = {}) {
  if (typeof group === 'number' || typeof group === 'string') {
    return { id: Number.isFinite(Number(group)) ? Number(group) : group, name: `group-${group}` };
  }
  if (!group?.id) throw new Error('upload group selection has no id');
  return {
    id: Number.isFinite(Number(group.id)) ? Number(group.id) : group.id,
    name: group.name || group.group?.name || group.group?.group_name || `group-${group.id}`,
  };
}

function sessionSiteLockPath(rootDir, email, siteName) {
  const key = Buffer.from(`${String(email || '').toLowerCase()}\t${siteName || ''}`).toString('base64url');
  return path.join(rootDir, 'data', 'oauth-site-locks', `${key}.lock`);
}

function acquireSessionSiteLock(session, site, opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const staleMsRaw = opts.staleMs ?? process.env.OAUTH_SITE_LOCK_STALE_MS ?? String(30 * 60 * 1000);
  const staleMs = Number.isFinite(Number(staleMsRaw)) ? Number(staleMsRaw) : 30 * 60 * 1000;
  const isPidAlive = opts.isPidAlive || ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (_) {
      return false;
    }
  });
  const file = sessionSiteLockPath(rootDir, session.email, site.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({
    email: session.email,
    site: site.name,
    pid: process.pid,
    created_at: new Date().toISOString(),
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, `${payload}\n`);
      return { acquired: true, file };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      if (attempt === 0) {
        try {
          const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
          const pid = Number(existing.pid);
          if (Number.isFinite(pid) && pid > 0 && !isPidAlive(pid)) {
            fs.unlinkSync(file);
            continue;
          }
        } catch (_) {}
      }
      if (attempt === 0 && staleMs > 0) {
        try {
          const ageMs = Date.now() - fs.statSync(file).mtimeMs;
          if (ageMs > staleMs) {
            fs.unlinkSync(file);
            continue;
          }
        } catch (_) {
          continue;
        }
      }
      return { acquired: false, file };
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) {}
      }
    }
  }
  return { acquired: false, file };
}

function releaseSessionSiteLock(lock) {
  if (!lock?.acquired || !lock.file) return;
  try { fs.unlinkSync(lock.file); } catch (_) {}
}

function isGithubLoginRequiredError(err) {
  const msg = String(err?.message || err || '');
  return /github_authorize_(get|post):30[127]->https:\/\/github\.com\/login\b/i.test(msg) ||
    /github\.com\/login\?[^ ]*return_to=.*login%2Foauth%2Fauthorize/i.test(msg) ||
    /Unauthorized, not logged in and no access token provided/i.test(msg);
}

function isGithubSuspendedError(err) {
  const msg = String(err?.message || err || '');
  return /account\s+(?:has\s+been\s+)?suspended/i.test(msg) ||
    /account[\/_-]suspended/i.test(msg) ||
    /github_(?:account_)?suspended/i.test(msg);
}

async function main(opts = {}) {
  loadEnv();
  const args = opts.args || parseArgs(process.argv.slice(2));
  const sitesLib = opts.sitesLib || require('./lib/sites');
  const store = opts.store || require('./lib/session-store');
  const runSitesOAuthHttp = opts.runSitesOAuthHttp || require('./lib/hybrid-oauth').runSitesOAuthHttp;
  const uploadResult = opts.uploadResult || require('./lib/result-uploader').uploadResult;
  const reuploadUnuploaded = opts.reuploadUnuploaded || require('./register-upload-retry').reuploadUnuploaded;
  const resolveUploadGroup = opts.resolveUploadGroupFn || require('./lib/api-nsnzd-uploader').resolveUploadGroup;
  const routingProfiles = opts.routingProfiles || sitesLib.resolveRoutingProfiles();
  const rootDir = opts.rootDir || __dirname;
  const importToApi = opts.importToApi ?? process.env.OAUTH_SITE_IMPORT_API_NSNZD !== 'false';
  const apiAdminKey = opts.apiAdminKey || process.env.API_NSNZD_COM_ADMIN_KEY || '';
  const ledgerFile = opts.ledgerFile || process.env.UPLOAD_LEDGER_FILE || path.join(rootDir, 'data', 'uploaded.jsonl');

  const targetSites = sitesLib.resolveTargetSites(args.site || undefined);
  if (targetSites.length === 0) throw new Error(`no target sites match filter: ${args.site}`);

  const plan = planWork(targetSites, args, {
    findSession: store.findSession,
    findReusableSession: store.findReusableSession,
    findAvailableSession: store.findAvailableSession,
    allowedProxies: opts.allowedProxies,
    rootDir,
  });
  if (plan.length === 0) {
    console.log('无可执行的 (session, site) 组合。');
    return { success: false, results: [] };
  }

  let uploadGroup = null;
  if (importToApi && String(apiAdminKey || '').trim()) {
    uploadGroup = normalizeUploadGroup(opts.uploadGroup || await resolveUploadGroup({
      adminKey: apiAdminKey,
      promptGroup: opts.promptGroup,
      promptFn: opts.promptFn,
      cache: opts.groupCache,
    }));
    console.log(`[api.nsnzd.com] 目标分组: ${uploadGroup.name} (#${uploadGroup.id})`);
  }

  const uploaded = [];
  const localResultFiles = new Set();
  for (const { session, site } of plan) {
    const lock = acquireSessionSiteLock(session, site, { rootDir, staleMs: opts.lockStaleMs });
    if (!lock.acquired) {
      console.log(`  ↷ ${session.email} → ${site.name} 正在其它进程处理，跳过`);
      continue;
    }
    try {
      const latestSession = store.findSession(session.email, { rootDir }) || session;
      if (latestSession.status !== 'active') {
        console.log(`  ↷ ${latestSession.email} 状态=${latestSession.status || 'unknown'}，跳过 ${site.name}`);
        continue;
      }
      if ((latestSession.sites_registered || {})[site.name]) {
        console.log(`  ↷ ${latestSession.email} 已在 ${site.name} 注册过，跳过`);
        continue;
      }

      console.log(`\n━━━ Stage B: ${latestSession.email} → ${site.name} ━━━`);
      const cookies = store.getSessionCookies(latestSession);
      let siteResults;
      try {
        siteResults = await runSitesOAuthHttp([site], cookies, { proxyUrl: resolveSessionProxyUrl(latestSession), routingProfiles });
      } catch (err) {
        console.error(`  ❌ ${site.name} OAuth 失败: ${err.message}`);
        const patch = { last_error: String(err.message).slice(0, 500) };
        if (isGithubSuspendedError(err)) {
          store.quarantineSuspendedSession(latestSession.email, patch, { rootDir });
          console.error(`  🚫 ${latestSession.email} GitHub account suspended，已隔离到 sessions.suspended.jsonl`);
        } else if (isGithubLoginRequiredError(err)) {
          patch.status = 'github_login_required';
          console.error(`  🚫 ${latestSession.email} GitHub session 已失效，标记为 github_login_required，后续跳过`);
          store.updateSession(latestSession.email, patch, { rootDir });
        } else {
          store.updateSession(latestSession.email, patch, { rootDir });
        }
        continue;
      }
      const keys = siteResults.map(r => ({ apiKey: r.apiKey, profile: r.profile }));
      const userId = siteResults[0] && siteResults[0].userId;
      store.markSiteRegistered(latestSession.email, site.name, { userId, keys }, { rootDir });

      const result = {
        success: true,
        email: latestSession.email,
        username: latestSession.username,
        password: latestSession.password,
        keys: siteResults,
        source: 'stage-b-oauth',
      };
      const uploadInfo = await uploadResult(result, { meta: { source: 'oauth-site', site: site.name } });
      if (uploadInfo?.localFile) localResultFiles.add(uploadInfo.localFile);
      uploaded.push(...siteResults);
      for (const r of siteResults) console.log(`  🎉 ${r.site} [${r.profile || 'default'}] ${r.apiKey.substring(0, 12)}...`);
    } finally {
      releaseSessionSiteLock(lock);
    }
  }

  let apiImport = null;
  if (uploaded.length > 0 && importToApi) {
    if (!String(apiAdminKey || '').trim()) {
      apiImport = { skipped: true, reason: 'API_NSNZD_COM_ADMIN_KEY is not set' };
      console.log('  ⚠️ api.nsnzd.com 导入跳过：API_NSNZD_COM_ADMIN_KEY 未设置');
    } else if (localResultFiles.size === 0) {
      apiImport = { skipped: true, reason: 'no local result file' };
      console.log('  ⚠️ api.nsnzd.com 导入跳过：没有本地结果文件');
    } else {
      apiImport = { attempted: 0, succeeded: 0, failed: 0 };
      for (const resultsFile of localResultFiles) {
        const res = await reuploadUnuploaded({
          resultsFile,
          ledgerFile,
          adminKey: apiAdminKey,
          groupId: uploadGroup?.id,
          groupName: uploadGroup?.name,
          promptGroup: false,
        });
        apiImport.attempted += res.attempted;
        apiImport.succeeded += res.succeeded;
        apiImport.failed += res.failed;
      }
      console.log(`[api.nsnzd.com] import attempted=${apiImport.attempted} succeeded=${apiImport.succeeded} failed=${apiImport.failed}`);
    }
  }

  const out = { success: uploaded.length > 0, results: uploaded, apiImport };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  main().then(r => process.exit(r.success ? 0 : 1)).catch(err => {
    console.error(`❌ [Fatal] ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  main,
  planWork,
  parseArgs,
  resolveSessionProxyUrl,
  isLocalhostProxy,
  normalizeUploadGroup,
  sessionSiteLockPath,
  acquireSessionSiteLock,
  releaseSessionSiteLock,
  isGithubLoginRequiredError,
  isGithubSuspendedError,
};

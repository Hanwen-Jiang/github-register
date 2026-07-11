#!/usr/bin/env node
'use strict';

// refresh-github-sessions.js — decoupled GitHub /login session refresher.
// Reads data/sessions.jsonl records that were marked github_login_required,
// logs in with the stored email/username + password, captures fresh storage_state,
// and appends an updated session record with status=active.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/session-store');
const { resolveChromiumExecutablePath, ensureGithubLoggedIn, isGithubLoggedInUrl } = require('./index');
const { startAuthSocksBridge } = require('./auth-socks-bridge');

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

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseProxyForPlaywright(proxyUrl) {
  const trimmed = String(proxyUrl || '').trim();
  if (!trimmed) return undefined;
  try {
    const u = new URL(trimmed);
    const out = { server: `${u.protocol}//${u.host}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch (_) {
    return { server: trimmed };
  }
}

function isLocalhostProxy(proxyUrl) {
  if (!proxyUrl) return false;
  try {
    const host = new URL(proxyUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch (_) {
    return false;
  }
}

function resolveRefreshProxy(session = {}, env = process.env) {
  const explicit = String(env.GITHUB_LOGIN_PROXY || env.SESSION_REFRESH_PROXY || env.REFRESH_PROXY || '').trim();
  if (explicit) return explicit;
  // Reuse a real upstream proxy if the registration record preserved one. Never
  // reuse browser-local bridge addresses such as 127.0.0.1:2080 from old records.
  if (session.upstream_proxy_url && !isLocalhostProxy(session.upstream_proxy_url)) return session.upstream_proxy_url;
  if (session.proxy_url && !isLocalhostProxy(session.proxy_url)) return session.proxy_url;
  return '';
}

function statusSet(raw = process.env.REFRESH_SESSION_STATUS || process.env.SESSION_REFRESH_STATUS || 'github_login_required') {
  return new Set(String(raw || '').split(',').map(s => s.trim()).filter(Boolean));
}

function isGithubSuspendedError(err) {
  const msg = String(err?.message || err || '');
  return /account\s+(?:has\s+been\s+)?suspended/i.test(msg) ||
    /account[\/_-]suspended/i.test(msg) ||
    /github_(?:account_)?suspended/i.test(msg);
}

function selectRefreshCandidates(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const total = opts.total || Infinity;
  const email = String(opts.email || process.env.REFRESH_SESSION_EMAIL || process.env.SIGNUP_EMAIL || '').trim().toLowerCase();
  const statuses = opts.statuses || statusSet(opts.statusRaw);
  return store.listSessions({ rootDir })
    .filter(s => !email || String(s.email || '').toLowerCase() === email)
    .filter(s => statuses.has(String(s.status || '')))
    .filter(s => String(s.email || '').trim() && String(s.password || '').trim())
    .sort((a, b) => String(a.last_used_at || a.created_at || '').localeCompare(String(b.last_used_at || b.created_at || '')))
    .slice(0, total);
}

function safeProfileName(email) {
  const h = crypto.createHash('sha1').update(String(email || '')).digest('hex').slice(0, 12);
  return `github-refresh-${h}`;
}

async function maybeHandleLoginVerification(page, session, opts = {}) {
  const pollOTP = opts.pollOTP || require('./index').pollOTP;
  const url = page.url();
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');

  if (/two-factor|2fa/i.test(url) || /two-factor|two factor|2FA/i.test(bodyText)) {
    throw new Error('github_login_two_factor_required');
  }

  const otpInput = page.locator('input[name="otp"], input#otp, input[name="code"], input[autocomplete="one-time-code"]').first();
  const hasOtp = await otpInput.isVisible({ timeout: 1500 }).catch(() => false);
  const looksDeviceVerify = /verified-device|device verification|verification code|enter.*code/i.test(url) || /device verification|verification code|enter.*code/i.test(bodyText);
  if (!hasOtp && !looksDeviceVerify) return false;

  const code = await pollOTP(session.email, {
    timeoutMs: Number(process.env.LOGIN_OTP_TIMEOUT_MS || 120000),
    intervalMs: Number(process.env.LOGIN_OTP_INTERVAL_MS || 3000),
  });
  if (!code) throw new Error('github_login_verification_code_timeout');

  if (hasOtp) {
    await otpInput.fill(String(code));
  } else {
    const digits = String(code).replace(/\D/g, '').split('');
    const boxes = await page.locator('input').all();
    if (digits.length && boxes.length >= digits.length) {
      for (let i = 0; i < digits.length; i += 1) await boxes[i].fill(digits[i]);
    } else {
      throw new Error('github_login_verification_input_not_found');
    }
  }

  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  if (await submit.isVisible({ timeout: 2000 }).catch(() => false)) await submit.click();
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return true;
}

async function refreshOneWithBrowser(session, opts = {}) {
  const { chromium } = opts.playwright || require('playwright');
  const headless = opts.headless ?? (process.env.HEADLESS === 'true' || process.env.SESSION_REFRESH_HEADLESS === 'true');
  const rootDir = opts.rootDir || __dirname;
  const profileBase = opts.profileBase || process.env.SESSION_REFRESH_PROFILE_BASE || path.join(os.tmpdir(), 'github-register-refresh-profiles');
  const userDataDir = opts.userDataDir || path.join(profileBase, safeProfileName(session.email));
  const deleteProfile = opts.deleteProfile ?? process.env.SESSION_REFRESH_KEEP_PROFILE !== 'true';
  const proxyUrl = opts.proxyUrl ?? resolveRefreshProxy(session);
  let browserProxyUrl = proxyUrl;
  let proxyBridge = null;

  fs.mkdirSync(userDataDir, { recursive: true });
  if (proxyUrl && /^socks5:\/\/[^@]+@/i.test(proxyUrl)) {
    proxyBridge = await startAuthSocksBridge(proxyUrl);
    browserProxyUrl = proxyBridge.url;
  }

  const launchOpts = {
    headless,
    chromiumSandbox: false,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-crashpad',
    ],
  };
  const executablePath = resolveChromiumExecutablePath();
  if (executablePath) launchOpts.executablePath = executablePath;
  const proxy = parseProxyForPlaywright(browserProxyUrl);
  if (proxy) launchOpts.proxy = proxy;

  let context = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchOpts);
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'zh-CN'] });
    });

    await page.goto('https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fdashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await ensureGithubLoggedIn(page, { email: session.email, username: session.username, password: session.password });
    await maybeHandleLoginVerification(page, session, opts);

    await page.goto('https://github.com/settings/profile', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
    if (!isGithubLoggedInUrl(page.url())) throw new Error(`github_login_failed_url:${page.url()}`);
    const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (isGithubSuspendedError(body) || /\/account\/suspended\b/i.test(page.url())) {
      throw new Error('github_account_suspended');
    }
    if (/Sign in to GitHub|Forgot password\?|Username or email address/i.test(body) && !/Public profile|Your profile/i.test(body)) {
      throw new Error('github_login_failed_still_on_login_page');
    }

    const storageState = await context.storageState();
    const hasUserSession = (storageState.cookies || []).some(c => c.name === 'user_session' || c.name === '__Host-user_session_same_site');
    if (!hasUserSession) throw new Error('github_login_no_user_session_cookie');
    return { storageState, proxyUrl, browserProxyUrl };
  } finally {
    if (context) await context.close().catch(() => {});
    if (proxyBridge) await proxyBridge.close().catch(() => {});
    if (deleteProfile) fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function refreshSessions(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const total = opts.total || num(process.env.REFRESH_SESSION_TOTAL || process.env.SESSION_REFRESH_TOTAL, 1);
  const candidates = opts.candidates || selectRefreshCandidates({ rootDir, total: opts.candidateLimit || Infinity, email: opts.email, statuses: opts.statuses });
  const refreshOne = opts.refreshOne || ((session) => refreshOneWithBrowser(session, { rootDir }));
  const log = opts.log === false ? () => {} : (opts.log || console.log);

  let ok = 0;
  let failed = 0;
  let suspended = 0;
  let attempted = 0;
  for (const session of candidates) {
    if (ok >= total) break;
    attempted += 1;
    log(`[session-refresh] ${attempted}: ${session.email}`);
    try {
      const refreshed = await refreshOne(session);
      store.updateSession(session.email, {
        status: 'active',
        storage_state: refreshed.storageState,
        proxy_url: refreshed.proxyUrl ?? session.proxy_url ?? '',
        upstream_proxy_url: refreshed.proxyUrl ?? session.upstream_proxy_url ?? session.proxy_url ?? '',
        browser_proxy_url: refreshed.browserProxyUrl ?? session.browser_proxy_url ?? '',
        last_error: null,
        refreshed_at: new Date().toISOString(),
      }, { rootDir });
      ok += 1;
      log(`[session-refresh] ok ${session.email} (${ok}/${total})`);
    } catch (err) {
      failed += 1;
      const message = String(err.message || err).slice(0, 500);
      if (isGithubSuspendedError(err)) {
        suspended += 1;
        store.quarantineSuspendedSession(session.email, {
          last_error: message,
          refresh_failed_at: new Date().toISOString(),
        }, { rootDir });
        log(`[session-refresh] suspended ${session.email}: ${message}`);
      } else {
        store.updateSession(session.email, {
          status: 'github_login_failed',
          last_error: message,
          refresh_failed_at: new Date().toISOString(),
        }, { rootDir });
        log(`[session-refresh] fail ${session.email}: ${message}`);
      }
    }
  }
  return { total, ok, failed, attempted, suspended };
}

async function main() {
  loadEnv();
  const total = num(process.env.REFRESH_SESSION_TOTAL || process.env.SESSION_REFRESH_TOTAL, 1);
  const candidates = selectRefreshCandidates({ rootDir: __dirname, total: Infinity });
  console.log(`[session-refresh] candidates=${candidates.length} target_ok=${total}`);
  if (!candidates.length) {
    console.log('[session-refresh] no candidates');
    return { total, ok: 0, failed: 0, attempted: 0, suspended: 0 };
  }
  const res = await refreshSessions({ rootDir: __dirname, total, candidates });
  console.log(`[session-refresh] done target_ok=${res.total} ok=${res.ok} failed=${res.failed} suspended=${res.suspended || 0} attempted=${res.attempted}`);
  if (res.ok < res.total) process.exitCode = 1;
  return res;
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  loadEnv,
  parseProxyForPlaywright,
  isLocalhostProxy,
  resolveRefreshProxy,
  selectRefreshCandidates,
  refreshOneWithBrowser,
  refreshSessions,
  isGithubSuspendedError,
  maybeHandleLoginVerification,
  main,
};

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { siteCreateToken, SITES } = require('./index.js');

const profile = process.env.PROFILE || '.chrome-a6-cid';
const targetName = process.env.SITE || 'cun.ai';
const site = SITES.find(s => s.name.includes(targetName) || s.baseUrl.includes(targetName));
if (!site) throw new Error(`unknown site ${targetName}`);

async function main() {
  const userDataDir = path.resolve(__dirname, profile);
  if (!fs.existsSync(userDataDir)) throw new Error(`missing profile ${userDataDir}`);
  console.log(`[profile] ${userDataDir}`);
  console.log(`[site] ${site.name} ${site.baseUrl}`);

  const launchOpts = {
    headless: process.env.HEADLESS === 'true',
    chromiumSandbox: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
    ],
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  };
  if (process.env.PROXY) launchOpts.proxy = { server: process.env.PROXY };
  if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
  // Use bundled Chromium by default; CHROMIUM_PATH can point to system Chrome on macOS.
  const context = await chromium.launchPersistentContext(userDataDir, launchOpts);
  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
  });

  try {
    console.log('[github] check login');
    await page.goto('https://github.com/settings/profile', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    console.log(`[github] url=${page.url()}`);
    if (page.url().includes('/login')) throw new Error('github profile is not logged in');

    console.log('[site] establish session');
    await page.goto(`${site.baseUrl}/sign-in`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);

    console.log('[site] get oauth state');
    const stateData = await page.evaluate(async (base) => {
      const resp = await fetch(`${base}/api/oauth/state?aff=`);
      return resp.json();
    }, site.baseUrl);
    const state = stateData?.data || '';
    console.log(`[site] state=${state}`);
    if (!state) throw new Error('no oauth state');

    const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${site.clientId}&state=${state}&scope=user:email`;
    console.log('[github] oauth authorize');
    await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);
    console.log(`[github] auth url=${page.url()}`);

    if (page.url().includes('/login')) throw new Error('github session expired at oauth');

    const authBtn = page.locator('button.js-oauth-authorize-btn, button:has-text("Authorize")').first();
    if (await authBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await authBtn.click();
      console.log('[github] clicked authorize');
    } else {
      console.log('[github] no authorize button; maybe auto-authorized');
    }

    const host = new URL(site.baseUrl).hostname;
    await page.waitForURL(url => String(url).includes(host), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log(`[site] callback url=${page.url()}`);

    const cookies = await context.cookies();
    const sessionCookieObj = cookies.find(c => c.name === 'session' && c.domain.includes(host));
    if (!sessionCookieObj) throw new Error(`no ${host} session cookie`);
    const sessionCookie = `${sessionCookieObj.name}=${sessionCookieObj.value}`;
    console.log('[site] session ok');

    let userId = await page.evaluate(async (base) => {
      const sources = [
        () => window.__APP_STATE__?.user?.id,
        () => window.__NUXT__?.state?.user?.id,
        () => document.querySelector('[data-user-id]')?.getAttribute('data-user-id'),
        () => { const s = localStorage.getItem('user'); if (s) try { return JSON.parse(s).id; } catch {} return null; },
      ];
      for (const f of sources) { try { const v = f(); if (v) return v; } catch {} }
      try { const r = await fetch(`${base}/api/user/self`); const j = await r.json(); return j?.data?.id || j?.id || null; } catch { return null; }
    }, site.baseUrl);
    console.log(`[site] userId=${userId}`);
    if (!userId) throw new Error('no userId');

    const apiKey = await siteCreateToken(site, sessionCookie, userId);
    const result = { success: true, profile, site: site.name, baseUrl: site.baseUrl, apiKey, userId };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

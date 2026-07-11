// curl-register.js — Node HTTP GitHub 注册 + new-api OAuth + Token
//
// 零浏览器。http.request + 自研 SOCKS5 agent。2Captcha 自动求解 Funcaptcha。
//
// 用法: PROXY=socks5://user:pass@host:port CAPTCHA_API_KEY=xxx node curl-register.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { init, socksRequest } = require('./socks-agent');
const { tokenEnvDefaults, cunAiTokenEnvDefaults, resolveTokenRemainQuota, resolveTokenUnlimitedQuota } = require('./lib/token-defaults');

// ══════════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════════
(function loadEnv() {
    const ep = path.join(__dirname, '.env');
    if (!fs.existsSync(ep)) return;
    for (const l of fs.readFileSync(ep, 'utf8').split(/\r?\n/)) {
        const t = l.trim(); if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('='); if (i <= 0) continue;
        const k = t.slice(0, i).trim();
        let v = t.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!(k in process.env)) process.env[k] = v;
    }
})();

function maskProxy(proxyUrl) {
    return String(proxyUrl || '').replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:***@');
}

const MAILOPS = (process.env.MAILOPS_BASE_URL || 'https://admin.mailops.nsnzd.com').replace(/\/+$/, '');
const MAILOPS_TOKEN = process.env.MAILOPS_API_TOKEN || '';
const CAPTCHA_KEY = process.env.CAPTCHA_API_KEY || process.env.CAP_2Captcha_KEY || '';
const DOMAIN = process.env.EMAIL_DOMAIN || 'nsnzd.com';
const PASS = process.env.DEFAULT_PASSWORD || '';
if (!PASS) throw new Error('DEFAULT_PASSWORD is required');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const PROXY_URL = process.env.PROXY || '';

if (PROXY_URL) {
    init(PROXY_URL);
    console.log(`[Proxy] ${maskProxy(PROXY_URL)}`);
} else {
    console.log('[Proxy] 直连（未设置 PROXY）');
}

async function request(url, opts = {}) {
    if (PROXY_URL) return socksRequest(url, opts);
    return fetch(url, opts);
}

const SITES = [
    { name: 'cun.ai', base: 'https://www.cun.ai', clientId: 'Ov23lipURdGRYDGN2jII', ...cunAiTokenEnvDefaults(process.env, 'claude') },
    { name: 'a6api',  base: 'https://a6api.com',  clientId: 'Ov23ligFZ3T5H8HuvWO9', ...tokenEnvDefaults(process.env, 'claude') },
];
const TARGET = (process.env.SITE || '').trim()
    ? SITES.filter(s => s.name.includes(process.env.SITE) || s.base.includes(process.env.SITE))
    : SITES;

// PROXY 有值就走 socks-agent；没值就直连 fetch。

// ══════════════════════════════════════════════════════════
// HTTP helpers (http.request + SOCKS5 agent)
// ══════════════════════════════════════════════════════════
class CookieJar {
    constructor() { this.map = new Map(); }
    load(headers) {
        if (!headers) return;
        const getSC = () => {
            if (typeof headers.get === 'function') return headers.get('set-cookie');
            return headers['set-cookie'] || headers['Set-Cookie'] || '';
        };
        const raw = getSC();
        if (!raw) return;
        const m = String(raw).match(/^([^=;]+)=([^;]*)/);
        if (m) this.map.set(m[1].trim(), m[2]);
    }
    toString() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function hGet(url, jar, extraHdrs = {}) {
    const headers = { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9', ...extraHdrs };
    if (jar && jar.toString()) headers['cookie'] = jar.toString();
    const resp = await request(url, { headers });
    if (jar) jar.load(resp.headers);
    return resp;
}

async function hPost(url, jar, body, extraHdrs = {}, isForm = true) {
    const headers = {
        'user-agent': UA, 'accept': 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9',
        ...(isForm ? { 'content-type': 'application/x-www-form-urlencoded' } : { 'content-type': 'application/json' }),
        ...extraHdrs,
    };
    if (jar && jar.toString()) headers['cookie'] = jar.toString();
    const bodyStr = isForm ? new URLSearchParams(body).toString() : JSON.stringify(body);
    const resp = await request(url, { method: 'POST', headers, body: bodyStr });
    if (jar) jar.load(resp.headers);
    return resp;
}

async function hGetJson(url, jar, extraHdrs = {}) {
    const r = await hGet(url, jar, { ...extraHdrs, 'accept': 'application/json' });
    return r.json();
}

function hLoc(resp) { return resp.headers['location'] || resp.headers['Location'] || ''; }

// ══════════════════════════════════════════════════════════
// Name gen + 2Captcha + Mailops
// ══════════════════════════════════════════════════════════
const SURNAMES = ['li','wang','zhang','liu','chen','yang','huang','zhao','wu','zhou','xu','sun','ma','zhu','hu','guo','he','gao','lin','luo'];
const GIVEN = ['alan','emma','james','lisa','david','sarah','michael','jennifer','robert','amanda','william','jessica','daniel','amy','matthew','rachel','andrew','laura','kevin','megan','jason','ashley','brian','steven','melissa','mark','paul','george','kenneth','samantha'];
const pick = a => a[crypto.randomInt(a.length)];
const genId = () => { const s = pick(SURNAMES), g = pick(GIVEN); return { email: `${g}.${s}@${DOMAIN}`, username: `nsnzd-${g}${s}`, password: PASS }; };

async function solveFc(pubKey, pageUrl) {
    if (!CAPTCHA_KEY) return null;
    console.log('  [Captcha] Funcaptcha → 2Captcha...');
    const c = await hPost('https://api.2captcha.com/createTask', null, {
        clientKey: CAPTCHA_KEY,
        task: { type: 'FunCaptchaTaskProxyless', websiteURL: pageUrl, websitePublicKey: pubKey, funcaptchaApiJSSubdomain: '', data: JSON.stringify({ blob: '' }) },
    }, {}, false);
    const cj = c.json();
    if (!cj || cj.errorId !== 0) { console.log('  createTask failed'); return null; }
    const taskId = cj.taskId;
    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const r = await hPost('https://api.2captcha.com/getTaskResult', null, { clientKey: CAPTCHA_KEY, taskId }, {}, false);
        const rj = r.json();
        if (rj?.status === 'ready') { console.log('  ✅ solved'); return rj.solution.token; }
        if (rj?.errorId !== 0) return null;
    }
    return null;
}

async function pollOTP(email) {
    const enc = encodeURIComponent(email);
    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const r = await request(`${MAILOPS}/admin/api/v1/otp-records?recipient_address=${enc}&page=1&page_size=5`, {
                headers: { 'Authorization': `Bearer ${MAILOPS_TOKEN}` },
            });
            const items = r.json()?.data?.items || [];
            const rec = items.find(r => (r?.recipient_address || '').toLowerCase() === email.toLowerCase());
            if (rec?.otp) { console.log(`  ✅ OTP: ${rec.otp}`); return rec.otp; }
        } catch (_) {}
    }
    throw new Error('OTP timeout');
}

// ══════════════════════════════════════════════════════════
// GitHub signup + login
// ══════════════════════════════════════════════════════════
async function githubSignup(id) {
    const jar = new CookieJar();
    console.log(`\n── GitHub: ${id.email} ──`);

    // 1. signup page
    console.log('  [1/4] signup page...');
    let resp = await hGet('https://github.com/signup?source=form-home-signup', jar);
    let html = resp.text();
    const csrf = (html.match(/name="authenticity_token" value="([^"]+)"/) || [])[1];
    if (!csrf) throw new Error('no CSRF');
    const fcKey = (html.match(/public_key["\s:=]+([A-F0-9-]{36})/i) || [])[1];

    // 2. POST signup
    console.log('  [2/4] submit...');
    const body = {
        'authenticity_token': csrf, 'user[email]': id.email, 'user[password]': id.password,
        'user[login]': id.username, 'source': 'form-home-signup',
    };
    if (fcKey && CAPTCHA_KEY) body['captcha_token'] = await solveFc(fcKey, 'https://github.com/signup');

    resp = await hPost('https://github.com/signup?social=false', jar, body,
        { referer: 'https://github.com/signup?source=form-home-signup' });
    let loc = hLoc(resp);
    console.log(`  → ${resp.status} ${loc}`);
    if (!loc?.includes('account_verifications')) throw new Error(`signup failed: ${resp.status}`);
    console.log('  ✅ registered');

    // 3. verification
    console.log('  [3/4] verification...');
    resp = await hGet(loc, jar);
    loc = hLoc(resp);
    console.log(`  → ${resp.status} ${loc || '(stay)'}`);

    // 302 => auto-verified
    if (resp.status === 302 && loc) {
        for (let i = 0; i < 3 && loc; i++) { resp = await hGet(loc, jar); loc = hLoc(resp); }
        console.log('  ✅ auto-verified');
        return jar;
    }

    // 200 => need OTP or auto-logged-in
    html = resp.text();
    const hasOtpForm = html.includes('launch-code') || html.includes('launch_code');
    const vCsrf = (html.match(/name="authenticity_token" value="([^"]+)"/) || [])[1];

    if (hasOtpForm && vCsrf) {
        console.log('  [4/4] OTP...');
        const otp = await pollOTP(id.email);
        const oBody = { 'authenticity_token': vCsrf };
        otp.split('').forEach((d, i) => oBody[`launch_code[]`] = d);
        await hPost('https://github.com/account_verifications', jar, oBody,
            { referer: 'https://github.com/account_verifications' });
        console.log('  ✅ OTP done');
    } else {
        // Maybe already logged in — try settings page
        resp = await hGet('https://github.com/settings/profile', jar);
        if (resp.status === 200 && resp.text().includes('profile')) {
            console.log('  ✅ already logged in');
            return jar;
        }
        // Try login with credentials
        console.log('  [4/4] login...');
        resp = await hGet('https://github.com/login', jar);
        const lCsrf = (resp.text().match(/name="authenticity_token" value="([^"]+)"/) || [])[1];
        if (!lCsrf) throw new Error('no login CSRF');
        resp = await hPost('https://github.com/session', jar, {
            'authenticity_token': lCsrf, 'login': id.email, 'password': id.password, 'commit': 'Sign in',
        }, { referer: 'https://github.com/login' });
        if (resp.status !== 302) throw new Error('login failed');
    }

    console.log('  ✅ GitHub done');
    return jar;
}

// ══════════════════════════════════════════════════════════
// new-api OAuth + Token
// ══════════════════════════════════════════════════════════
async function siteOAuth(site, ghJar) {
    console.log(`\n── ${site.name} ──`);

    // session + state
    await hGet(`${site.base}/sign-in`, null);
    const sd = await hGetJson(`${site.base}/api/oauth/state?aff=`);
    const state = sd?.data;
    if (!state) throw new Error('no state');
    console.log(`  state: ${state}`);

    // GitHub authorize
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${site.clientId}&state=${state}&scope=user:email`;
    let resp = await hGet(authUrl, ghJar);
    let html = resp.text();

    if (resp.status === 302 || (html.includes('/login') && !html.includes('/oauth')))
        throw new Error('GitHub session expired');

    const authCsrf = (html.match(/name="authenticity_token" value="([^"]+)"/) || [])[1];
    if (authCsrf) {
        console.log('  authorize...');
        resp = await hPost('https://github.com/login/oauth/authorize', ghJar, {
            'authenticity_token': authCsrf, 'client_id': site.clientId, 'state': state, 'scope': 'user:email', 'authorize': '1',
        }, { referer: authUrl });
    }

    // follow callback
    let loc = hLoc(resp);
    for (let i = 0; i < 5 && loc; i++) {
        resp = await hGet(loc, null); loc = hLoc(resp);
    }
    console.log(`  callback done`);

    // user ID
    const self = await hGetJson(`${site.base}/api/user/self`);
    const userId = self?.data?.id;
    if (!userId) throw new Error('no userId');
    console.log(`  userId: ${userId}`);

    // create token
    console.log('  creating token...');
    const ah = { 'new-api-user': String(userId), 'origin': site.base, 'referer': `${site.base}/keys` };

    const cr = await hPost(`${site.base}/api/token/`, null, {
        name: site.tokenName || 'claude',
        remain_quota: resolveTokenRemainQuota(site),
        expired_time: site.tokenExpiredTime ?? -1,
        unlimited_quota: resolveTokenUnlimitedQuota(site),
        model_limits_enabled: false, model_limits: '', allow_ips: '', group: 'default', cross_group_retry: false,
    }, ah, false);
    const cd = cr.json();
    if (!cd?.success) throw new Error(`token create: ${cd?.message}`);

    const lr = await hGet(`${site.base}/api/token/?p=1&size=20`, null, { ...ah, accept: 'application/json' });
    const items = lr.json()?.data?.items || [];
    const latest = items.reduce((a, b) => a.created_time > b.created_time ? a : b);

    const kr = await hPost(`${site.base}/api/token/${latest.id}/key`, null, {}, { ...ah, 'content-length': '0' }, false);
    const key = `sk-${kr.json().data.key}`;
    console.log(`  🎉 ${key}`);
    return { site: site.name, apiKey: key, userId };
}

// ══════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════
async function main() {
    const id = genId();
    const started = Date.now();

    console.log('═══════════════════════════════════════');
    console.log('  curl-level GitHub Register');
    console.log('═══════════════════════════════════════');
    console.log(`  ${id.email} / ${id.username}`);
    console.log('═══════════════════════════════════════');

    const ghJar = await githubSignup(id);

    console.log(`\n── OAuth (${TARGET.length} sites) ──`);
    const results = [];
    for (const s of TARGET) {
        try { results.push(await siteOAuth(s, ghJar)); }
        catch (e) { console.log(`  ❌ ${s.name}: ${e.message}`); }
    }

    const dur = ((Date.now() - started) / 1000).toFixed(1);
    console.log('\n═══════════════════════════════════════');
    console.log('  🎉 Done!');
    console.log(`  ${id.email} / ${id.password}`);
    results.forEach(r => console.log(`  [${r.site}] ${r.apiKey}`));
    console.log(`  ${dur}s`);
    console.log('═══════════════════════════════════════');

    return { identity: id, results, durationSeconds: parseFloat(dur) };
}

if (require.main === module) {
    main().then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
        .catch(e => { console.error(`\n❌ ${e.message}`); process.exit(1); });
}
module.exports = { main, githubSignup, siteOAuth, genId, CookieJar };

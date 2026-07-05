// github-register — GitHub 注册 + cun.ai OAuth 自动化
//
// 参考 codex-auth 的实现模式：
//   1. Playwright headful 反检测浏览器
//   2. human.js 真人键入/点击/延时模拟
//   3. IP 代理池轮换（单代理 / 代理列表随机选择）
//   4. 指纹模拟（locale、viewport、disable-blink-features）
//
// 流程：
//   GitHub 注册 → 邮箱 OTP 验证 → 登录 → cun.ai OAuth → 创建 API Token
//
// 用法：
//   node index.js                          # 单次注册
//   PROXY=http://127.0.0.1:7890 node index.js  # 指定代理
//   HEADLESS=true node index.js            # 无头模式（调试用）

// playwright is required lazily inside registerGithubAccount so that index.js can be
// imported for its pure functions (siteCreateToken, generateIdentity, ...) in
// environments without playwright installed (e.g. local unit tests).
const { humanDelay, humanType, humanClick, humanTypeOTP, humanScroll } = require('./human');
const { checkAndSolveCaptcha } = require('./captcha');
const { startAuthSocksBridge } = require('./auth-socks-bridge');
const { runSitesOAuthHttp } = require('./lib/hybrid-oauth');
const { uploadResult } = require('./lib/result-uploader');
const identityGen = require('./lib/identity');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ──────────────────────────────────────────────────────────
// 1. 加载 .env 配置
// ──────────────────────────────────────────────────────────
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = val;
    }
}
loadEnv();

const CONFIG = {
    mailopsBaseUrl: (process.env.MAILOPS_BASE_URL || 'https://admin.mailops.nsnzd.com').replace(/\/+$/, ''),
    mailopsApiToken: process.env.MAILOPS_API_TOKEN || '',
    emailDomains: (process.env.EMAIL_DOMAINS || process.env.EMAIL_DOMAIN || 'nsnzd.com').split(',').map(s => s.trim()).filter(Boolean),
    defaultPassword: process.env.DEFAULT_PASSWORD || '',
    cunaiBaseUrl: (process.env.CUNAI_BASE_URL || 'https://www.cun.ai').replace(/\/+$/, ''),
    headless: process.env.HEADLESS === 'true',
    proxy: process.env.PROXY || '',
    proxyList: process.env.PROXY_LIST || '',
    tokenName: process.env.TOKEN_NAME || 'claude',
    tokenUnlimitedQuota: process.env.TOKEN_UNLIMITED_QUOTA !== 'false',
    tokenExpiredTime: parseInt(process.env.TOKEN_EXPIRED_TIME || '-1', 10),
    tokenRemainQuota: parseInt(process.env.TOKEN_REMAIN_QUOTA || '0', 10),
    hybridHttpOAuth: process.env.HYBRID_HTTP_OAUTH !== 'false',
};

// ──────────────────────────────────────────────────────────
// 目标站点 + 路由 profiles（迁至 lib/sites.js，playwright-free）
// ──────────────────────────────────────────────────────────
const { SITES, TARGET_SITES, DEFAULT_ROUTING_PROFILES, resolveRoutingProfiles } = require('./lib/sites');
const routingProfiles = resolveRoutingProfiles();

// ──────────────────────────────────────────────────────────
// 2. 姓名生成器（中文姓氏 + 西式名字 → 真人感邮箱）
// ──────────────────────────────────────────────────────────
const SURNAMES = [
    'li', 'wang', 'zhang', 'liu', 'chen', 'yang', 'huang', 'zhao',
    'wu', 'zhou', 'xu', 'sun', 'ma', 'zhu', 'hu', 'guo', 'he',
    'gao', 'lin', 'luo', 'liang', 'song', 'zheng', 'xie', 'han',
    'tang', 'feng', 'yu', 'dong', 'xiao', 'cheng', 'cao', 'yuan',
    'deng', 'xu2', 'fu', 'shen', 'zeng', 'peng', 'lu', 'su',
];

const GIVEN_NAMES = [
    'alan', 'emma', 'james', 'lisa', 'david', 'sarah', 'michael',
    'jennifer', 'robert', 'amanda', 'william', 'jessica', 'richard',
    'elizabeth', 'joseph', 'michelle', 'thomas', 'stephanie', 'daniel',
    'amy', 'matthew', 'rachel', 'andrew', 'laura', 'kevin', 'megan',
    'jason', 'ashley', 'brian', 'kimberly', 'steven', 'melissa',
    'mark', 'rebecca', 'paul', 'katherine', 'george', 'christine',
    'kenneth', 'samantha', 'anthony', 'danielle', 'edward', 'heather',
    'ronald', 'amber', 'patrick', 'maria', 'jack', 'sandra', 'dennis',
    'olivia', 'jerry', 'victoria', 'tyler', 'natalie', 'aaron', 'grace',
    'henry', 'chloe', 'douglas', 'hannah', 'peter', 'isabella', 'frank',
    'zoe', 'adam', 'lily', 'nathan', 'ella', 'bryan', 'mia', 'sean',
    'sophia', 'ethan', 'ava', 'brandon', 'madison', 'alexander', 'layla',
];

function randomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// QQ email pool (loaded once)
let _qqEmails = [];
function loadQQEmails() {
    if (_qqEmails.length > 0) return _qqEmails;
    const qqPath = process.env.QQ_EMAIL_FILE || '/app/qq-email/100.txt';
    try {
        _qqEmails = require('fs').readFileSync(qqPath, 'utf8')
            .split(/\r?\n/).map(l => l.trim()).filter(l => l.includes('@'));
    } catch (_) { /* fallback to nsnzd.com */ }
    return _qqEmails;
}

let _usedEmails = new Set();

function randomGithubUsername() {
    return identityGen.generateUsername();
}

function assertSafeGithubUsername(username) {
    const u = String(username || '').trim().toLowerCase();
    if (!u.startsWith('nsnzd-')) throw new Error(`unsafe_github_username_must_start_nsnzd: ${username}`);
    if (/^(a6|a6a|a6api|cun|cun-ai|cun\.ai)$/i.test(u) || /^(nsnzd-)?(a6|a6a|a6api|cun|cun-ai)$/i.test(u)) {
        throw new Error(`unsafe_github_username_site_prefix: ${username}`);
    }
    if (!/^[a-z][a-z0-9-]{2,38}$/.test(u) || u.endsWith('-')) throw new Error(`unsafe_github_username_format: ${username}`);
    return u;
}

async function fillExact(page, selector, value, label) {
    const expected = String(value);
    const el = typeof selector === 'string' ? page.locator(selector).first() : selector;
    for (let attempt = 1; attempt <= 3; attempt++) {
        await el.waitFor({ state: 'visible', timeout: 30000 });
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ clickCount: 3 }).catch(() => el.click({ force: true }));
        await el.fill('');
        await el.fill(expected);
        await el.evaluate((input, v) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, v);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
        }, expected).catch(() => {});
        await humanDelay(250, 650);
        const actual = await el.inputValue().catch(() => '');
        if (actual === expected) return;
        console.log(`  ⚠️ ${label || '字段'} 第 ${attempt} 次填充不完整: ${actual} != ${expected}`);
    }
    const actual = await el.inputValue().catch(() => '');
    throw new Error(`exact_fill_failed_${label || 'field'}: ${actual} != ${expected}`);
}

async function detectEmailCollision(page) {
    // GitHub shows an inline validation message under the email field when the
    // address is already associated with an account. Poll briefly (validation is
    // async/AJAX). Returns the matched message string, or '' when no collision.
    const deadline = Date.now() + 4000;
    const re = /already\s+(associated|taken|in use)|associated with an account|already\s+registered/i;
    while (Date.now() < deadline) {
        const texts = await page.locator(
            '#email-err, #login-err, [role="alert"], .flash-error, .error, .form-group.errored .note'
        ).allTextContents().catch(() => []);
        const hit = texts.map(t => String(t || '').trim()).find(t => re.test(t));
        if (hit) return hit;
        // If the password container has already appeared, the email passed validation.
        const advanced = await page.locator('input#password, input[name="user[password]"]')
            .first().isVisible({ timeout: 250 }).catch(() => false);
        if (advanced) return '';
        await humanDelay(200, 400);
    }
    return '';
}

async function submitCreateAccountTwiceIfNeeded(page) {
    const submitBtn = page.locator('button[data-disable-invalid="true"]:has-text("Create account")').first();
    await dismissGitHubCookieBanner(page);
    for (let attempt = 1; attempt <= 2; attempt++) {
        await submitBtn.waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForFunction(() => {
            const btn = Array.from(document.querySelectorAll('button[data-disable-invalid="true"]'))
                .find(b => /Create account/i.test(b.textContent || ''));
            return btn && !btn.disabled;
        }, { timeout: 10000 }).catch(() => {});
        await dismissGitHubCookieBanner(page);
        await submitBtn.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
        await humanDelay(150, 400);
        console.log(`  点击 Create account (${attempt}/2)...`);
        await humanClick(page, submitBtn);
        const jumped = await page.waitForFunction(
            () => !window.location.href.includes('/signup'),
            { timeout: attempt === 1 ? 8000 : 15000 }
        ).then(() => true).catch(() => false);
        if (jumped) {
            console.log(`  ✅ 页面已跳转: ${page.url()}`);
            return true;
        }
        console.log(`  ⚠️ 第 ${attempt} 次点击后仍在: ${page.url()}`);
        await dismissGitHubCookieBanner(page);
        await humanDelay(900, 2200);
    }
    return false;
}

function generateIdentity() {
    // Email may be specified by SIGNUP_EMAIL/CUSTOM_EMAIL, but GitHub username is always nsnzd-random.
    const customEmail = process.env.SIGNUP_EMAIL || process.env.CUSTOM_EMAIL || '';
    let email = customEmail;
    // Persistent de-dup: seed used emails/usernames from results.jsonl + sessions.jsonl
    // so restarts never regenerate an already-registered identity ("email already
    // associated" collisions). In-memory _usedEmails guards within a single run.
    const used = identityGen.loadUsed({ rootDir: __dirname });
    for (const e of _usedEmails) used.emails.add(String(e).toLowerCase());
    if (!email) {
        const qq = loadQQEmails();
        if (qq.length > 0) {
            const available = qq.filter(e => !used.emails.has(String(e).toLowerCase()));
            email = available.length > 0 ? randomItem(available) : randomItem(qq);
        } else {
            email = identityGen.generateUniqueEmail(used, { domain: pickEmailDomain() });
        }
    }
    _usedEmails.add(email);
    // 校验邮箱域名在白名单内（白名单 = CONFIG.emailDomains，16个mailops域名）
    const emailLower = String(email).toLowerCase();
    const domainOk = CONFIG.emailDomains.some(d => emailLower.endsWith(`@${d.toLowerCase()}`));
    if (!domainOk) {
        throw new Error(`SIGNUP_EMAIL domain not in whitelist (EMAIL_DOMAINS): ${email}`);
    }
    if (!CONFIG.defaultPassword) {
        throw new Error('DEFAULT_PASSWORD is required');
    }
    const rawUsername = process.env.SIGNUP_USERNAME || identityGen.generateUniqueUsername(used);
    const username = assertSafeGithubUsername(rawUsername);
    return { email, username, password: CONFIG.defaultPassword };
}

// ──────────────────────────────────────────────────────────
// 3. 代理池轮换
// ──────────────────────────────────────────────────────────
function pickProxy() {
    // 优先用 PROXY_LIST（代理池）
    if (CONFIG.proxyList) {
        const proxies = CONFIG.proxyList.split(',').map(s => s.trim()).filter(Boolean);
        if (proxies.length > 0) {
            const picked = randomItem(proxies);
            console.log(`[Proxy] 从代理池 (${proxies.length}个) 随机选择: ${maskProxy(picked)}`);
            return picked;
        }
    }
    // 其次用 PROXY（单代理）
    if (CONFIG.proxy) {
        console.log(`[Proxy] 单代理: ${maskProxy(CONFIG.proxy)}`);
        return CONFIG.proxy;
    }
    console.log('[Proxy] 直连（无代理）');
    return null;
}

// Return up to n DISTINCT random proxies from the pool (for failover). Falls back
// to [CONFIG.proxy] when no pool, or [] when neither is set (caller adds direct).
function pickProxies(n = 3) {
    if (CONFIG.proxyList) {
        const all = CONFIG.proxyList.split(',').map(s => s.trim()).filter(Boolean);
        if (all.length > 0) {
            // Fisher–Yates shuffle a copy, take first n.
            const pool = all.slice();
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            return pool.slice(0, Math.min(n, pool.length));
        }
    }
    if (CONFIG.proxy) return [CONFIG.proxy];
    return [];
}

function pickEmailDomain() {
    const all = CONFIG.emailDomains;
    if (all.length === 0) return 'nsnzd.com'; // 万一配置清空，fallback
    return randomItem(all);
}

function maskProxy(proxyUrl) {
    return String(proxyUrl || '').replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:***@');
}

async function dismissGitHubCookieBanner(page, opts = {}) {
    const selectors = [
        'button:has-text("Reject")',
        'button:has-text("Reject optional cookies")',
        'button:has-text("Decline")',
        'button:has-text("Accept")',
    ];
    const timeout = opts.timeoutMs ?? 800;
    const delay = opts.delay || humanDelay;

    for (const selector of selectors) {
        const button = page.locator(selector).first();
        const visible = await button.isVisible({ timeout }).catch(() => false);
        if (!visible) continue;
        try {
            await button.click({ force: true });
        } catch (err) {
            try {
                await humanClick(page, button);
            } catch (_) {
                throw err;
            }
        }
        if (!opts.quiet) console.log('  ✅ GitHub cookies 横幅已关闭');
        await delay(150, 450);
        return true;
    }

    return false;
}

function parseProxyForPlaywright(proxyUrl) {
    if (!proxyUrl) return undefined;
    const trimmed = String(proxyUrl).trim();
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

// Launch a persistent Chrome context bound to `proxyUrl` (null = direct). Returns
// { context, page, proxyBridge, browserProxyUrl }. Caller closes context + bridge.
// Used by registerGithubAccount's proxy-failover loop.
async function launchBrowserForProxy(chromium, proxyUrl, userDataDir, viewport) {
    let browserProxyUrl = proxyUrl;
    let proxyBridge = null;
    if (proxyUrl && /^socks5:\/\/[^@]+@/i.test(proxyUrl)) {
        proxyBridge = await startAuthSocksBridge(proxyUrl);
        browserProxyUrl = proxyBridge.url;
        console.log(`[Proxy] 浏览器本地桥: ${browserProxyUrl} -> ${maskProxy(proxyUrl)}`);
    }
    const proxy = parseProxyForPlaywright(browserProxyUrl);

    const launchOpts = {
        headless: CONFIG.headless,
        chromiumSandbox: false,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-infobars',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-dev-shm-usage',
            '--disable-crashpad',
        ],
        viewport,
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        bypassCSP: false,
    };
    if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
    if (proxy) launchOpts.proxy = proxy;

    const context = await chromium.launchPersistentContext(userDataDir, launchOpts);
    const page = await context.newPage();
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'zh-CN'] });
    });
    return { context, page, proxyBridge, browserProxyUrl };
}

// True if an error looks like a proxy/connection failure worth failing over from.
function isProxyConnError(err) {
    const m = String((err && err.message) || err || '');
    return /ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT)|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_NAME_NOT_RESOLVED|socks|proxy/i.test(m);
}

// ──────────────────────────────────────────────────────────
// 4. Mailops API 操作（Bearer Token 鉴权）
// ──────────────────────────────────────────────────────────
function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

async function mailopsFetch(path) {
    const token = process.env.MAILOPS_API_TOKEN || '';
    if (!token) throw new Error('MAILOPS_API_TOKEN is required');
    if (process.env.MAILOPS_VIA_SSH === 'true') {
        const url = `https://admin.mailops.nsnzd.com${path}`;
        const remoteScript = [
            'curl', '-k', '-fsS', '--connect-timeout', '10', '--max-time', '30',
            shellQuote(url),
            '-H', shellQuote(`Authorization: Bearer ${token}`),
            '-H', shellQuote('Accept: application/json'),
        ].join(' ');
        const out = execFileSync('ssh', [
            '-i', process.env.REMOTE_SSH_KEY || `${process.env.HOME}/.ssh/jhw.pem`,
            '-o', 'StrictHostKeyChecking=no',
            process.env.REMOTE_SSH || 'root@186.244.238.119',
            remoteScript,
        ], { encoding: 'utf8', timeout: 45000 });
        const jsonStart = out.indexOf('{');
        return JSON.parse(jsonStart >= 0 ? out.slice(jsonStart) : out);
    }
    const url = `${CONFIG.mailopsBaseUrl}${path}`;
    const out = execFileSync('curl', [
        '-fsS', '--connect-timeout', '10', '--max-time', '30',
        url,
        '-H', `Authorization: Bearer ${token}`,
        '-H', 'Accept: application/json',
    ], { encoding: 'utf8', timeout: 45000 });
    const jsonStart = out.indexOf('{');
    return JSON.parse(jsonStart >= 0 ? out.slice(jsonStart) : out);
}

/**
 * 轮询获取指定邮箱的 OTP 验证码
 * @param {string} email - 目标邮箱
 * @param {object} opts - { timeoutMs, intervalMs }
 * @returns {string|null} OTP 码或 null
 */
async function pollOTP(email, opts = {}) {
    const { timeoutMs = 120_000, intervalMs = 3_000 } = opts;
    const deadline = Date.now() + timeoutMs;
    const encodedEmail = encodeURIComponent(email);

    console.log(`  [Mailops] 开始轮询 ${email} 的验证码...`);

    while (Date.now() < deadline) {
        try {
            const data = await mailopsFetch(
                `/admin/api/v1/otp-records?recipient_address=${encodedEmail}&page=1&page_size=5`
            );
            const items =
                data?.data?.items ||
                data?.data?.records ||
                data?.items ||
                [];
            const record = items.find(r => {
                const addr = String(
                    r?.recipient_address || r?.email || r?.to || r?.recipient || ''
                ).toLowerCase();
                return addr === email.toLowerCase();
            });
            if (record) {
                const code = record.otp || record.code || record.otp_code || record.verification_code;
                if (code) {
                    console.log(`  [Mailops] ✅ 获取到验证码: ${code}`);
                    return String(code);
                }
            }
        } catch (e) {
            console.log(`  [Mailops] 请求失败，重试中: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    console.log(`  [Mailops] ❌ 超时未获取到验证码`);
    return null;
}

// ──────────────────────────────────────────────────────────
// 5. cun.ai API 操作（需要 session cookie）
// ──────────────────────────────────────────────────────────
async function siteCreateToken(site, sessionCookie, userId, profile = null) {
    const base = site.baseUrl;
    console.log(`\n━━━ 📡 ${site.name} — 创建 API Token ━━━`);

    const apiHeaders = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'new-api-user': String(userId),
        'Origin': base,
        'Referer': `${base}/keys`,
    };

    const createBody = {
        name: profile ? `${profile.name}-${site.tokenName || 'claude'}` : (site.tokenName || 'claude'),
        remain_quota: site.tokenRemainQuota ?? 0,
        expired_time: site.tokenExpiredTime ?? -1,
        unlimited_quota: site.tokenUnlimitedQuota ?? true,
        model_limits_enabled: false,
        model_limits: '',
        allow_ips: '',
        group: 'default',
        cross_group_retry: false,
        // Routing fields (only if profile provided)
        ...(profile ? {
            routing_enabled: profile.routing_enabled ?? true,
            routing_preference: profile.routing_preference || 'cheap',
            pricing_strategy: profile.pricing_strategy || 'auto',
            pricing_custom_pct: profile.pricing_custom_pct || 50,
            routing_allow_fallback: profile.routing_allow_fallback ?? true,
        } : {}),
    };

    console.log(`  POST ${base}/api/token/`);
    const createResp = await fetch(`${base}/api/token/`, {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify(createBody),
    });
    const createJson = await createResp.json();
    if (!createJson.success) {
        throw new Error(`创建 token 失败: ${JSON.stringify(createJson)}`);
    }
    console.log(`  ✅ Token 创建成功`);

    // 5.2 查询 token 列表获取 id
    console.log('  GET /api/token/?p=1&size=20');
    const listResp = await fetch(`${base}/api/token/?p=1&size=20`, {
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Cookie': sessionCookie,
            'new-api-user': String(userId),
            'Referer': `${base}/keys`,
        },
    });
    const listJson = await listResp.json();
    const items = listJson?.data?.items || [];
    if (items.length === 0) {
        throw new Error('token 列表为空');
    }
    // 取最新的 token
    const latestToken = items.reduce((a, b) =>
        (a.created_time > b.created_time) ? a : b
    );
    console.log(`  Token ID: ${latestToken.id} (name: ${latestToken.name})`);

    // 5.3 获取完整 key
    console.log(`  POST /api/token/${latestToken.id}/key`);
    const keyResp = await fetch(`${base}/api/token/${latestToken.id}/key`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Length': '0',
            'Cookie': sessionCookie,
            'new-api-user': String(userId),
            'Origin': base,
            'Referer': `${base}/keys`,
        },
    });
    const keyJson = await keyResp.json();
    if (!keyJson.success || !keyJson.data?.key) {
        throw new Error(`获取 key 失败: ${JSON.stringify(keyJson)}`);
    }
    const fullKey = `sk-${keyJson.data.key}`;
    return { apiKey: fullKey, profile: profile ? profile.name : null };
}


function isGithubLoggedInUrl(url) {
    const u = String(url || '');
    if (!u.includes('github.com')) return false;
    if (u.includes('/login') || u.includes('/signup') || u.includes('/account_verifications')) return false;
    return true;
}

async function ensureGithubLoggedIn(page, identity) {
    let currentUrl = page.url();
    console.log(`  当前 URL: ${currentUrl}`);
    if (!isGithubLoggedInUrl(currentUrl)) {
        console.log('  需要登录，填写凭据...');
        if (!currentUrl.includes('/login')) {
            await page.goto('https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fdashboard', {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
            await humanDelay(600, 1800);
        }
        await fillExact(page, 'input#login_field, input[name="login"]', identity.email, 'github_login_email');
        await fillExact(page, 'input#password, input[name="password"]', identity.password, 'github_login_password');
        await humanClick(page, 'input[type="submit"][value="Sign in"], button[type="submit"]');
        await humanDelay(2000, 6000);
    }
    console.log(`  ✅ 已登录 GitHub: ${page.url()}`);
}

// ──────────────────────────────────────────────────────────
// 6. 主流程
// ──────────────────────────────────────────────────────────

// Honor the server-side Python contract (scripts/oauth_dynamic_registrar.py passes
// these env vars). Local runs set none of them → behavior is unchanged.
function applyServerEnvContract() {
    // Python points the persistent profile via PROFILE_DIR; index.js reads CHROME_PROFILE_DIR.
    if (process.env.PROFILE_DIR && !process.env.CHROME_PROFILE_DIR) {
        process.env.CHROME_PROFILE_DIR = process.env.PROFILE_DIR;
    }
    // Password may arrive as SIGNUP_PASSWORD; fold into CONFIG.defaultPassword.
    if (!CONFIG.defaultPassword && process.env.SIGNUP_PASSWORD) {
        CONFIG.defaultPassword = process.env.SIGNUP_PASSWORD;
    }
}

// Phase 1-4: register a GitHub account (or fail) and return the LIVE browser handles
// plus captured storageState. Does NOT write/delete cookie files and does NOT run
// OAuth — the caller decides whether to continue to Phase 5 (main) or persist the
// session and close (register-github.js). On failure it closes the context/bridge.
//
// Returns { identity, storageState, context, page, proxyUrl, proxyBridge }.
async function registerGithubAccount(opts = {}) {
    const { chromium } = require('playwright');
    applyServerEnvContract();
    let identity = opts.identity || generateIdentity();

    console.log('═══════════════════════════════════════════');
    console.log('  GitHub 注册（Stage A / Phase 1-4）');
    console.log('═══════════════════════════════════════════');
    console.log(`  邮箱:     ${identity.email}`);
    console.log(`  用户名:   ${identity.username}`);
    console.log(`  密码:     ${identity.password.replace(/./g, '*')}`);
    console.log('═══════════════════════════════════════════\n');

    // 随机 viewport（增加指纹多样性）
    const viewports = [
        { width: 1440, height: 900 },
        { width: 1536, height: 864 },
        { width: 1366, height: 768 },
        { width: 1280, height: 800 },
    ];
    const viewport = randomItem(viewports);

    const userDataDir = process.env.CHROME_PROFILE_DIR || path.join(__dirname, '.chrome-profile');

    // 清理旧 profile 避免 ProcessSingleton 冲突。
    // OAUTH_ONLY / PRESERVE_PROFILE 时不清（服务器复用模式 PROFILE_DIR 指向已有 profile）。
    if (!process.env.PRESERVE_PROFILE && process.env.OAUTH_ONLY !== 'true') {
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    }
    fs.mkdirSync(userDataDir, { recursive: true });

    // ── 启动浏览器（代理故障转移：池里最多试 N 个 → 最后直连）────────
    // 用首个 page.goto(signup) 作为连通性探针；代理连不上就换下一个候选。
    const proxyRetries = parseInt(process.env.PROXY_RETRIES || '3', 10);
    const candidates = [...pickProxies(proxyRetries), null]; // N 个代理 + 直连兜底
    const SIGNUP_URL = 'https://github.com/signup?source=form-home-signup&user_email=';

    let context = null, page = null, proxyBridge = null, browserProxyUrl = null, proxyUrl = null;
    let launched = false;
    for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        const label = cand ? maskProxy(cand) : '直连';
        const isLast = i === candidates.length - 1;
        console.log(`\n[Browser] 启动 Chrome (persistent context) — 候选 ${i + 1}/${candidates.length}: ${label}`);
        console.log(`  headless: ${CONFIG.headless} | profile: ${userDataDir}`);

        let attempt;
        try {
            attempt = await launchBrowserForProxy(chromium, cand, userDataDir, viewport);
        } catch (e) {
            console.log(`  ⚠️ 候选 ${label} 启动失败: ${e.message}${isLast ? '' : ' → 换下一个'}`);
            if (isLast) throw e;
            continue;
        }

        // 连通性探针：首个 signup 页导航。
        try {
            console.log('\n━━━ 📝 Phase 1: GitHub 注册 ━━━');
            await attempt.page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            // 成功：保留这套句柄，跳出循环继续后续流程。
            context = attempt.context; page = attempt.page;
            proxyBridge = attempt.proxyBridge; browserProxyUrl = attempt.browserProxyUrl;
            proxyUrl = cand;
            launched = true;
            console.log(`  ✅ 连通 (${label})`);
            break;
        } catch (e) {
            const proxyIssue = isProxyConnError(e);
            console.log(`  ⚠️ 候选 ${label} 导航失败${proxyIssue ? '(代理连接问题)' : ''}: ${e.message}`);
            // 拆掉这套失败句柄再试下一个。
            await attempt.context.close().catch(() => {});
            if (attempt.proxyBridge) await attempt.proxyBridge.close().catch(() => {});
            if (isLast) throw e;                 // 直连也失败 → 抛出
            if (!proxyIssue && !isLast) {
                // 非代理问题（如页面/GitHub 侧异常），换代理也大概率无益，但仍按用户要求继续故障转移。
                console.log('  （非代理类错误，仍继续故障转移）');
            }
            console.log('  → 换下一个候选');
        }
    }
    if (!launched) throw new Error('all proxy candidates and direct connection failed');

    try {
        await humanDelay(1500, 4500);
        await dismissGitHubCookieBanner(page);

        // ⚠️  GitHub 注册页面上方有 "Continue with Google/GitHub" 等社交登录按钮，
        //    它们也是 button[type="submit"]。必须精确定位邮箱注册表单的按钮，
        //    否则会误触发 Google OAuth 跳转。

        // 6.2.1 填写邮箱 → 自动展露密码/用户名。
        // GitHub 对 email 做即时校验，"already associated" 会内联报错并让表单保持无效。
        // 这里在填邮箱后主动探测冲突，命中就换新邮箱重填（最多 EMAIL_RETRY 次），
        // 避免走到最后才整轮失败。
        console.log('  [1/3] 填写邮箱...');
        const emailRetryMax = parseInt(process.env.EMAIL_COLLISION_RETRY || '5', 10);
        for (let emailTry = 0; ; emailTry++) {
            await fillExact(page, 'input#email, input[name="user[email]"]', identity.email, 'email');
            const collision = await detectEmailCollision(page);
            if (!collision) break;
            if (emailTry >= emailRetryMax) {
                throw new Error(`github_email_collision_exhausted after ${emailRetryMax} retries: ${collision}`);
            }
            const next = generateIdentity();
            console.log(`  ⚠️ 邮箱冲突(${collision})，换新邮箱重试 ${emailTry + 1}/${emailRetryMax}: ${identity.email} → ${next.email}`);
            identity = next;
        }

        // 等待邮箱验证通过 → 密码字段出现（比等 Continue 按钮更快更准）
        console.log('  等待邮箱验证...');
        try {
            // 先尝试点击 Continue 按钮（如果出现的话）
            const emailContinue = page.locator('button[data-continue-to="password-container"]');
            await emailContinue.waitFor({ state: 'visible', timeout: 3000 });
            await humanClick(page, emailContinue);
            console.log('  Continue 点击');
        } catch (_) {
            // 没有 Continue → 直接等密码框出现
        }

        // 等密码输入框可见（邮箱验证通过后 GitHub 才展示）
        try {
            await page.waitForSelector('input#password, input[name="user[password]"]', { state: 'visible', timeout: 5000 });
        } catch (_) { /* 可能已在 DOM 中 */ }

        // 6.2.2 填写密码 + 用户名
        console.log('  [2/3] 填写密码...');
        await fillExact(page, 'input#password, input[name="user[password]"]', identity.password, 'password');

        console.log('  [3/3] 填写用户名...');
        await fillExact(page, 'input#login, input[name="user[login]"]', identity.username, 'username');

        // 等 Create account 按钮可用（GitHub 自动校验 username，通过后移除 disabled）
        console.log('  等待 Create account 可用...');
        try {
            await page.waitForFunction(() => {
                const btn = document.querySelector('button[data-disable-invalid="true"]');
                return btn && !btn.disabled;
            }, { timeout: 8000 });
        } catch (_) { /* 兜底直接点 */ }

        // 点击提交：GitHub 这个按钮经常第一次不跳转，所以保留双击重试；
        // 但每次都只点邮箱注册表单里的 Create account，绝不使用 button[type=submit].first()。
        const submitted = await submitCreateAccountTwiceIfNeeded(page);
        if (!submitted) {
            const currentUrl = page.url();
            console.log(`  ⚠️ 双击后仍未跳转，仍在: ${currentUrl}`);
            const errors = await page.locator('[role="alert"], .error, .flash-error, #signup-form-error').allTextContents().catch(() => []);
            if (errors.length > 0) console.log(`  GitHub 错误: ${errors.join('; ')}`);
            console.log(`  ❌ Create account 未成功，保存截图；不会点击 Google/Apple 登录按钮`);
            await page.screenshot({
                path: process.env.SIGNUP_FAILED_SCREENSHOT_FILE || path.join(__dirname, 'captchas', 'signup-failed.png'),
                fullPage: true,
            }).catch(() => {});
            throw new Error('github_create_account_not_submitted');
        }

        // ── 6.3 CAPTCHA 检测（提交注册后 GitHub 可能弹 Funcaptcha） ──
        console.log('\n━━━ 🔐 Phase 2: CAPTCHA 检测 ━━━');
        await humanDelay(1200, 4000);

        const captchaResult = await checkAndSolveCaptcha(page, {
            baseUrl: null,  // 在 GitHub 页面，不需要 new-api 的 GoCaptcha 探测
            stage: 'signup',
        });

        if (captchaResult.needManual) {
            if (captchaResult.type === 'generic') {
                console.log(`  ℹ️  generic captcha 误报，跳过 (等待 3s)`);
                await humanDelay(3000);
            } else {
                console.log(`  ⚠️  ${captchaResult.type} CAPTCHA 需人工处理`);
                console.log(`  截图: ${captchaResult.screenshot}`);
                console.log('  ⏳ 等待 120 秒供人工处理...');
                await humanDelay(120000);
            }
        } else if (captchaResult.solved && captchaResult.token) {
            console.log(`  ✅ ${captchaResult.type} CAPTCHA 已自动解决`);
        }

        // ── 6.4 邮箱 OTP 验证 ────────────────────────────────
        console.log('\n━━━ 📧 Phase 3: 邮箱 OTP 验证 ━━━');

        // 等待 launch-code 输入框出现
        try {
            await page.waitForSelector('#launch-code-0', { timeout: 15000 });
            console.log('  OTP 输入框已出现');
        } catch (_) {
            // 可能出现了其他验证方式（如 captcha）
            console.log('  ⚠️  未检测到 OTP 输入框，可能遇到额外的验证');
            // 再次 CAPTCHA 检测
            try {
                const retryResult = await checkAndSolveCaptcha(page, { stage: 'signup' });
                if (retryResult.needManual && retryResult.type === 'generic') {
                    console.log('  ℹ️  二次 generic 误报，跳过');
                } else if (retryResult.needManual) {
                    console.log(`  截图: ${retryResult.screenshot}`);
                    console.log('  ⏳ 等待 30 秒...');
                    await humanDelay(30000);
                }
            } catch (_) { /* 页面可能已变更 */ }
        }

        // 轮询 mailops 获取验证码（最多重试 3 次，每次超时关浏览器重来）
        let otp = null;
        for (let otpRetry = 0; otpRetry < 3 && !otp; otpRetry++) {
            if (otpRetry > 0) {
                console.log(`  🔄 Mailops 重试 ${otpRetry}/3：关闭窗口，重新生成邮箱...`);
                await context.close();
                if (proxyBridge) await proxyBridge.close().catch(() => {});
                identity = generateIdentity();
                console.log(`  新邮箱: ${identity.email}`);
                // 用同一个工作代理重启（已在故障转移循环里验证可用）。
                const relaunch = await launchBrowserForProxy(chromium, proxyUrl, userDataDir, viewport);
                context = relaunch.context;
                page = relaunch.page;
                proxyBridge = relaunch.proxyBridge;
                browserProxyUrl = relaunch.browserProxyUrl;
                // 重新走一遍注册流程
                await page.goto('https://github.com/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await humanDelay(1200, 3000);
                await dismissGitHubCookieBanner(page);
                await fillExact(page, 'input#email, input[name="user[email]"]', identity.email, 'email');
                console.log('  等待邮箱验证...');
                try { await page.waitForSelector('button[data-continue-to="password-container"]', { timeout: 30000 }); } catch (_) {}
                const ec = page.locator('button[data-continue-to="password-container"]').first();
                if (await ec.isVisible({ timeout: 3000 }).catch(() => false)) await humanClick(page, ec);
                await humanDelay(800, 2000);
                await fillExact(page, 'input#password, input[name="user[password]"]', identity.password, 'password');
                const pwContinue = page.locator('button[data-continue-to="username-container"]').first();
                if (await pwContinue.isVisible({ timeout: 3000 }).catch(() => false)) await humanClick(page, pwContinue);
                await humanDelay(800, 2000);
                await fillExact(page, 'input#login, input[name="user[login]"]', identity.username, 'username');
                const submittedRetry = await submitCreateAccountTwiceIfNeeded(page);
                if (!submittedRetry) throw new Error('github_create_account_not_submitted_retry');
                await humanDelay(1200, 4000);
                // Skip captcha on retry
                try {
                    const cr2 = await checkAndSolveCaptcha(page, { baseUrl: null, stage: 'signup' });
                    if (cr2.needManual && cr2.type === 'generic') await humanDelay(3000);
                    else if (cr2.needManual) await humanDelay(30000);
                } catch (_) {}
            }
            otp = await pollOTP(identity.email, { timeoutMs: 120_000, intervalMs: 3_000 });
        }
        if (!otp) {
            throw new Error('未能获取邮箱验证码，超时（重试3次）');
        }

        // 输入 OTP（8 个独立 input）
        console.log('  输入 OTP...');
        await humanTypeOTP(page, otp);

        // 等待自动跳转或点击 Continue
        await humanDelay(1200, 5000);
        try {
            const continueBtn = page.locator('button:has-text("Continue")').first();
            if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await humanClick(page, continueBtn);
            }
        } catch (_) { /* 可能已自动跳转 */ }

        // 等待注册完成（跳转到 dashboard 或 login 页）
        await humanDelay(2000, 6000);

        // ── Phase 4: 确认登录状态 ─────────────────────────────
        console.log('\n━━━ 🔑 Phase 4: 确认登录状态 ━━━');

        await ensureGithubLoggedIn(page, identity);

        // 捕获完整 storageState（cookies + localStorage），供 Stage B / 持久化复用。
        // 不再写/删 data/github-cookies.json。
        const storageState = await context.storageState();

        // 服务器契约：若设置 EXPORT_COOKIES_PATH，则把 storageState 落到该路径供 Python 消费。
        if (process.env.EXPORT_COOKIES_PATH) {
            try {
                fs.mkdirSync(path.dirname(process.env.EXPORT_COOKIES_PATH), { recursive: true });
                fs.writeFileSync(process.env.EXPORT_COOKIES_PATH, JSON.stringify(storageState, null, 2));
                console.log(`  ✅ storageState 已导出: ${process.env.EXPORT_COOKIES_PATH}`);
            } catch (e) {
                console.log(`  ⚠️ storageState 导出失败: ${e.message}`);
            }
        }

        console.log(`  ✅ Stage A 完成，session 已捕获（${(storageState.cookies || []).length} cookies）`);
        return { identity, storageState, context, page, proxyUrl: browserProxyUrl || proxyUrl || '', proxyBridge };
    } catch (err) {
        console.error(`\n❌ 注册阶段失败: ${err.message}`);
        // 出错时关闭浏览器/代理桥；调用方拿到异常。
        const errorScreenshot = process.env.ERROR_SCREENSHOT_FILE || path.join(__dirname, 'error.png');
        try {
            fs.mkdirSync(path.dirname(errorScreenshot), { recursive: true });
            await page.screenshot({ path: errorScreenshot }).catch(() => {});
        } catch (_) {}
        await context.close().catch(() => {});
        if (proxyBridge) await proxyBridge.close().catch(() => {});
        throw err;
    }
}

// OAUTH_ONLY=true path: skip registration, reuse an existing session's cookies and
// run Phase 5 (OAuth) directly. Cookie source priority:
//   (1) EXPORT_COOKIES_PATH file (server writes storageState/cookies here)
//   (2) a session in sessions.jsonl matching SIGNUP_EMAIL
// Returns the same result shape as main().
async function runOAuthOnly(opts = {}) {
    applyServerEnvContract();
    const startedAt = opts.startedAt || Date.now();
    let cookies = null;
    let email = process.env.SIGNUP_EMAIL || '';
    let username = email ? email.split('@', 1)[0] : '';
    let password = CONFIG.defaultPassword;

    const cookiePath = process.env.EXPORT_COOKIES_PATH || '';
    if (cookiePath && fs.existsSync(cookiePath)) {
        const parsed = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
        cookies = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
        console.log(`  [OAUTH_ONLY] 从 ${cookiePath} 载入 ${cookies.length} cookies`);
    } else if (email) {
        const { findSession, getSessionCookies } = require('./lib/session-store');
        const sess = findSession(email, { rootDir: __dirname });
        if (!sess) throw new Error(`OAUTH_ONLY: no session/cookies for ${email}`);
        cookies = getSessionCookies(sess);
        username = sess.username || username;
        password = sess.password || password;
        console.log(`  [OAUTH_ONLY] 从 sessions.jsonl 载入 ${email} 的 ${cookies.length} cookies`);
    } else {
        throw new Error('OAUTH_ONLY requires EXPORT_COOKIES_PATH or SIGNUP_EMAIL');
    }

    const results = await runSitesOAuthHttp(TARGET_SITES, cookies, { proxyUrl: pickProxy() || '', routingProfiles });
    const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
    const result = { success: true, email, username, password, keys: results, durationSeconds: parseFloat(duration) };
    await uploadResult({ ...result, source: 'oauth-only' }, { meta: { source: 'index', mode: 'oauth-only' } });
    console.log(JSON.stringify(result, null, 2));
    return result;
}

// ──────────────────────────────────────────────────────────
// 主流程：Stage A（注册）+ Phase 5（OAuth）+ Phase 6（结果）。
// npm start 与服务器都跑 main()，行为与旧版一致（唯一变化：不再产 github-cookies.json）。
// ──────────────────────────────────────────────────────────
async function main() {
    const startedAt = Date.now();

    // OAUTH_ONLY=true：跳过注册，直接用已有 session/cookies 走 Phase 5。
    if (process.env.OAUTH_ONLY === 'true') {
        return runOAuthOnly({ startedAt });
    }

    const reg = await registerGithubAccount();
    const { identity, storageState, context, proxyUrl } = reg;
    const proxyBridge = reg.proxyBridge;

    try {
        // ── 🚀 TURBO 模式：登录后的操作全速执行 ────────────────
        console.log('\n🚀 进入 TURBO 模式（登录后操作全速）');
        const turbo = { delay: (ms) => new Promise(r => setTimeout(r, ms || 100)) };
        const page = reg.page;

        // ── Phase 5: 多站 OAuth + Token（遍历 TARGET_SITES） ──────
        console.log(`\n━━━ 🔗 Phase 5: OAuth + Token (${TARGET_SITES.length} 站) ━━━`);

        let results = [];

        if (CONFIG.hybridHttpOAuth) {
            console.log('  模式: Hybrid HTTP OAuth（GitHub 注册保留浏览器，OAuth/Token 使用 HTTP）');
            const githubCookies = storageState.cookies || [];
            results = await runSitesOAuthHttp(TARGET_SITES, githubCookies, { proxyUrl: proxyUrl || '', routingProfiles });
            for (const r of results) {
                console.log(`  🎉 ${r.site} [${r.profile || 'default'}] Key: ${r.apiKey.substring(0, 12)}...`);
            }
        } else {
            console.log('  模式: Browser OAuth fallback（HYBRID_HTTP_OAUTH=false）');
            for (const site of TARGET_SITES) {
                console.log(`\n── ${site.name} ──────────────────────────────`);


                // 1. 访问站点建立 session
                console.log(`  建立 session...`);
                await page.goto(`${site.baseUrl}/sign-in`, {
                    waitUntil: 'domcontentloaded', timeout: 15000,
                });
                await turbo.delay(300);

                // 2. 获取 OAuth state
                console.log('  获取 OAuth state...');
                const stateData = await page.evaluate(async (base) => {
                    const resp = await fetch(`${base}/api/oauth/state?aff=`);
                    return resp.json();
                }, site.baseUrl);
                const state = stateData?.data || '';
                if (!state) throw new Error(`${site.name}: 无法获取 OAuth state`);
                console.log(`  state: ${state}`);

                // 3. 跳转 GitHub 授权页
                const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${site.clientId}&state=${state}&scope=user:email`;
                await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

                // 4. 如果已经在授权页（非首次可能跳过登录直接到授权），点 Authorize
                const isAuthPage = page.url().includes('github.com/login/oauth/authorize');
                if (isAuthPage) {
                    console.log('  等待 Authorize 按钮...');
                    const authBtn = page.locator('button.js-oauth-authorize-btn').first();
                    try {
                        await authBtn.waitFor({ state: 'visible', timeout: 10000 });
                        await turbo.delay(200);
                        await authBtn.click();
                        console.log('  已点击 Authorize');
                    } catch (_) {
                        // 可能已自动授权重定向
                        console.log('  无需手动授权（可能已自动通过）');
                    }
                } else {
                    console.log(`  GitHub 页面: ${page.url()} (非授权页，可能已自动完成)`);
                }

                // 5. 等待回调到站点 dashboard
                const siteDomain = new URL(site.baseUrl).hostname;
                console.log(`  等待回调 ${siteDomain} dashboard...`);
                await page.waitForURL(`**/${siteDomain}/dashboard**`, { timeout: 30000 }).catch(() => {
                    console.log(`  ⚠️  当前 URL: ${page.url()}`);
                });
                await turbo.delay(500);

                // 6. 提取 session cookie
                const cookies = await context.cookies();
                const sessionCookieObj = cookies.find(c =>
                    c.name === 'session' && c.domain.includes(siteDomain)
                );
                if (!sessionCookieObj) {
                    console.log(`  ❌ ${site.name}: 未获取到 session cookie，跳过`);
                    continue;
                }
                const siteSession = `${sessionCookieObj.name}=${sessionCookieObj.value}`;
                console.log(`  ✅ ${site.name} session 已获取`);

                // 7. 提取 user ID
                console.log('  提取 user ID...');
                let siteUserId = await page.evaluate(() => {
                    const sources = [
                        () => window.__APP_STATE__?.user?.id,
                        () => window.__NUXT__?.state?.user?.id,
                        () => {
                            const el = document.querySelector('[data-user-id]');
                            return el?.getAttribute('data-user-id');
                        },
                        () => {
                            const s = localStorage.getItem('user');
                            if (s) { try { return JSON.parse(s).id; } catch (_) {} }
                            return null;
                        },
                    ];
                    for (const fn of sources) {
                        try { const id = fn(); if (id) return String(id); } catch (_) {}
                    }
                    return null;
                });
                if (!siteUserId) {
                    try {
                        siteUserId = await page.evaluate(async (base) => {
                            const r = await fetch(`${base}/api/user/self`, {
                                headers: { 'Accept': 'application/json' },
                            });
                            return (await r.json())?.data?.id;
                        }, site.baseUrl);
                    } catch (_) {}
                }
                if (!siteUserId) {
                    console.log(`  ❌ ${site.name}: 无法获取 user ID，跳过`);
                    continue;
                }
                console.log(`  ✅ ${site.name} user ID: ${siteUserId}`);

                // 8. 创建 API Token (循环 profiles 建多个)
                const siteKeys = [];
                for (const profile of routingProfiles) {
                    console.log(`  🔧 Creating token with profile: ${profile.name}`);
                    try {
                        const keyObj = await siteCreateToken(site, siteSession, siteUserId, profile);
                        siteKeys.push(keyObj);
                        console.log(`  ✅ ${profile.name}: ${keyObj.apiKey.substring(0, 12)}...`);
                    } catch (err) {
                        console.error(`  ❌ ${profile.name} failed: ${err.message}`);
                        // Continue with remaining profiles
                    }
                }
                if (siteKeys.length === 0) {
                    console.log(`  ❌ ${site.name}: 所有 profile 都失败，跳过该站点`);
                    continue;
                }

                for (const keyObj of siteKeys) {
                    results.push({
                        site: site.name,
                        baseUrl: site.baseUrl,
                        apiKey: keyObj.apiKey,
                        userId: siteUserId,
                        profile: keyObj.profile,
                    });
                }
            }
        }

        // ── Phase 6: 结果输出 ─────────────────────────────────
        const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log('\n═══════════════════════════════════════════');
        console.log('  🎉 注册完成!');
        console.log('═══════════════════════════════════════════');
        console.log(`  邮箱:     ${identity.email}`);
        console.log(`  用户名:   ${identity.username}`);
        console.log(`  密码:     ${identity.password}`);
        console.log(`  耗时:     ${duration}s`);
        for (const r of results) {
            console.log(`  [${r.site}] ${r.apiKey}`);
        }
        console.log('═══════════════════════════════════════════\n');

        const result = {
            success: true,
            email: identity.email,
            username: identity.username,
            password: identity.password,
            keys: results,
            durationSeconds: parseFloat(duration),
        };
        await uploadResult({ ...result, source: 'fresh-registration' }, { meta: { source: 'index' } });
        console.log(JSON.stringify(result, null, 2));
        return result;

    } catch (err) {
        console.error(`\n❌ 流程失败: ${err.message}`);
        console.error(err.stack);
        // 截图保存现场
        const errorScreenshot = process.env.ERROR_SCREENSHOT_FILE || path.join(__dirname, 'error.png');
        try {
            fs.mkdirSync(path.dirname(errorScreenshot), { recursive: true });
            await reg.page.screenshot({ path: errorScreenshot }).catch(() => {});
            console.log(`已保存错误截图: ${errorScreenshot}`);
        } catch (_) {}
        throw err;
    } finally {
        await context.close().catch(() => {});
        if (proxyBridge) await proxyBridge.close().catch(() => {});
        console.log('[Browser] 已关闭');
    }
}

// ──────────────────────────────────────────────────────────
// 7. 入口
// ──────────────────────────────────────────────────────────
if (require.main === module) {
    main()
        .then(result => {
            process.exit(0);
        })
        .catch(err => {
            console.error(`❌ [Fatal] ${err.message}`);
            process.exit(1);
        });
}

module.exports = { main, registerGithubAccount, runOAuthOnly, applyServerEnvContract, generateIdentity, pollOTP, siteCreateToken, SITES, TARGET_SITES, randomGithubUsername, assertSafeGithubUsername, isGithubLoggedInUrl, ensureGithubLoggedIn, dismissGitHubCookieBanner };

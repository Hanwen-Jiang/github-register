// captcha.js — CAPTCHA 检测与求解
//
// 参考 sub2api/scripts 的 CAPTCHA 掌握体系：
//   1. GoCaptcha click-shape  → 2Captcha CoordinatesTask → AES 加密提交
//   2. Cloudflare Turnstile    → 运行时探测 site_key → 2Captcha/Capsolver
//   3. Arkose Funcaptcha       → GitHub 专用 → 检测 + 2Captcha FuncaptchaTask
//   4. 通用兜底                 → 截图 + 人工介入
//
// 调用方（index.js）在关键步骤后调用 checkAndSolveCaptcha(page)，
// 若返回 false 表示需要人工介入。

const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════
// 配置
// ══════════════════════════════════════════════════════════
const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || process.env.CAP_2Captcha_KEY || process.env.TWOCAPTCHA_API_KEY || '';
const CAPTCHA_SOLVER = process.env.CAPTCHA_SOLVER || '2captcha'; // 2captcha | capsolver
const CAPTCHA_TIMEOUT_MS = parseInt(process.env.CAPTCHA_TIMEOUT_MS || '120000', 10);
const CAPTCHA_POLL_INTERVAL_MS = parseInt(process.env.CAPTCHA_POLL_INTERVAL_MS || '3000', 10);
const SCREENSHOT_DIR = process.env.CAPTCHA_SCREENSHOT_DIR || path.join(__dirname, 'captchas');

// ══════════════════════════════════════════════════════════
// 2Captcha / Capsolver HTTP API
// ══════════════════════════════════════════════════════════
async function solverCreateTask(task) {
    const apiKey = CAPTCHA_API_KEY;
    if (!apiKey) throw new Error('CAPTCHA_API_KEY 未配置');

    let url, body;

    if (CAPTCHA_SOLVER === 'capsolver') {
        url = 'https://api.capsolver.com/createTask';
        body = { clientKey: apiKey, task };
    } else {
        // 2captcha (default)
        url = 'https://api.2captcha.com/createTask';
        body = { clientKey: apiKey, task };
    }

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
    });
    const json = await resp.json();

    if (json.errorId !== 0 && json.errorId !== undefined) {
        throw new Error(`solver createTask error: ${json.errorDescription || json.errorCode || JSON.stringify(json)}`);
    }
    return json.taskId;
}

async function solverGetResult(taskId) {
    const apiKey = CAPTCHA_API_KEY;
    let url, body;

    if (CAPTCHA_SOLVER === 'capsolver') {
        url = 'https://api.capsolver.com/getTaskResult';
        body = { clientKey: apiKey, taskId };
    } else {
        url = 'https://api.2captcha.com/getTaskResult';
        body = { clientKey: apiKey, taskId };
    }

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
    });
    return resp.json();
}

async function solverPoll(taskId, timeoutMs = CAPTCHA_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, CAPTCHA_POLL_INTERVAL_MS));
        const result = await solverGetResult(taskId);
        if (result.status === 'ready') return result.solution;
        if (result.errorId !== 0 && result.errorId !== undefined) {
            throw new Error(`solver error: ${result.errorDescription || result.errorCode}`);
        }
        // status === 'processing' → continue
    }
    throw new Error('CAPTCHA 解决超时');
}

// ══════════════════════════════════════════════════════════
// 1. GoCaptcha click-shape 求解（new-api 系站点）
// ══════════════════════════════════════════════════════════
async function solveGoCaptcha(page, baseUrl) {
    console.log('[Captcha] 检测到 GoCaptcha click-shape');

    // 1.1 拉取 challenge
    const challengeData = await page.evaluate(async (base) => {
        const resp = await fetch(`${base}/api/go-captcha-data/click-shape`);
        return resp.json();
    }, baseUrl);

    if (!challengeData || String(challengeData.code) !== '0') {
        console.log('[Captcha] GoCaptcha challenge 获取失败:', JSON.stringify(challengeData).slice(0, 200));
        return null;
    }

    const { captcha_key, image_base64, thumb_base64 } = challengeData;
    console.log(`[Captcha] captcha_key=${captcha_key.slice(0, 12)}... image=${image_base64.length} bytes`);

    // 1.2 送 2Captcha CoordinatesTask
    const taskId = await solverCreateTask({
        type: 'CoordinatesTask',
        body: image_base64,
        imgInstructions: thumb_base64,
        comment: '请按顺序点击提示图中的目标；返回大图中的坐标。',
    });
    console.log(`[Captcha] 2Captcha taskId=${taskId}`);

    // 1.3 轮询结果
    const solution = await solverPoll(taskId);
    const coords = solution.coordinates || solution;
    console.log(`[Captcha] 识别坐标: ${JSON.stringify(coords)}`);

    // 1.4 AES 加密 + 提交验证
    const captchaToken = await page.evaluate(async (params) => {
        const { base, key, points } = params;

        // 前端 crypto 复刻
        const encoder = new TextEncoder();
        const hmacKey = await crypto.subtle.importKey(
            'raw',
            encoder.encode('new-api-captcha-aes-v1'),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const hmacSig = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(key));
        const aesKey = await crypto.subtle.importKey(
            'raw',
            new Uint8Array(hmacSig),
            { name: 'AES-CBC' },
            false,
            ['encrypt']
        );

        // 坐标格式: "x,y;x,y;..."
        const pointStr = points.map(p => `${Math.round(p.x)},${Math.round(p.y)}`).join(';');
        const iv = crypto.getRandomValues(new Uint8Array(16));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-CBC', iv },
            aesKey,
            encoder.encode(pointStr)
        );

        // base64(iv + ciphertext)
        const combined = new Uint8Array(iv.length + ciphertext.byteLength);
        combined.set(iv);
        combined.set(new Uint8Array(ciphertext), iv.length);
        const encrypted = btoa(String.fromCharCode(...combined));

        // 提交
        const formData = new FormData();
        formData.append('key', key);
        formData.append('data', encrypted);
        const resp = await fetch(`${base}/api/go-captcha-check-data/click-shape`, {
            method: 'POST',
            body: formData,
        });
        const result = await resp.json();
        return result.token || result.data?.token || null;
    }, { base: baseUrl, key: captcha_key, points: coords });

    if (captchaToken) {
        console.log(`[Captcha] ✅ GoCaptcha 解决，token=${captchaToken.slice(0, 20)}...`);
    } else {
        console.log('[Captcha] ❌ GoCaptcha 验证失败');
    }
    return captchaToken;
}

// ══════════════════════════════════════════════════════════
// 2. Cloudflare Turnstile 检测与求解
// ══════════════════════════════════════════════════════════
async function detectTurnstile(page) {
    // 检查页面中是否有 Turnstile widget
    const info = await page.evaluate(() => {
        // 1. DOM 中的 iframe
        const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        if (iframe) return { type: 'turnstile', found: 'iframe', siteKey: null };

        // 2. data-sitekey 属性
        const el = document.querySelector('[data-sitekey]');
        if (el) return { type: 'turnstile', found: 'data-sitekey', siteKey: el.getAttribute('data-sitekey') };

        // 3. window.turnstile
        if (window.turnstile) return { type: 'turnstile', found: 'window.turnstile', siteKey: null };

        // 4. 页面文本中的 sitekey pattern
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
            const match = (s.textContent || '').match(/sitekey["']?\s*:\s*["'](0x4AAAAA[\w-]+)["']/);
            if (match) return { type: 'turnstile', found: 'script', siteKey: match[1] };
        }

        return null;
    });

    return info;
}

async function solveTurnstile(page, siteKey, websiteURL) {
    console.log(`[Captcha] Turnstile 检测到, siteKey=${siteKey}`);

    const taskId = await solverCreateTask({
        type: 'TurnstileTaskProxyless',
        websiteURL: websiteURL || page.url(),
        websiteKey: siteKey,
    });
    console.log(`[Captcha] Turnstile taskId=${taskId}`);

    const solution = await solverPoll(taskId);
    const token = solution.token || solution.cf_clearance || solution.turnstile || '';
    console.log(`[Captcha] ✅ Turnstile token=${token.slice(0, 30)}...`);
    return token;
}

// ══════════════════════════════════════════════════════════
// 3. Arkose Funcaptcha 检测（GitHub 专用）
// ══════════════════════════════════════════════════════════
async function detectFuncaptcha(page) {
    const info = await page.evaluate(() => {
        // Arkose iframe
        const iframe = document.querySelector('iframe[src*="arkoselabs.com"], iframe[src*="funcaptcha.com"]');
        if (iframe) return { type: 'funcaptcha', found: 'iframe' };

        // enforcement container
        const container = document.querySelector('#FunCAPTCHA, .fun-captcha, [id*="funcaptcha"], [class*="funcaptcha"]');
        if (container) return { type: 'funcaptcha', found: 'container' };

        // GitHub specific: signup CAPTCHA
        const ghCaptcha = document.querySelector('#captcha-and-submit-container, [data-captcha="enabled"]');
        if (ghCaptcha) return { type: 'funcaptcha', found: 'github-captcha' };

        return null;
    });

    return info;
}

async function solveFuncaptcha(page, publicKey, pageURL) {
    console.log('[Captcha] Funcaptcha 检测到 (GitHub Arkose)');

    // Arkose Funcaptcha 需要 publicKey (从页面提取)
    if (!publicKey) {
        publicKey = await page.evaluate(() => {
            // Try to find from script/data attributes
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
                const m = (s.textContent || '').match(/public_key["']?\s*:\s*["']([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})["']/i);
                if (m) return m[1];
            }
            return null;
        });
    }

    if (!publicKey) {
        console.log('[Captcha] ⚠️ 无法提取 Funcaptcha publicKey，需人工');
        return null;
    }

    const taskId = await solverCreateTask({
        type: 'FunCaptchaTaskProxyless',
        websiteURL: pageURL || page.url(),
        websitePublicKey: publicKey,
        funcaptchaApiJSSubdomain: '',
        data: JSON.stringify({ blob: '' }),
    });
    console.log(`[Captcha] Funcaptcha taskId=${taskId}`);

    try {
        const solution = await solverPoll(taskId, 180000); // 3 min timeout
        const token = solution.token || '';
        console.log(`[Captcha] ✅ Funcaptcha token=${token.slice(0, 30)}...`);
        return token;
    } catch (e) {
        console.log(`[Captcha] ❌ Funcaptcha 求解失败: ${e.message}`);
        return null;
    }
}

// ══════════════════════════════════════════════════════════
// 4. 通用 CAPTCHA 检测入口
// ══════════════════════════════════════════════════════════

/**
 * 检查页面是否有 CAPTCHA，尝试自动求解。
 *
 * @param {Page} page - Playwright page
 * @param {object} opts
 * @param {string} opts.baseUrl - API base URL（用于 GoCaptcha 和 Turnstile 探测）
 * @param {string} opts.stage - 'signup' | 'login' | 'oauth' | 'register'
 * @returns {object} { solved: boolean, token: string|null, type: string, needManual: boolean }
 */
async function checkAndSolveCaptcha(page, opts = {}) {
    const { baseUrl, stage = 'signup' } = opts;

    // 确保截图目录存在
    if (!fs.existsSync(SCREENSHOT_DIR)) {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }

    const timestamp = Date.now();
    const shotPath = path.join(SCREENSHOT_DIR, `captcha-${stage}-${timestamp}.png`);

    // ── 4.1 先检查 GoCaptcha（new-api 风格站点的 /api/status） ──
    if (baseUrl) {
        try {
            const statusJson = await page.evaluate(async (base) => {
                const resp = await fetch(`${base}/api/status`);
                return resp.json();
            }, baseUrl);

            const data = statusJson?.data || statusJson || {};
            const captchaType = data.captcha_type || '';

            if (captchaType === 'click-shape') {
                const needCaptcha =
                    (stage === 'signup' && data.captcha_register_enabled) ||
                    (stage === 'login' && data.captcha_login_enabled) ||
                    data.captcha_send_code_enabled;

                if (needCaptcha) {
                    const token = await solveGoCaptcha(page, baseUrl);
                    if (token) {
                        return { solved: true, token, type: 'gocaptcha', needManual: false };
                    }
                    // GoCaptcha 求解失败，回退人工
                    await page.screenshot({ path: shotPath, fullPage: true });
                    console.log(`[Captcha] 截图: ${shotPath}，等待人工...`);
                    return { solved: false, token: null, type: 'gocaptcha', needManual: true, screenshot: shotPath };
                }
            }
        } catch (_) { /* /api/status 不可达，继续 */ }
    }

    // ── 4.2 Funcaptcha（GitHub 注册页） ──
    let fcInfo = null;
    try { fcInfo = await detectFuncaptcha(page); } catch (_) { /* 页面可能已跳转 */ }
    if (fcInfo) {
        console.log(`[Captcha] Funcaptcha: ${fcInfo.found}`);

        if (CAPTCHA_API_KEY) {
            const token = await solveFuncaptcha(page, null, page.url());
            if (token) {
                // 注入 token 到页面
                await page.evaluate((t) => {
                    // GitHub 的 funcaptcha token 注入
                    const input = document.querySelector('input[name="captcha_token"], #captcha-token');
                    if (input) {
                        const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                        s?.call(input, t);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, token);
                return { solved: true, token, type: 'funcaptcha', needManual: false };
            }
        }

        // 无法自动求解
        await page.screenshot({ path: shotPath, fullPage: true });
        console.log(`[Captcha] ⚠️ Funcaptcha 需人工 | 截图: ${shotPath}`);
        console.log(`[Captcha] 💡 设置 CAPTCHA_API_KEY (2captcha) 可自动求解`);
        return { solved: false, token: null, type: 'funcaptcha', needManual: true, screenshot: shotPath };
    }

    // ── 4.3 Turnstile ──
    let tsInfo = null;
    try { tsInfo = await detectTurnstile(page); } catch (_) { /* 页面可能已跳转 */ }
    if (tsInfo) {
        console.log(`[Captcha] Turnstile: ${tsInfo.found} siteKey=${tsInfo.siteKey}`);

        if (tsInfo.siteKey && CAPTCHA_API_KEY) {
            const token = await solveTurnstile(page, tsInfo.siteKey, page.url());
            if (token) {
                // 注入 Turnstile token
                await page.evaluate((t) => {
                    const input = document.querySelector('input[name="cf-turnstile-response"], [name="turnstile_token"]');
                    if (input) {
                        const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                        s?.call(input, t);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    // 也可能需要调用 callback
                    if (window.___turnstileCallback) window.___turnstileCallback(t);
                }, token);
                return { solved: true, token, type: 'turnstile', needManual: false };
            }
        }

        await page.screenshot({ path: shotPath, fullPage: true });
        console.log(`[Captcha] ⚠️ Turnstile 需人工 | 截图: ${shotPath}`);
        return { solved: false, token: null, type: 'turnstile', needManual: true, screenshot: shotPath };
    }

    // ── 4.4 通用：检查是否有任何疑似 CAPTCHA 的元素 ──
    let genericCaptcha = false;
    try {
        genericCaptcha = await page.evaluate(() => {
        const indicators = [
            'captcha', 'verification', 'verify', 'challenge',
            'robot', 'human', 'puzzle', '确认', '验证',
        ];
        const body = document.body?.innerText?.toLowerCase() || '';
        for (const word of indicators) {
            if (body.includes(word)) return true;
        }
        // 检查常见 CAPTCHA iframe/元素
        const el = document.querySelector(
            'iframe[src*="captcha"], iframe[src*="hcaptcha"], ' +
            'iframe[src*="recaptcha"], [class*="captcha"], [id*="captcha"]'
        );
        return !!el;
        });
    } catch (_) { /* 页面跳转 */ }

    if (genericCaptcha) {
        await page.screenshot({ path: shotPath, fullPage: true });
        console.log(`[Captcha] ⚠️ 检测到未知 CAPTCHA | 截图: ${shotPath}`);
        return { solved: false, token: null, type: 'generic', needManual: true, screenshot: shotPath };
    }

    // 没有 CAPTCHA
    return { solved: true, token: null, type: 'none', needManual: false };
}

module.exports = {
    checkAndSolveCaptcha,
    detectFuncaptcha,
    detectTurnstile,
    solveGoCaptcha,
    solveTurnstile,
    solveFuncaptcha,
};

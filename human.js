// human.js — 真人行为模拟（增强版）
//
// 改进点：
//   1. Burst 打字：连续快打 2-5 字符 (30-60ms)，然后停顿思考 (100-500ms)
//   2. 随机长停顿：偶尔插入 300-1200ms 的"思考"停顿
//   3. 表单间隔：每次调用重新生成随机范围，不是固定区间
//   4. 点击偏移：更大的随机范围 (10%-85%)

const crypto = require('crypto');

// 真随机整数 [min, max]
function randInt(min, max) {
    const range = max - min + 1;
    const bytes = crypto.randomBytes(4);
    const val = bytes.readUInt32BE(0);
    return min + (val % range);
}

// 真随机浮点 [0, 1)
function randFloat() {
    return crypto.randomBytes(4).readUInt32BE(0) / 0x100000000;
}

/**
 * 随机延时。每次调用时 fresh 生成范围：
 *   - 70% 概率用正常区间 [minMs, maxMs]
 *   - 20% 概率延长到 [maxMs, maxMs*2]（"走神"）
 *   - 10% 概率缩短到 [minMs*0.5, minMs]（"急性子"）
 */
function humanDelay(minMs, maxMs) {
    const roll = randFloat();
    let lo = minMs, hi = maxMs;
    if (roll > 0.9) {
        hi = Math.floor(maxMs * 2);
    } else if (roll > 0.7) {
        lo = Math.floor(minMs * 0.4);
        hi = minMs;
    }
    const delay = randInt(lo, hi);
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Burst 式真人输入。
 *
 * 模拟真人打字节奏：
 *   - 3-6 个字符连续快打 (30-60ms/字)
 *   - 然后一个"看键盘/思考"停顿 (150-500ms)
 *   - 偶尔 10% 概率插入更长的停顿 (300-1200ms)
 *
 * 逐级降级：
 *   1. pressSequentially — 逐字符 keypress
 *   2. fill() — 直接填充
 *   3. 原生 JS setter + dispatchEvent
 */
async function humanType(page, selector, text) {
    const expected = String(text);
    const el = typeof selector === 'string' ? page.locator(selector).first() : selector;
    for (let attempt = 1; attempt <= 3; attempt++) {
        await el.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ clickCount: 3 }).catch(() => el.click({ force: true }));
        await humanDelay(80, 180);
        try {
            await el.fill('');
            await el.fill(expected);
        } catch (_) {
            await el.evaluate((input, v) => {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                setter?.call(input, v);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }, expected);
        }
        await el.evaluate((input, v) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, v);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
        }, expected).catch(() => {});
        await humanDelay(120, 300);
        const actual = await el.inputValue().catch(() => '');
        if (actual === expected) {
            await humanDelay(120, 260);
            return;
        }
        console.log(`  ⚠️ 输入校验失败 ${attempt}/3: ${actual} != ${expected}`);
    }
    const actual = await el.inputValue().catch(() => '');
    throw new Error(`human_type_exact_fill_failed: ${actual} != ${expected}`);
}

/**
 * 真人式点击元素。
 * 在元素内偏移 10%-85% 的位置点击，模拟不精确的鼠标操作。
 */
async function humanClick(page, selector) {
    const el = typeof selector === 'string' ? page.locator(selector).first() : selector;
    await el.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
    await el.scrollIntoViewIfNeeded().catch(() => {});

    const box = await el.boundingBox().catch(() => null);
    if (box) {
        // 鼠标从随机位置移动过来
        const startX = randInt(0, Math.floor(box.width * 0.5));
        const startY = randInt(0, Math.floor(box.height * 0.5));
        await page.mouse.move(
            box.x + startX,
            box.y + startY,
            { steps: randInt(3, 12) }
        );
        await new Promise(r => setTimeout(r, randInt(30, 180)));

        // 点击随机偏置位置
        const clickX = box.x + box.width * (0.1 + randFloat() * 0.75);
        const clickY = box.y + box.height * (0.1 + randFloat() * 0.75);
        await page.mouse.click(clickX, clickY);
    } else {
        await el.click().catch(() => el.click({ force: true }));
    }
    // 点击后停顿
    await humanDelay(400, 1200);
}

/**
 * 逐个输入 OTP 到独立 input（GitHub launch-code 样式）
 */
async function humanTypeOTP(page, code) {
    const normalized = String(code).replace(/\D/g, '') || String(code);
    try {
        await page.waitForSelector('#launch-code-0', { timeout: 10000 });
        const filled = await page.evaluate((otp) => {
            const digits = String(otp).split('');
            const inputs = digits
                .map((_, i) => document.querySelector(`#launch-code-${i}`))
                .filter(Boolean);
            if (inputs.length < digits.length) return false;

            for (let i = 0; i < digits.length; i += 1) {
                const input = inputs[i];
                input.focus();
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                if (setter) setter.call(input, digits[i]);
                else input.value = digits[i];
                input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: digits[i] }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: digits[i] }));
            }

            inputs[inputs.length - 1]?.blur();
            return inputs.every((input, i) => input.value === digits[i]);
        }, normalized);
        if (filled) return;
    } catch (_) {
        // fall back to the slower but robust per-digit path below
    }

    const digits = normalized.split('');
    for (let i = 0; i < digits.length; i++) {
        const input = page.locator(`#launch-code-${i}`);
        await input.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click().catch(() => input.click({ force: true }));
        await new Promise(r => setTimeout(r, randInt(80, 250)));
        await input.pressSequentially(digits[i], { delay: randInt(40, 80) });
        await new Promise(r => setTimeout(r, randInt(150, 500)));
    }
}

/**
 * 随机轻微滚动
 */
async function humanScroll(page, distance) {
    const d = distance || randInt(40, 350);
    await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'smooth' }), d);
    await humanDelay(200, 800);
}

module.exports = { humanDelay, humanType, humanClick, humanTypeOTP, humanScroll };

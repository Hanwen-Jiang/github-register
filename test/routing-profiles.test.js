const test = require('node:test');
const assert = require('node:assert/strict');
const { siteCreateToken } = require('../index.js');

test('siteCreateToken includes routing fields when profile provided', async () => {
    let capturedPayload = null;
    const fakeSite = { name: 'test', baseUrl: 'https://test.com', tokenName: 'test' };
    const fakeProfile = {
        name: 'dynamic-cheap',
        routing_enabled: true,
        routing_preference: 'cheap',
        pricing_strategy: 'auto',
        routing_allow_fallback: true,
    };

    // Mock global fetch to capture the POST payload
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
        if (opts?.method === 'POST' && url.endsWith('/api/token/')) {
            capturedPayload = JSON.parse(opts.body);
            return { json: async () => ({ success: true, data: {} }) };
        }
        if (url.includes('/api/token/?p=')) {
            return { json: async () => ({ success: true, data: { items: [{ id: 1, created_time: 1 }] } }) };
        }
        if (url.includes('/api/token/1/key')) {
            return { json: async () => ({ success: true, data: { key: 'test123' } }) };
        }
        return { json: async () => ({}) };
    };

    try {
        const result = await siteCreateToken(fakeSite, 'fake-cookie', 123, fakeProfile);

        // Verify routing fields in payload
        assert.ok(capturedPayload, 'POST payload should be captured');
        assert.equal(capturedPayload.routing_enabled, true);
        assert.equal(capturedPayload.routing_preference, 'cheap');
        assert.equal(capturedPayload.pricing_strategy, 'auto');
        assert.equal(capturedPayload.routing_allow_fallback, true);
        assert.equal(capturedPayload.name, 'dynamic-cheap-test');

        // Verify return value includes profile
        assert.ok(result.apiKey.startsWith('sk-'));
        assert.equal(result.profile, 'dynamic-cheap');
    } finally {
        global.fetch = originalFetch;
    }
});

test('siteCreateToken omits routing fields when no profile provided', async () => {
    let capturedPayload = null;
    const fakeSite = { name: 'test', baseUrl: 'https://test.com', tokenName: 'test' };

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
        if (opts?.method === 'POST' && url.endsWith('/api/token/')) {
            capturedPayload = JSON.parse(opts.body);
            return { json: async () => ({ success: true, data: {} }) };
        }
        if (url.includes('/api/token/?p=')) {
            return { json: async () => ({ success: true, data: { items: [{ id: 1, created_time: 1 }] } }) };
        }
        if (url.includes('/api/token/1/key')) {
            return { json: async () => ({ success: true, data: { key: 'test456' } }) };
        }
        return { json: async () => ({}) };
    };

    try {
        const result = await siteCreateToken(fakeSite, 'fake-cookie', 123);

        // Verify NO routing fields in payload
        assert.ok(capturedPayload, 'POST payload should be captured');
        assert.equal(capturedPayload.routing_enabled, undefined);
        assert.equal(capturedPayload.routing_preference, undefined);
        assert.equal(capturedPayload.name, 'test');

        // Verify return value has null profile
        assert.ok(result.apiKey.startsWith('sk-'));
        assert.equal(result.profile, null);
    } finally {
        global.fetch = originalFetch;
    }
});

test('siteCreateToken generic defaults stay unlimited with zero quota', async () => {
    let capturedPayload = null;
    const fakeSite = { name: 'test', baseUrl: 'https://test.com', tokenName: 'test' };

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
        if (opts?.method === 'POST' && url.endsWith('/api/token/')) {
            capturedPayload = JSON.parse(opts.body);
            return { json: async () => ({ success: true, data: {} }) };
        }
        if (url.includes('/api/token/?p=')) {
            return { json: async () => ({ success: true, data: { items: [{ id: 1, created_time: 1 }] } }) };
        }
        if (url.includes('/api/token/1/key')) {
            return { json: async () => ({ success: true, data: { key: 'finite123' } }) };
        }
        return { json: async () => ({}) };
    };

    try {
        await siteCreateToken(fakeSite, 'fake-cookie', 123);

        assert.ok(capturedPayload, 'POST payload should be captured');
        assert.equal(capturedPayload.unlimited_quota, true);
        assert.equal(capturedPayload.remain_quota, 0);
    } finally {
        global.fetch = originalFetch;
    }
});

test('siteCreateToken applies randomized finite quota for cun.ai', async () => {
    let capturedPayload = null;
    const { SITES } = require('../lib/sites');
    const fakeSite = { ...SITES.find(s => s.name === 'cun.ai'), baseUrl: 'https://test.com' };

    const originalFetch = global.fetch;
    const originalRandom = Math.random;
    global.fetch = async (url, opts) => {
        if (opts?.method === 'POST' && url.endsWith('/api/token/')) {
            capturedPayload = JSON.parse(opts.body);
            return { json: async () => ({ success: true, data: {} }) };
        }
        if (url.includes('/api/token/?p=')) {
            return { json: async () => ({ success: true, data: { items: [{ id: 1, created_time: 1 }] } }) };
        }
        if (url.includes('/api/token/1/key')) {
            return { json: async () => ({ success: true, data: { key: 'cunfinite123' } }) };
        }
        return { json: async () => ({}) };
    };
    Math.random = () => 0.5;

    try {
        await siteCreateToken(fakeSite, 'fake-cookie', 123);

        assert.ok(capturedPayload, 'POST payload should be captured');
        assert.equal(capturedPayload.unlimited_quota, false);
        assert.equal(capturedPayload.remain_quota, 18_000_000);
    } finally {
        global.fetch = originalFetch;
        Math.random = originalRandom;
    }
});

test('siteCreateToken honors site tokenGroup override', async () => {
    let capturedPayload = null;
    const fakeSite = { name: 'xyc.ai', baseUrl: 'https://xyc.ai', tokenName: 'codex', tokenGroup: '' };

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
        if (opts?.method === 'POST' && url.endsWith('/api/token/')) {
            capturedPayload = JSON.parse(opts.body);
            return { json: async () => ({ success: true, data: {} }) };
        }
        if (url.includes('/api/token/?p=')) {
            return { json: async () => ({ success: true, data: { items: [{ id: 232, created_time: 1 }] } }) };
        }
        if (url.includes('/api/token/232/key')) {
            return { json: async () => ({ success: true, data: { key: 'xyc123' } }) };
        }
        return { json: async () => ({}) };
    };

    try {
        const result = await siteCreateToken(fakeSite, 'fake-cookie', 641);

        assert.ok(capturedPayload, 'POST payload should be captured');
        assert.equal(capturedPayload.group, '');
        assert.equal(capturedPayload.name, 'codex');
        assert.equal(result.apiKey, 'sk-xyc123');
    } finally {
        global.fetch = originalFetch;
    }
});

const { HttpClient } = require('./http-client');
const { resolveTokenRemainQuota, resolveTokenUnlimitedQuota } = require('./token-defaults');
const { normalizeLiveGroupOptions } = require('./site-groups');

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return '';
}

function absoluteUrl(location, baseUrl) {
  if (!location) return '';
  return new URL(location, baseUrl).toString();
}

function sanitizeUrlForTrace(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.searchParams.has('code')) u.searchParams.set('code', '<redacted>');
    return u.toString().replace(/code=%3Credacted%3E/g, 'code=<redacted>');
  } catch (_) {
    return String(url).replace(/code=[^&]+/g, 'code=<redacted>');
  }
}

function decodeHtmlAttr(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractCallbackUrlFromHtml(html, baseUrl) {
  const text = String(html || '');
  const escapedBase = String(baseUrl || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`href=["'](${escapedBase.replace(/\\\//g, '/')}[^"']*(?:code=|/oauth/)[^"']*)["']`, 'i'),
    /href=["']([^"']*\/oauth\/[^"']*code=[^"']*)["']/i,
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return absoluteUrl(decodeHtmlAttr(m[1]), baseUrl);
  }
  return '';
}

function callbackUrlToApiUrl(callbackUrl, baseUrl) {
  if (!callbackUrl) return '';
  const u = new URL(callbackUrl, baseUrl);
  const parts = u.pathname.split('/').filter(Boolean);
  const providerIdx = parts.indexOf('oauth');
  const provider = providerIdx >= 0 ? parts[providerIdx + 1] : '';
  if (!provider) return '';
  return `${String(baseUrl || '').replace(/\/+$/, '')}/api/oauth/${provider}${u.search}`;
}

function summarizeHtmlForTrace(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function extractInputs(html) {
  const params = new URLSearchParams();
  const inputRe = /<input\b[^>]*>/gi;
  const attrRe = /([:\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  for (const input of String(html || '').match(inputRe) || []) {
    const attrs = {};
    let m;
    while ((m = attrRe.exec(input)) !== null) {
      const key = m[1].toLowerCase();
      let val = m[2] || '';
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      attrs[key] = val;
    }
    if (attrs.name) params.append(attrs.name, attrs.value || '');
  }
  return params;
}

async function followRedirects(client, startUrl, maxHops = 5, trace = null) {
  let current = startUrl;
  let resp = null;
  for (let i = 0; i < maxHops && current; i++) {
    resp = await client.get(current);
    const loc = headerValue(resp.headers, 'location');
    const hasSetCookie = !!headerValue(resp.headers, 'set-cookie');
    if (trace) {
      trace.push(`follow:${resp.status}:${sanitizeUrlForTrace(current)}${hasSetCookie ? ' set-cookie' : ''}${loc ? ` -> ${sanitizeUrlForTrace(absoluteUrl(loc, current))}` : ''}`);
    }
    if (!(resp.status >= 300 && resp.status < 400) || !loc) return resp;
    current = absoluteUrl(loc, current);
  }
  return resp;
}

async function completeTargetOAuthCallback(client, callbackUrl, baseUrl, trace) {
  if (!callbackUrl) return null;
  const apiCallbackUrl = callbackUrlToApiUrl(callbackUrl, baseUrl);
  if (apiCallbackUrl) {
    try {
      const apiResp = await client.get(apiCallbackUrl, { accept: 'application/json', referer: callbackUrl });
      const apiText = apiResp.text();
      const apiJson = apiResp.json();
      trace?.push(`api_callback:${apiResp.status}:${sanitizeUrlForTrace(apiCallbackUrl)} body=${String(apiText).slice(0, 180)}`);
      if (apiJson?.success && apiJson?.data) return apiJson.data;
    } catch (err) {
      trace?.push(`api_callback_error:${sanitizeUrlForTrace(apiCallbackUrl)} ${sanitizeUrlForTrace(String(err.message || err)).slice(0, 160)}`);
    }
  }
  await followRedirects(client, callbackUrl, 5, trace);
  return null;
}

async function authenticateSiteOAuthHttp(site, githubCookies, opts = {}) {
  const baseUrl = String(site.baseUrl || site.base || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error(`${site.name || 'site'}: missing baseUrl`);

  const client = new HttpClient({
    transport: opts.transport,
    headers: opts.headers,
    proxyUrl: opts.proxyUrl || '',
    createTransport: opts.createTransport,
  });
  const trace = [];
  let callbackUser = null;
  client.importPlaywrightCookies(githubCookies || []);

  const signInResp = await client.get(`${baseUrl}/sign-in`, { accept: 'text/html,application/xhtml+xml' });
  trace.push(`site_signin:${signInResp.status}`);

  const stateResp = await client.get(`${baseUrl}/api/oauth/state?aff=`, { accept: 'application/json' });
  trace.push(`site_state:${stateResp.status}`);
  const stateText = stateResp.text();
  const stateJson = stateResp.json();
  const state = stateJson?.data || '';
  if (!state) {
    const contentType = headerValue(stateResp.headers, 'content-type') || '';
    const bodySummary = summarizeHtmlForTrace(stateText) || String(stateText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    throw new Error(`${site.name}: unable to fetch OAuth state status=${stateResp.status}${contentType ? ` content-type=${contentType}` : ''}${bodySummary ? ` body=${bodySummary}` : ''} trace=${trace.join(' | ')}`);
  }

  const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(site.clientId)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent('user:email')}`;
  let authResp = await client.get(authUrl, { accept: 'text/html,application/xhtml+xml', referer: `${baseUrl}/sign-in` });
  let location = headerValue(authResp.headers, 'location');
  trace.push(`github_authorize_get:${authResp.status}${location ? `->${sanitizeUrlForTrace(absoluteUrl(location, authUrl))}` : ''}`);
  if (authResp.status >= 300 && authResp.status < 400 && location) {
    const redirected = absoluteUrl(location, authUrl);
    trace.push(`follow_start:${sanitizeUrlForTrace(redirected)}`);
    if (redirected.startsWith(`${baseUrl}/oauth/`)) {
      callbackUser = await completeTargetOAuthCallback(client, redirected, baseUrl, trace) || callbackUser;
    } else {
      await followRedirects(client, redirected, 5, trace);
    }
  } else {
    const html = authResp.text();
    const form = extractInputs(html);
    if (form.size > 0) {
      form.set('client_id', site.clientId);
      form.set('state', state);
      form.set('scope', 'user:email');
      form.set('authorize', '1');
      authResp = await client.postForm('https://github.com/login/oauth/authorize', form, { referer: authUrl, accept: 'text/html,application/xhtml+xml' });
      location = headerValue(authResp.headers, 'location');
      const postSummary = !location ? summarizeHtmlForTrace(authResp.text()) : '';
      trace.push(`github_authorize_post:${authResp.status}${location ? `->${sanitizeUrlForTrace(absoluteUrl(location, 'https://github.com/login/oauth/authorize'))}` : ''}${postSummary ? ` body=${postSummary}` : ''}`);
      if (location) {
        const redirected = absoluteUrl(location, 'https://github.com/login/oauth/authorize');
        trace.push(`follow_start:${sanitizeUrlForTrace(redirected)}`);
        if (redirected.startsWith(`${baseUrl}/oauth/`)) {
          callbackUser = await completeTargetOAuthCallback(client, redirected, baseUrl, trace) || callbackUser;
        } else {
          await followRedirects(client, redirected, 5, trace);
        }
      } else {
        const callbackUrl = extractCallbackUrlFromHtml(authResp.text(), baseUrl);
        if (callbackUrl) {
          trace.push(`html_callback:${sanitizeUrlForTrace(callbackUrl)}`);
          callbackUser = await completeTargetOAuthCallback(client, callbackUrl, baseUrl, trace) || callbackUser;
        }
      }
    }
  }

  let userId = callbackUser?.id;
  if (!userId) {
    const selfHeaders = { accept: 'application/json' };
    const selfResp = await client.get(`${baseUrl}/api/user/self`, selfHeaders);
    const selfText = selfResp.text();
    const selfJson = selfResp.json();
    userId = selfJson?.data?.id;
    if (!userId) {
      throw new Error(`${site.name}: unable to fetch user id status=${selfResp.status} body=${selfText.slice(0, 300)} trace=${trace.join(' | ')}`);
    }
  }

  const apiHeaders = {
    'new-api-user': String(userId),
    origin: baseUrl,
    referer: `${baseUrl}/keys`,
  };

  return { site, baseUrl, client, userId: String(userId), apiHeaders, trace };
}

function resolveSiteSelections(site, opts = {}) {
  const explicit = Array.isArray(opts.groupSelections)
    ? opts.groupSelections
    : opts.siteGroupSelections?.[site.name];
  if (Array.isArray(explicit) && explicit.length) return explicit.map(option => ({ ...option }));
  const value = site.tokenGroup ?? 'default';
  return [{
    value: String(value),
    label: value === '' ? '(空分组)' : String(value),
    source: 'legacy-default',
  }];
}

async function fetchSiteGroupOptionsHttp(auth) {
  const response = await auth.client.get(`${auth.baseUrl}/api/user/self/groups`, {
    ...auth.apiHeaders,
    accept: 'application/json',
  });
  const text = response.text();
  const json = response.json();
  if (response.status !== 200 || !json?.success) {
    throw new Error(`${auth.site.name}: group list failed status=${response.status} body=${text.slice(0, 300)}`);
  }
  const options = normalizeLiveGroupOptions(json.data);
  if (!options.length) throw new Error(`${auth.site.name}: group list is empty`);
  return options;
}

function tokenNameForSelection(site, selection) {
  const baseName = site.tokenName || 'claude';
  if (selection.source === 'legacy-default') return baseName;
  const prefix = String(selection.value === '' ? 'empty' : selection.value).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `${prefix}-${baseName}`;
}

async function mintSiteKeysHttp(auth, selections, opts = {}) {
  const { site, baseUrl, client, apiHeaders, trace } = auth;
  const keys = [];
  for (const selection of selections || []) {
    const routing = site.name === 'a6api' && selection.source === 'fallback-routing'
      ? selection.routing
      : null;
    const createBody = {
      name: tokenNameForSelection(site, selection),
      remain_quota: resolveTokenRemainQuota(site, { random: opts.random }),
      expired_time: site.tokenExpiredTime ?? -1,
      unlimited_quota: resolveTokenUnlimitedQuota(site),
      model_limits_enabled: false,
      model_limits: '',
      allow_ips: '',
      group: routing ? (site.tokenGroup ?? 'default') : selection.value,
      cross_group_retry: false,
      ...(routing ? {
        routing_enabled: routing.routing_enabled ?? true,
        routing_preference: routing.routing_preference || 'cheap',
        pricing_strategy: routing.pricing_strategy || 'auto',
        pricing_custom_pct: routing.pricing_custom_pct || 50,
        routing_allow_fallback: routing.routing_allow_fallback ?? true,
      } : {}),
    };
    const tokenName = createBody.name;
    try {
      const createResp = await client.postJson(`${baseUrl}/api/token/`, createBody, apiHeaders);
      const createJson = createResp.json();
      if (!createJson?.success) throw new Error(`token create failed: ${JSON.stringify(createJson)}`);

      const listResp = await client.get(`${baseUrl}/api/token/?p=1&size=100`, { ...apiHeaders, accept: 'application/json' });
      const items = listResp.json()?.data?.items || [];
      if (items.length === 0) throw new Error('token list empty');
      // Match by unique token name (each profile has a distinct name), not by
      // created_time — same-second timestamps collide and reveal the wrong token.
      const matching = items.filter(t => t.name === tokenName);
      if (matching.length === 0) throw new Error(`token '${tokenName}' not found in list`);
      const target = matching.reduce((a, b) => (a.id > b.id ? a : b)); // newest id if name reused

      const keyResp = await client.postJson(`${baseUrl}/api/token/${target.id}/key`, null, { ...apiHeaders, 'content-length': '0' });
      const keyText = keyResp.text();
      const keyJson = keyResp.json();
      if (!keyJson?.success || !keyJson.data?.key) {
        throw new Error(`token key fetch failed status=${keyResp.status} body=${keyText.slice(0, 300)}`);
      }
      keys.push({
        apiKey: `sk-${keyJson.data.key}`,
        profile: routing ? (routing.name || selection.value) : null,
        ...(selection.source === 'legacy-default' ? {} : {
          group: selection.value,
          groupSource: selection.source,
        }),
      });
    } catch (err) {
      // One selected group failing must not abort the others.
      trace.push(`group_fail:${selection.value}:${String(err.message || err).slice(0, 120)}`);
    }
  }

  if (keys.length === 0) {
    throw new Error(`${site.name}: all token groups failed trace=${trace.join(' | ')}`);
  }

  return keys;
}

async function probeSiteGroupsHttp(site, githubCookies, opts = {}) {
  const authenticate = opts.authenticateFn || authenticateSiteOAuthHttp;
  const fetchGroups = opts.fetchGroupsFn || fetchSiteGroupOptionsHttp;
  const auth = await authenticate(site, githubCookies, opts);
  const options = await fetchGroups(auth, opts);
  return { site: site.name, baseUrl: auth.baseUrl, userId: auth.userId, options };
}

async function runSiteOAuthHttp(site, githubCookies, opts = {}) {
  const authenticate = opts.authenticateFn || authenticateSiteOAuthHttp;
  const mintKeys = opts.mintKeysFn || mintSiteKeysHttp;
  const auth = await authenticate(site, githubCookies, opts);
  const selections = resolveSiteSelections(site, opts);
  const keys = await mintKeys(auth, selections, opts);

  return {
    site: site.name,
    baseUrl: auth.baseUrl,
    userId: auth.userId,
    keys,
  };
}

async function runSitesOAuthHttp(sites, githubCookies, opts = {}) {
  const results = [];
  const failures = [];
  const runOne = opts.runSiteFn || runSiteOAuthHttp;
  for (const site of sites || []) {
    let siteResult;
    try {
      siteResult = await runOne(site, githubCookies, opts);
    } catch (err) {
      failures.push(`${site.name}: ${err.message}`);
      console.log(`  ⚠️ ${site.name} OAuth/Token 失败，继续其它站点: ${err.message}`);
      continue;
    }
    // Flatten: one entry per minted key (keys[] carries per-profile keys)
    for (const k of siteResult.keys || []) {
      results.push({
        site: siteResult.site,
        baseUrl: siteResult.baseUrl,
        userId: siteResult.userId,
        apiKey: k.apiKey,
        profile: k.profile,
        ...(Object.prototype.hasOwnProperty.call(k, 'group') ? { group: k.group } : {}),
        ...(k.groupSource ? { groupSource: k.groupSource } : {}),
      });
    }
  }
  if (results.length === 0 && failures.length > 0) {
    throw new Error(`all sites failed: ${failures.join(' | ')}`);
  }
  return results;
}

module.exports = {
  authenticateSiteOAuthHttp,
  fetchSiteGroupOptionsHttp,
  mintSiteKeysHttp,
  probeSiteGroupsHttp,
  resolveSiteSelections,
  runSiteOAuthHttp,
  runSitesOAuthHttp,
  extractInputs,
  followRedirects,
  sanitizeUrlForTrace,
  summarizeHtmlForTrace,
  extractCallbackUrlFromHtml,
  callbackUrlToApiUrl,
  completeTargetOAuthCallback,
};

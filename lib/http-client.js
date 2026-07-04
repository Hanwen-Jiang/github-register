const http = require('http');
const https = require('https');
const { init: initSocks, socksRequest } = require('../socks-agent');

function normalizeDomain(domain) {
  return String(domain || '').trim().replace(/^\./, '').toLowerCase();
}

function domainMatches(hostname, cookieDomain) {
  const host = String(hostname || '').toLowerCase();
  const domain = normalizeDomain(cookieDomain);
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath, cookiePath) {
  const reqPath = requestPath || '/';
  const cPath = cookiePath || '/';
  return reqPath === cPath || reqPath.startsWith(cPath.endsWith('/') ? cPath : `${cPath}/`);
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return v;
  }
  return undefined;
}

function splitSetCookieString(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  // Split on comma only when it begins a new cookie pair. This avoids Expires=Wed, ... breakage.
  return String(value).split(/,(?=\s*[^;,\s]+=)/g).map(s => s.trim()).filter(Boolean);
}

function parseSetCookie(setCookie, fallbackUrl) {
  const url = new URL(fallbackUrl);
  const parts = String(setCookie).split(';').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const eq = parts[0].indexOf('=');
  if (eq <= 0) return null;
  const cookie = {
    name: parts[0].slice(0, eq),
    value: parts[0].slice(eq + 1),
    domain: url.hostname,
    path: '/',
  };
  for (const attr of parts.slice(1)) {
    const idx = attr.indexOf('=');
    const key = (idx >= 0 ? attr.slice(0, idx) : attr).trim().toLowerCase();
    const val = idx >= 0 ? attr.slice(idx + 1).trim() : '';
    if (key === 'domain' && val) cookie.domain = val;
    if (key === 'path' && val) cookie.path = val;
  }
  return cookie;
}

class CookieJar {
  constructor() {
    this.cookies = [];
  }

  importPlaywrightCookies(cookies) {
    for (const c of cookies || []) {
      if (!c || !c.name) continue;
      this.setCookie({
        name: c.name,
        value: c.value || '',
        domain: c.domain || '',
        path: c.path || '/',
      });
    }
  }

  storeFromHeaders(url, headers) {
    const raw = getHeader(headers, 'set-cookie');
    for (const line of splitSetCookieString(raw)) {
      const parsed = parseSetCookie(line, url);
      if (parsed) this.setCookie(parsed);
    }
  }

  setCookie(cookie) {
    const normalized = {
      name: String(cookie.name),
      value: String(cookie.value || ''),
      domain: normalizeDomain(cookie.domain),
      path: cookie.path || '/',
    };
    const idx = this.cookies.findIndex(c =>
      c.name === normalized.name &&
      c.domain === normalized.domain &&
      c.path === normalized.path
    );
    if (idx >= 0) this.cookies[idx] = normalized;
    else this.cookies.push(normalized);
  }

  getCookieHeader(url) {
    const u = new URL(url);
    return this.cookies
      .filter(c => domainMatches(u.hostname, c.domain) && pathMatches(u.pathname || '/', c.path))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  }
}

function directRequest(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { ...(opts.headers || {}) };
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method: opts.method || 'GET',
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          text: () => body,
          json: () => { try { return JSON.parse(body); } catch (_) { return null; } },
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function createDefaultTransport(proxyUrl, deps = {}) {
  const direct = deps.directRequest || directRequest;
  const socks = deps.socksRequest || socksRequest;
  const init = deps.initSocks || initSocks;
  if (proxyUrl) {
    init(proxyUrl);
    return (url, opts) => socks(url, opts || {});
  }
  return (url, opts) => direct(url, opts || {});
}

function defaultHeaders() {
  return {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
  };
}

class HttpClient {
  constructor(opts = {}) {
    this.jar = opts.jar || new CookieJar();
    const makeTransport = opts.createTransport || createDefaultTransport;
    this.transport = opts.transport || makeTransport(opts.proxyUrl || process.env.PROXY || '');
    this.defaultHeaders = { ...defaultHeaders(), ...(opts.headers || {}) };
  }

  importPlaywrightCookies(cookies) {
    this.jar.importPlaywrightCookies(cookies);
  }

  async request(url, opts = {}) {
    const headers = { ...this.defaultHeaders, ...(opts.headers || {}) };
    const cookieHeader = this.jar.getCookieHeader(url);
    if (cookieHeader && !headers.cookie && !headers.Cookie) headers.cookie = cookieHeader;
    const resp = await this.transport(url, { ...opts, headers });
    this.jar.storeFromHeaders(url, resp.headers || {});
    return resp;
  }

  get(url, headers = {}) {
    return this.request(url, { method: 'GET', headers });
  }

  postForm(url, body, headers = {}) {
    const params = body instanceof URLSearchParams ? body : new URLSearchParams(body || {});
    return this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: params.toString(),
    });
  }

  postJson(url, body, headers = {}) {
    return this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*', ...headers },
      body: body === null ? '' : JSON.stringify(body || {}),
    });
  }
}

module.exports = {
  CookieJar,
  HttpClient,
  directRequest,
  createDefaultTransport,
  normalizeDomain,
  domainMatches,
  splitSetCookieString,
  parseSetCookie,
};

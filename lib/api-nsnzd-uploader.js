const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { init: initSocks, socksRequest } = require('../socks-agent');

const DEFAULT_BASE_URL = 'https://api.nsnzd.com';
const CLAUDE_MODELS = [
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-5-haiku-20241022',
  'claude-3-7-sonnet-20250219',
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-fable-5',
];

function loadDotEnv(file = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function normalizeAdminKey(key) {
  let value = String(key || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function summarizeSecret(value) {
  const s = String(value || '');
  if (!s) return { present: false, length: 0 };
  return {
    present: true,
    length: s.length,
    prefix: s.slice(0, Math.min(8, s.length)),
    suffix: s.slice(Math.max(0, s.length - 6)),
  };
}

function loadLatestResult(file = path.join(process.cwd(), 'data', 'results.jsonl')) {
  if (!fs.existsSync(file)) throw new Error(`results file not found: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error(`results file is empty: ${file}`);
  return JSON.parse(lines[lines.length - 1]);
}

function normalizeAccountName(text) {
  return String(text || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'github-register-key';
}

function formatUtcTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
  ].join('');
}

function randomSuffix(length = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryAsync(fn, opts = {}) {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? 1000;
  const factor = opts.factor ?? 2;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt + 1);
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      if (typeof opts.onRetry === 'function') {
        opts.onRetry(err, attempt + 1);
      }
      const wait = Math.max(0, Math.floor(delayMs * Math.pow(factor, attempt)));
      if (wait > 0) await sleep(wait);
    }
  }

  throw lastError;
}

function siteSlug(key = {}) {
  const raw = String(key.site || '').toLowerCase();
  if (raw.includes('cun')) return 'cun';
  if (raw.includes('a6')) return 'a6api';
  try {
    const host = new URL(key.baseUrl).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('cun')) return 'cun';
    if (host.includes('a6')) return 'a6api';
    return normalizeAccountName(host.split('.')[0] || host).toLowerCase();
  } catch (_) {
    return normalizeAccountName(raw || 'site').toLowerCase();
  }
}

function buildModelMappingFromIntersection(upstreamModels = [], claudeModels = CLAUDE_MODELS) {
  const allowed = new Set(claudeModels);
  const seen = new Set();
  const mapping = {};
  for (const model of upstreamModels) {
    const id = String(model || '').trim();
    if (!id || seen.has(id) || !allowed.has(id)) continue;
    seen.add(id);
    mapping[id] = id;
  }
  return mapping;
}

function buildAccountPayload(key, result = {}, opts = {}) {
  if (!key?.apiKey) throw new Error('missing apiKey in result key');
  if (!key?.baseUrl) throw new Error('missing baseUrl in result key');
  const labelParts = [
    opts.prefix || 'github-register',
    key.site || new URL(key.baseUrl).hostname,
    result.username || result.email || '',
    key.userId ? `u${key.userId}` : '',
  ].filter(Boolean);

  return {
    name: normalizeAccountName(labelParts.join('-')),
    notes: [
      `source=github-register`,
      result.source ? `run=${result.source}` : '',
      result.email ? `email=${result.email}` : '',
      result.username ? `github=${result.username}` : '',
      key.site ? `site=${key.site}` : '',
      key.userId ? `site_user_id=${key.userId}` : '',
    ].filter(Boolean).join('\n'),
    platform: 'openai',
    type: 'apikey',
    credentials: {
      base_url: String(key.baseUrl).replace(/\/+$/, ''),
      api_key: key.apiKey,
    },
    extra: {
      source: 'github-register',
      site: key.site || '',
      site_user_id: key.userId || '',
    },
    proxy_id: opts.proxyId ?? null,
    concurrency: opts.concurrency ?? 10,
    load_factor: null,
    priority: opts.priority ?? 1,
    rate_multiplier: opts.rateMultiplier ?? 1,
    group_ids: opts.groupIds || [],
    expires_at: null,
    auto_pause_on_expired: false,
  };
}

function buildAnthropicAccountName(key, opts = {}) {
  const timestamp = opts.timestamp || formatUtcTimestamp(opts.date || new Date());
  const suffix = opts.suffix || randomSuffix(10);
  const groupName = normalizeAccountName(opts.groupName || 'default').toLowerCase();
  return normalizeAccountName([
    'register',
    siteSlug(key),
    'anthropic',
    groupName,
    'gh',
    timestamp,
    suffix,
  ].join('-'));
}

function buildAnthropicAccountPayload(key, result = {}, opts = {}) {
  if (!key?.apiKey) throw new Error('missing apiKey in result key');
  if (!key?.baseUrl) throw new Error('missing baseUrl in result key');
  const modelMapping = opts.modelMapping || buildModelMappingFromIntersection(opts.upstreamModels || []);
  if (!modelMapping || Object.keys(modelMapping).length === 0) {
    throw new Error(`${key.site || key.baseUrl}: upstream Claude model intersection is empty`);
  }
  return {
    name: buildAnthropicAccountName(key, opts),
    notes: [
      'source=github-register',
      'format=anthropic',
      result.source ? `run=${result.source}` : '',
      result.email ? `email=${result.email}` : '',
      result.username ? `github=${result.username}` : '',
      key.site ? `site=${key.site}` : '',
      key.userId ? `site_user_id=${key.userId}` : '',
    ].filter(Boolean).join('\n'),
    platform: 'anthropic',
    type: 'apikey',
    credentials: {
      base_url: String(key.baseUrl).replace(/\/+$/, ''),
      api_key: key.apiKey,
      model_mapping: modelMapping,
    },
    extra: {
      source: 'github-register',
      site: key.site || '',
      site_user_id: key.userId || '',
      upstream_model_count: Array.isArray(opts.upstreamModels) ? opts.upstreamModels.length : undefined,
    },
    proxy_id: opts.proxyId ?? null,
    concurrency: opts.concurrency ?? 1,
    load_factor: null,
    priority: opts.priority ?? 1,
    rate_multiplier: opts.rateMultiplier ?? 1,
    group_ids: opts.groupIds || [],
    expires_at: null,
    auto_pause_on_expired: false,
  };
}

function normalizeResultKeys(result = {}) {
  const keys = Array.isArray(result?.keys) ? result.keys : [];
  const out = [];
  for (const key of keys) {
    if (key?.apiKey) {
      out.push(key);
      continue;
    }

    const nested = Array.isArray(key?.keys) ? key.keys : [];
    for (const item of nested) {
      if (typeof item === 'string') {
        out.push({
          site: key.site,
          baseUrl: key.baseUrl,
          userId: key.userId,
          apiKey: item,
        });
      } else if (item?.apiKey) {
        out.push({
          site: item.site || key.site,
          baseUrl: item.baseUrl || key.baseUrl,
          userId: item.userId || key.userId,
          ...item,
        });
      }
    }
  }
  return out;
}

function buildAccountsFromResult(result, opts = {}) {
  const keys = normalizeResultKeys(result);
  if (keys.length === 0) throw new Error('latest result contains no keys');
  return keys.map(key => buildAccountPayload(key, result, opts));
}

function buildAnthropicAccountsFromResult(result, opts = {}) {
  const keys = normalizeResultKeys(result);
  if (keys.length === 0) throw new Error('latest result contains no keys');
  const timestamp = opts.timestamp || formatUtcTimestamp(opts.date || new Date());
  return keys.map((key, index) => {
    const upstreamModels =
      opts.upstreamModelsBySite?.[key.site] ||
      opts.upstreamModelsByBaseUrl?.[key.baseUrl] ||
      opts.upstreamModels ||
      [];
    const proxyIds = Array.isArray(opts.proxyIds) ? opts.proxyIds.filter(id => id !== null && id !== undefined) : [];
    return buildAnthropicAccountPayload(key, result, {
      ...opts,
      timestamp,
      suffix: opts.suffixBySite?.[key.site] || opts.suffix || randomSuffix(10),
      upstreamModels,
      proxyId: proxyIds.length > 0 ? proxyIds[index % proxyIds.length] : opts.proxyId,
    });
  });
}

function stripChunkTerminator(text) {
  return String(text || '').replace(/\r?\n0(?:\r?\n\r?\n?|\r?)$/, '');
}

function parsePossiblyNestedJson(text) {
  if (!text) return null;
  const cleaned = stripChunkTerminator(text).trim();
  if (!cleaned) return null;
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === 'string') {
      const inner = stripChunkTerminator(parsed).trim();
      if (!inner) return parsed;
      try { return JSON.parse(inner); } catch (_) { return parsed; }
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

async function parseApiResponse(resp, opts = {}) {
  const text = await resp.text();
  const json = parsePossiblyNestedJson(text);
  const cleanedText = stripChunkTerminator(text);
  const label = opts.label || 'api request';
  if (!resp.ok) {
    const message = json?.message || json?.detail || cleanedText.slice(0, 300) || resp.statusText;
    throw new Error(`${label} failed: HTTP ${resp.status} ${message}`);
  }
  if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
    throw new Error(`${label} failed: ${json.message || json.detail || json.code}`);
  }
  return json?.data ?? json ?? cleanedText;
}

function resolveApiNsnzdProxy(opts = {}, env = process.env) {
  if (opts.apiProxy) return opts.apiProxy;
  if (opts.adminProxy) return opts.adminProxy;

  const explicit = env.API_NSNZD_PROXY || env.UPLOAD_API_PROXY || env.ADMIN_API_PROXY || '';
  if (explicit) return explicit;

  if (
    env.API_NSNZD_PROXY_MODE === 'registration-proxy' ||
    env.UPLOAD_API_PROXY_MODE === 'registration-proxy'
  ) {
    return env.PROXY || '';
  }

  return '';
}

function buildApiTransport(opts = {}) {
  const deps = opts.deps || {};
  const proxyUrl = resolveApiNsnzdProxy(opts);
  if (proxyUrl) {
    const init = deps.initSocks || initSocks;
    const request = deps.socksRequest || socksRequest;
    init(proxyUrl);
    return async (url, reqOpts) => {
      const resp = await withTimeout(
        request(url, reqOpts || {}),
        opts.timeoutMs || 30000,
        `${url} (api proxy)`
      );
      const status = resp.status || 0;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        text: async () => resp.text(),
      };
    };
  }

  const fetchImpl = deps.fetchImpl || fetch;
  return (url, reqOpts) => fetchImpl(url, {
    ...(reqOpts || {}),
    signal: AbortSignal.timeout(opts.timeoutMs || 30000),
  });
}

async function uploadAccounts(accounts, opts = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const adminKey = normalizeAdminKey(opts.adminKey || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is not set');

  const request = opts.requestImpl || buildApiTransport(opts);
  const resp = await request(`${baseUrl}/api/v1/admin/accounts/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'x-api-key': adminKey,
    },
    body: JSON.stringify({ accounts }),
  });
  return parseApiResponse(resp, { label: 'api.nsnzd.com upload' });
}

async function apiNsnzdGet(pathname, opts = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const adminKey = normalizeAdminKey(opts.adminKey || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is not set');
  const request = opts.requestImpl || buildApiTransport(opts);
  const resp = await request(`${baseUrl}${pathname}`, {
    method: 'GET',
    headers: {
      'accept': 'application/json',
      'x-api-key': adminKey,
    },
  });
  return parseApiResponse(resp, { label: `api.nsnzd.com GET ${pathname}` });
}

function resolveConfiguredGroupId(opts = {}) {
  const env = opts.env || process.env;
  const raw = opts.groupId || env.API_NSNZD_DEFAULT_GROUP_ID || env.UPLOAD_GROUP_ID || env.GROUP_ID || '';
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizeGroupItems(groups) {
  const items = Array.isArray(groups) ? groups : (groups?.items || groups?.records || groups?.data || groups?.groups || []);
  return (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .map(group => ({
      ...group,
      id: Number.isFinite(Number(group.id)) ? Number(group.id) : group.id,
    }))
    .filter(group => group.id !== null && group.id !== undefined && group.id !== '');
}

function groupDisplayName(group = {}) {
  return String(group.name || group.group_name || group.title || group.label || `group-${group.id}`);
}

function isActiveGroup(group = {}) {
  const status = String(group.status || '').toLowerCase();
  if (!status) return group.enabled !== false && group.disabled !== true;
  return status === 'active' || status === 'enabled' || status === '1' || status === 'true';
}

function pickDefaultGroup(groups = []) {
  return groups.find(g => groupDisplayName(g).toLowerCase() === 'default')
    || groups.find(isActiveGroup)
    || groups[0]
    || null;
}

async function fetchUploadGroups(opts = {}) {
  const groups = await apiNsnzdGet('/api/v1/admin/groups/all?include_inactive=true', opts);
  const items = normalizeGroupItems(groups);
  if (items.length === 0) {
    throw new Error('no groups found on api.nsnzd.com');
  }
  return items;
}

function renderGroupList(groups = [], defaultGroup = null) {
  const lines = ['[Sub2API] 站内分组列表：'];
  groups.forEach((group, index) => {
    const status = group.status ? ` status=${group.status}` : '';
    const active = isActiveGroup(group) ? '' : ' inactive';
    const marker = defaultGroup && String(group.id) === String(defaultGroup.id) ? '  ← 默认' : '';
    lines.push(`  ${index + 1}) id=${group.id} name="${groupDisplayName(group)}"${status}${active}${marker}`);
  });
  lines.push('请输入要上传到的分组序号或 group id；直接回车使用默认分组。');
  return lines.join('\n');
}

function parseGroupSelection(answer, groups = [], defaultGroup = null) {
  const raw = String(answer || '').trim();
  if (!raw) return defaultGroup;

  const byId = groups.find(group => String(group.id) === raw);
  if (byId) return byId;

  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= groups.length) return groups[n - 1];

  const lowered = raw.toLowerCase();
  const byName = groups.find(group => groupDisplayName(group).toLowerCase() === lowered);
  if (byName) return byName;

  throw new Error(`invalid group selection: ${raw}; available=${groups.map(g => `${g.id}:${groupDisplayName(g)}`).join(',')}`);
}

function envFlag(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function shouldPromptForUploadGroup(opts = {}, env = process.env) {
  if (typeof opts.promptGroup === 'boolean') return opts.promptGroup;
  if (typeof opts.prompt === 'boolean') return opts.prompt;
  const explicit = envFlag(env.UPLOAD_GROUP_PROMPT ?? env.API_NSNZD_GROUP_PROMPT);
  if (explicit !== null) return explicit;
  return Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
}

async function promptUploadGroupSelection(groups, opts = {}) {
  const defaultGroup = opts.defaultGroup || pickDefaultGroup(groups);
  if (!defaultGroup) throw new Error('no upload group is selectable');
  const message = renderGroupList(groups, defaultGroup);

  if (typeof opts.promptFn === 'function') {
    const answer = await opts.promptFn({
      groups,
      defaultGroup,
      message,
      renderGroupList,
      formatGroupLabel: group => `id=${group.id} name="${groupDisplayName(group)}"`,
    });
    return parseGroupSelection(answer, groups, defaultGroup);
  }

  const readline = require('readline/promises');
  const rl = readline.createInterface({
    input: opts.input || process.stdin,
    output: opts.output || process.stdout,
  });
  try {
    const answer = await rl.question(`${message}\n选择上传分组 [${defaultGroup.id}]: `);
    return parseGroupSelection(answer, groups, defaultGroup);
  } finally {
    rl.close();
  }
}

const uploadGroupCache = new Map();

function uploadGroupCacheKey(opts = {}, env = process.env) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const adminKey = normalizeAdminKey(opts.adminKey || '');
  const keyHint = adminKey ? `${adminKey.slice(0, 8)}:${adminKey.slice(-6)}` : 'no-key';
  return `${baseUrl}|${keyHint}`;
}

function shouldCacheUploadGroup(opts = {}, env = process.env) {
  if (opts.cache === false) return false;
  const cacheFlag = envFlag(env.UPLOAD_GROUP_CACHE);
  if (cacheFlag !== null) return cacheFlag;
  const promptEachTime = envFlag(env.UPLOAD_GROUP_PROMPT_EACH_TIME);
  if (promptEachTime === true) return false;
  return true;
}

function normalizeUploadGroupSelection(group, groups = [], opts = {}) {
  if (!group) throw new Error('upload group selection is empty');
  if (typeof group === 'number' || typeof group === 'string') {
    const found = groups.find(g => String(g.id) === String(group));
    const id = Number.isFinite(Number(group)) ? Number(group) : group;
    return {
      id,
      name: found ? groupDisplayName(found) : (opts.groupName || `group-${id}`),
      group: found || { id, name: opts.groupName || `group-${id}` },
    };
  }
  const id = Number.isFinite(Number(group.id)) ? Number(group.id) : group.id;
  if (id === null || id === undefined || id === '') throw new Error('upload group selection has no id');
  return {
    id,
    name: groupDisplayName(group),
    group,
  };
}

async function resolveUploadGroup(opts = {}) {
  const env = opts.env || process.env;
  const configured = resolveConfiguredGroupId({ ...opts, env });
  const cacheable = shouldCacheUploadGroup(opts, env);
  const cacheKey = uploadGroupCacheKey(opts, env);

  if (cacheable && !configured && uploadGroupCache.has(cacheKey)) {
    return uploadGroupCache.get(cacheKey);
  }

  const groups = await fetchUploadGroups({ ...opts, env });
  let selected;
  if (configured) {
    selected = groups.find(group => String(group.id) === String(configured))
      || { id: configured, name: opts.groupName || `group-${configured}` };
  } else if (typeof opts.promptFn === 'function' || shouldPromptForUploadGroup(opts, env)) {
    selected = await promptUploadGroupSelection(groups, opts);
  } else {
    selected = pickDefaultGroup(groups);
  }

  const normalized = normalizeUploadGroupSelection(selected, groups, opts);
  if (cacheable && !configured) uploadGroupCache.set(cacheKey, normalized);
  return normalized;
}

async function resolveDefaultGroupId(opts = {}) {
  const configured = resolveConfiguredGroupId(opts);
  if (configured) return configured;

  const items = await fetchUploadGroups(opts);
  const defaultGroup = items.find(g => groupDisplayName(g).toLowerCase() === 'default');
  if (defaultGroup?.id) return defaultGroup.id;
  const activeGroup = items.find(isActiveGroup);
  if (activeGroup?.id) return activeGroup.id;
  if (items[0]?.id) return items[0].id;
  throw new Error(`default group not found on api.nsnzd.com; groups=${items.map(g => `${g.id || '?'}:${g.name || g.group_name || '?'}`).join(',') || 'empty'}`);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function defaultModelRequest(proxyUrl) {
  if (proxyUrl) {
    initSocks(proxyUrl);
    return async (url, { headers, timeoutMs }) => {
      // socksRequest has no built-in timeout; a dead proxy socket would hang forever.
      const resp = await withTimeout(
        socksRequest(url, { method: 'GET', headers }),
        timeoutMs || 30000,
        `${url} (proxy)`
      );
      const status = resp.status || 0;
      return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => resp.text() };
    };
  }
  return async (url, { headers, timeoutMs }) => {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs || 30000) });
    return { ok: resp.ok, status: resp.status, statusText: resp.statusText, text: async () => resp.text() };
  };
}

function resolveModelProxy(opts = {}, env = process.env) {
  if (opts.modelProxy) return opts.modelProxy;
  if (opts.proxy) return opts.proxy;

  const uploadModelProxy = env.UPLOAD_MODEL_PROXY || env.MODEL_FETCH_PROXY || '';
  if (uploadModelProxy) return uploadModelProxy;

  if (
    env.UPLOAD_MODEL_PROXY_MODE === 'registration-proxy' ||
    env.MODEL_FETCH_PROXY_MODE === 'registration-proxy'
  ) {
    return env.PROXY || '';
  }

  return '';
}

async function fetchUpstreamModels(key, opts = {}) {
  if (!key?.apiKey) throw new Error('missing apiKey in result key');
  if (!key?.baseUrl) throw new Error('missing baseUrl in result key');
  const base = String(key.baseUrl).replace(/\/+$/, '');
  const retries = opts.retries ?? parseInt(process.env.UPSTREAM_MODEL_FETCH_RETRIES || '2', 10);
  const delayMs = opts.retryDelayMs ?? parseInt(process.env.UPSTREAM_MODEL_FETCH_RETRY_DELAY_MS || '1500', 10);
  const proxyUrl = resolveModelProxy(opts);
  const requestImpl = opts.requestImpl || defaultModelRequest(proxyUrl);
  return retryAsync(async () => {
    const resp = await requestImpl(`${base}/v1/models`, {
      headers: { accept: 'application/json', authorization: `Bearer ${key.apiKey}` },
      timeoutMs: opts.timeoutMs || 30000,
    });
    const parsed = await parseApiResponse(resp, { label: `${key.site || base} /v1/models` });
    const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
    return rows.map(row => typeof row === 'string' ? row : row?.id).filter(Boolean);
  }, { retries, delayMs, onRetry: opts.onRetry });
}

async function buildAnthropicAccountsWithLiveModels(result, opts = {}) {
  const keys = normalizeResultKeys(result);
  const normalizedResult = { ...result, keys };
  const upstreamModelsBySite = {};
  const failuresBySite = {};
  const probeModels = opts.fetchUpstreamModelsFn || fetchUpstreamModels;
  for (const key of keys) {
    const site = key.site || key.baseUrl || 'unknown-site';
    if (upstreamModelsBySite[site]) continue;
    try {
      upstreamModelsBySite[site] = await probeModels(key, opts);
    } catch (err) {
      if (!failuresBySite[site]) failuresBySite[site] = [];
      failuresBySite[site].push(`${key.profile || 'default'}: ${err.message}`);
    }
  }

  const missingSites = [...new Set(keys.map(key => key.site || key.baseUrl || 'unknown-site'))]
    .filter(site => !upstreamModelsBySite[site]);
  if (missingSites.length > 0) {
    const details = missingSites.map(site => `${site} (${(failuresBySite[site] || []).join('; ') || 'no keys probed'})`).join(', ');
    throw new Error(`failed to fetch upstream models for ${details}`);
  }
  return buildAnthropicAccountsFromResult(normalizedResult, { ...opts, upstreamModelsBySite });
}

module.exports = {
  CLAUDE_MODELS,
  DEFAULT_BASE_URL,
  loadDotEnv,
  normalizeAdminKey,
  summarizeSecret,
  loadLatestResult,
  normalizeAccountName,
  formatUtcTimestamp,
  randomSuffix,
  retryAsync,
  siteSlug,
  buildModelMappingFromIntersection,
  normalizeResultKeys,
  buildAccountPayload,
  buildAccountsFromResult,
  buildAnthropicAccountName,
  buildAnthropicAccountPayload,
  buildAnthropicAccountsFromResult,
  buildAnthropicAccountsWithLiveModels,
  uploadAccounts,
  apiNsnzdGet,
  resolveApiNsnzdProxy,
  resolveDefaultGroupId,
  resolveUploadGroup,
  resolveConfiguredGroupId,
  resolveModelProxy,
  fetchUpstreamModels,
};

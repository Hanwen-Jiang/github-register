const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    proxy_id: null,
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
    proxy_id: null,
    concurrency: opts.concurrency ?? 1,
    load_factor: null,
    priority: opts.priority ?? 1,
    rate_multiplier: opts.rateMultiplier ?? 1,
    group_ids: opts.groupIds || [],
    expires_at: null,
    auto_pause_on_expired: false,
  };
}

function buildAccountsFromResult(result, opts = {}) {
  const keys = Array.isArray(result?.keys) ? result.keys : [];
  if (keys.length === 0) throw new Error('latest result contains no keys');
  return keys.map(key => buildAccountPayload(key, result, opts));
}

function buildAnthropicAccountsFromResult(result, opts = {}) {
  const keys = Array.isArray(result?.keys) ? result.keys : [];
  if (keys.length === 0) throw new Error('latest result contains no keys');
  const timestamp = opts.timestamp || formatUtcTimestamp(opts.date || new Date());
  return keys.map(key => {
    const upstreamModels =
      opts.upstreamModelsBySite?.[key.site] ||
      opts.upstreamModelsByBaseUrl?.[key.baseUrl] ||
      opts.upstreamModels ||
      [];
    return buildAnthropicAccountPayload(key, result, {
      ...opts,
      timestamp,
      suffix: opts.suffixBySite?.[key.site] || opts.suffix || randomSuffix(10),
      upstreamModels,
    });
  });
}

async function parseApiResponse(resp) {
  const text = await resp.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch (_) {}
  }
  if (!resp.ok) {
    const message = json?.message || json?.detail || text.slice(0, 300) || resp.statusText;
    throw new Error(`api.nsnzd.com upload failed: HTTP ${resp.status} ${message}`);
  }
  if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
    throw new Error(`api.nsnzd.com upload failed: ${json.message || json.detail || json.code}`);
  }
  return json?.data ?? json ?? text;
}

async function uploadAccounts(accounts, opts = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const adminKey = normalizeAdminKey(opts.adminKey || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is not set');

  const resp = await fetch(`${baseUrl}/api/v1/admin/accounts/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'x-api-key': adminKey,
    },
    body: JSON.stringify({ accounts }),
    signal: AbortSignal.timeout(opts.timeoutMs || 30000),
  });
  return parseApiResponse(resp);
}

async function apiNsnzdGet(pathname, opts = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const adminKey = normalizeAdminKey(opts.adminKey || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is not set');
  const resp = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      'accept': 'application/json',
      'x-api-key': adminKey,
    },
    signal: AbortSignal.timeout(opts.timeoutMs || 30000),
  });
  return parseApiResponse(resp);
}

async function resolveDefaultGroupId(opts = {}) {
  const groups = await apiNsnzdGet('/api/v1/admin/groups/all?include_inactive=true', opts);
  const items = Array.isArray(groups) ? groups : (groups.items || groups.records || groups.data || []);
  const group = items.find(g => String(g.name || g.group_name || '').toLowerCase() === 'default');
  if (!group?.id) throw new Error('default group not found on api.nsnzd.com');
  return group.id;
}

async function fetchUpstreamModels(key, opts = {}) {
  if (!key?.apiKey) throw new Error('missing apiKey in result key');
  if (!key?.baseUrl) throw new Error('missing baseUrl in result key');
  const base = String(key.baseUrl).replace(/\/+$/, '');
  const resp = await fetch(`${base}/v1/models`, {
    headers: {
      'accept': 'application/json',
      'authorization': `Bearer ${key.apiKey}`,
    },
    signal: AbortSignal.timeout(opts.timeoutMs || 30000),
  });
  const parsed = await parseApiResponse(resp);
  const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
  return rows.map(row => typeof row === 'string' ? row : row?.id).filter(Boolean);
}

async function buildAnthropicAccountsWithLiveModels(result, opts = {}) {
  const keys = Array.isArray(result?.keys) ? result.keys : [];
  const upstreamModelsBySite = {};
  for (const key of keys) {
    upstreamModelsBySite[key.site] = await fetchUpstreamModels(key, opts);
  }
  return buildAnthropicAccountsFromResult(result, { ...opts, upstreamModelsBySite });
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
  siteSlug,
  buildModelMappingFromIntersection,
  buildAccountPayload,
  buildAccountsFromResult,
  buildAnthropicAccountName,
  buildAnthropicAccountPayload,
  buildAnthropicAccountsFromResult,
  buildAnthropicAccountsWithLiveModels,
  uploadAccounts,
  apiNsnzdGet,
  resolveDefaultGroupId,
  fetchUpstreamModels,
};

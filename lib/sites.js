// lib/sites.js — playwright-free guide-site config + target resolution.
//
// Extracted from index.js so Stage B (oauth-site.js) and oauth-only.js can import
// the site list WITHOUT pulling in playwright (index.js requires playwright, which
// is not installed locally → makes the site config untestable if left there).
//
// A "guide-site" is a new-api instance that authenticates via GitHub OAuth. Adding
// a future site = add an entry here; no code changes elsewhere.

const {
  DEFAULT_TOKEN_REMAIN_QUOTA,
  DEFAULT_TOKEN_UNLIMITED_QUOTA,
  parseBoolEnv,
  parseIntEnv,
  tokenEnvDefaults,
  cunAiTokenEnvDefaults,
} = require('./token-defaults');

function tokenDefaults(defaultName) {
  return tokenEnvDefaults(process.env, defaultName);
}

// Two new-api sites under their own GitHub OAuth Apps.
const SITES = [
  {
    name: 'cun.ai',
    baseUrl: 'https://www.cun.ai',
    clientId: 'Ov23lipURdGRYDGN2jII',
    ...cunAiTokenEnvDefaults(process.env, 'claude'),
  },
  {
    name: 'a6api',
    baseUrl: 'https://a6api.com',
    clientId: 'Ov23ligFZ3T5H8HuvWO9',
    ...tokenDefaults('claude'),
  },
  {
    name: 'xyc.ai',
    baseUrl: 'https://xyc.ai',
    clientId: 'Ov23liak6JMFvY7RqhuV',
    ...tokenDefaults('codex'),
    tokenGroup: '',
  },
];

// Resolve a comma-separated filter (SITE_LIST / SITE env, or explicit arg) against
// SITES by name or baseUrl substring. Empty filter → all sites.
function resolveTargetSites(filterRaw, sites = SITES) {
  const raw = String(filterRaw == null ? (process.env.SITE_LIST || process.env.SITE || '') : filterRaw).trim();
  const filters = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!filters.length) return sites.slice();
  return sites.filter(s => filters.some(f => s.name.includes(f) || s.baseUrl.includes(f)));
}

// a6api-only fallback when its live group endpoint is unavailable.
const DEFAULT_ROUTING_PROFILES = [
  { name: 'dynamic-cheap', routing_enabled: true, routing_preference: 'cheap', pricing_strategy: 'auto', routing_allow_fallback: true },
  { name: 'dynamic-fast', routing_enabled: true, routing_preference: 'fast', pricing_strategy: 'auto', routing_allow_fallback: true },
  { name: 'dynamic-stable', routing_enabled: true, routing_preference: 'stable', pricing_strategy: 'auto', routing_allow_fallback: true },
  { name: 'dynamic-quality', routing_enabled: true, routing_preference: 'quality', pricing_strategy: 'auto', routing_allow_fallback: true },
];

// Parse ROUTING_PROFILES env (JSON array) or fall back to the default set.
function resolveRoutingProfiles(raw = process.env.ROUTING_PROFILES) {
  const s = String(raw || '').trim();
  if (!s) return DEFAULT_ROUTING_PROFILES;
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_ROUTING_PROFILES;
  } catch (e) {
    console.warn(`⚠️  ROUTING_PROFILES parse failed, using default: ${e.message}`);
    return DEFAULT_ROUTING_PROFILES;
  }
}

// Precomputed default target list honoring SITE_LIST/SITE at load time (matches the
// old index.js TARGET_SITES semantics for backward compatibility).
const TARGET_SITES = resolveTargetSites();

module.exports = {
  SITES, TARGET_SITES, resolveTargetSites,
  DEFAULT_ROUTING_PROFILES, resolveRoutingProfiles,
  DEFAULT_TOKEN_REMAIN_QUOTA, DEFAULT_TOKEN_UNLIMITED_QUOTA,
  parseBoolEnv, parseIntEnv,
};

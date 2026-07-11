// Shared defaults for new-api token creation.
// quota_per_unit observed from target sites: 500000 units = $1.
const TOKEN_QUOTA_UNIT_PER_USD = 500_000;
const DEFAULT_TOKEN_REMAIN_QUOTA = 0;
const DEFAULT_TOKEN_UNLIMITED_QUOTA = true;
const DEFAULT_CUNAI_TOKEN_QUOTA_MIN_USD = 21;
const DEFAULT_CUNAI_TOKEN_QUOTA_MAX_USD = 50;

function parseBoolEnv(value, fallback = false) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return fallback;
}

function parseIntEnv(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function randomIntInclusive(min, max, random = Math.random) {
  const lo = Math.ceil(Number(min));
  const hi = Math.floor(Number(max));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`invalid random range: ${min}-${max}`);
  if (hi < lo) return lo;
  const r = Math.min(Math.max(Number(random()), 0), 0.999999999999);
  return lo + Math.floor(r * (hi - lo + 1));
}

function quotaUnitsFromUsd(usd) {
  return Math.floor(Number(usd) * TOKEN_QUOTA_UNIT_PER_USD);
}

function tokenEnvDefaults(env = process.env, defaultName = 'claude') {
  return {
    tokenName: env.TOKEN_NAME || defaultName,
    tokenUnlimitedQuota: parseBoolEnv(env.TOKEN_UNLIMITED_QUOTA, DEFAULT_TOKEN_UNLIMITED_QUOTA),
    tokenExpiredTime: parseIntEnv(env.TOKEN_EXPIRED_TIME, -1),
    tokenRemainQuota: parseIntEnv(env.TOKEN_REMAIN_QUOTA, DEFAULT_TOKEN_REMAIN_QUOTA),
  };
}

function cunAiTokenEnvDefaults(env = process.env, defaultName = 'claude') {
  const defaults = tokenEnvDefaults(env, defaultName);
  const rawQuota = String(env.CUNAI_TOKEN_REMAIN_QUOTA ?? '').trim();
  const minUsd = Math.max(
    DEFAULT_CUNAI_TOKEN_QUOTA_MIN_USD,
    parseIntEnv(env.CUNAI_TOKEN_QUOTA_MIN_USD, DEFAULT_CUNAI_TOKEN_QUOTA_MIN_USD)
  );
  const maxUsd = Math.max(
    minUsd,
    parseIntEnv(env.CUNAI_TOKEN_QUOTA_MAX_USD, DEFAULT_CUNAI_TOKEN_QUOTA_MAX_USD)
  );

  return {
    ...defaults,
    tokenUnlimitedQuota: parseBoolEnv(env.CUNAI_TOKEN_UNLIMITED_QUOTA, false),
    tokenExpiredTime: parseIntEnv(env.CUNAI_TOKEN_EXPIRED_TIME, defaults.tokenExpiredTime),
    ...(rawQuota && !/^random$/i.test(rawQuota)
      ? { tokenRemainQuota: parseIntEnv(rawQuota, quotaUnitsFromUsd(minUsd)) }
      : {
          tokenRemainQuota: undefined,
          tokenRemainQuotaRandom: true,
          tokenRemainQuotaMinUsd: minUsd,
          tokenRemainQuotaMaxUsd: maxUsd,
        }),
  };
}

function resolveTokenRemainQuota(site = {}, opts = {}) {
  if (site.tokenRemainQuotaRandom) {
    const minUsd = Math.max(DEFAULT_CUNAI_TOKEN_QUOTA_MIN_USD, Number(site.tokenRemainQuotaMinUsd || DEFAULT_CUNAI_TOKEN_QUOTA_MIN_USD));
    const maxUsd = Math.max(minUsd, Number(site.tokenRemainQuotaMaxUsd || DEFAULT_CUNAI_TOKEN_QUOTA_MAX_USD));
    return quotaUnitsFromUsd(randomIntInclusive(minUsd, maxUsd, opts.random || Math.random));
  }
  return site.tokenRemainQuota ?? DEFAULT_TOKEN_REMAIN_QUOTA;
}

function resolveTokenUnlimitedQuota(site = {}) {
  return site.tokenUnlimitedQuota ?? DEFAULT_TOKEN_UNLIMITED_QUOTA;
}

module.exports = {
  TOKEN_QUOTA_UNIT_PER_USD,
  DEFAULT_TOKEN_REMAIN_QUOTA,
  DEFAULT_TOKEN_UNLIMITED_QUOTA,
  DEFAULT_CUNAI_TOKEN_QUOTA_MIN_USD,
  DEFAULT_CUNAI_TOKEN_QUOTA_MAX_USD,
  parseBoolEnv,
  parseIntEnv,
  randomIntInclusive,
  quotaUnitsFromUsd,
  tokenEnvDefaults,
  cunAiTokenEnvDefaults,
  resolveTokenRemainQuota,
  resolveTokenUnlimitedQuota,
};

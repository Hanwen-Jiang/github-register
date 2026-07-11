#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { main: runOauthSite } = require('./oauth-site');
const { loadDotEnv, normalizeAdminKey, resolveUploadGroup } = require('./lib/api-nsnzd-uploader');

function applyDotEnv(env = process.env) {
  const values = loadDotEnv();
  for (const [key, value] of Object.entries(values)) {
    if (!(key in env)) env[key] = value;
  }
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function delayMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // CLI convenience: humans often pass 30/60/120 meaning seconds even
  // though the env var kept the historical *_MS name. Preserve explicit ms
  // values by treating only sub-second-threshold values as seconds.
  return Math.floor(n < 1000 ? n * 1000 : n);
}

function failLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return Infinity;
  return Math.floor(n);
}

function buildBatchConfig(env = process.env) {
  const total = num(env.OAUTH_SITE_BATCH_TOTAL || env.OAUTH_SITE_TOTAL || env.TOTAL, 1);
  const delayMinMs = delayMs(env.OAUTH_SITE_BATCH_DELAY_MIN_MS || env.OAUTH_SITE_DELAY_MIN_MS, 30000);
  const delayMaxMs = Math.max(
    delayMinMs,
    delayMs(env.OAUTH_SITE_BATCH_DELAY_MAX_MS || env.OAUTH_SITE_DELAY_MAX_MS, 60000)
  );
  const consecutiveFailLimit = failLimit(env.OAUTH_SITE_BATCH_FAIL_LIMIT || env.OAUTH_SITE_FAIL_LIMIT, 3);
  return { total, delayMinMs, delayMaxMs, failLimit: consecutiveFailLimit };
}

function randomFloat() {
  return crypto.randomBytes(4).readUInt32BE(0) / 0x100000000;
}

function pickDelayMs(minMs, maxMs, random = randomFloat) {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(random() * (maxMs - minMs + 1));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUploadGroup(group = {}) {
  if (typeof group === 'number' || typeof group === 'string') {
    return { id: Number.isFinite(Number(group)) ? Number(group) : group, name: `group-${group}` };
  }
  if (!group?.id) throw new Error('upload group selection has no id');
  return {
    id: Number.isFinite(Number(group.id)) ? Number(group.id) : group.id,
    name: group.name || group.group?.name || group.group?.group_name || `group-${group.id}`,
  };
}

async function prepareBatchUploadGroupEnv(env = process.env, opts = {}) {
  const importToApi = opts.importToApi ?? env.OAUTH_SITE_IMPORT_API_NSNZD !== 'false';
  if (!importToApi) return null;
  const adminKey = normalizeAdminKey(opts.adminKey || env.API_NSNZD_COM_ADMIN_KEY || '');
  if (!adminKey) return null;

  const resolver = opts.resolveUploadGroupFn || resolveUploadGroup;
  const selected = normalizeUploadGroup(await resolver({
    adminKey,
    env,
    promptGroup: opts.promptGroup,
    promptFn: opts.promptFn,
    cache: opts.groupCache,
  }));
  env.UPLOAD_GROUP_ID = String(selected.id);
  env.UPLOAD_GROUP_NAME = selected.name;
  env.UPLOAD_GROUP_PROMPT = 'false';
  return selected;
}

async function runBatch(opts = {}) {
  const total = opts.total;
  const delayMinMs = opts.delayMinMs ?? 30000;
  const delayMaxMs = opts.delayMaxMs ?? 60000;
  const runOne = opts.runOne || (() => runOauthSite({}));
  const doSleep = opts.sleep || sleep;
  const random = opts.random || randomFloat;
  const log = opts.log === false ? () => {} : (opts.log || console.log);
  const consecutiveFailLimit = opts.failLimit ?? 3;

  let ok = 0;
  let failed = 0;
  let attempted = 0;
  let consecutiveFailures = 0;
  let stopped = false;
  while (ok < total) {
    attempted += 1;
    log(`[oauth-site-batch] run attempt=${attempted} ok=${ok}/${total}`);
    try {
      const res = await runOne();
      if (res?.success) {
        ok += 1;
        consecutiveFailures = 0;
      } else {
        failed += 1;
        consecutiveFailures += 1;
      }
    } catch (err) {
      failed += 1;
      consecutiveFailures += 1;
      log(`[oauth-site-batch] fail attempt=${attempted} ok=${ok}/${total}: ${err.message}`);
    }

    if (consecutiveFailures >= consecutiveFailLimit) {
      stopped = true;
      log(`[oauth-site-batch] stop after ${consecutiveFailures} consecutive failures (limit=${consecutiveFailLimit})`);
      break;
    }

    if (ok < total) {
      const delay = pickDelayMs(delayMinMs, delayMaxMs, random);
      log(`[oauth-site-batch] wait ${(delay / 1000).toFixed(1)}s`);
      await doSleep(delay);
    }
  }

  return stopped ? { total, ok, failed, attempted, stopped } : { total, ok, failed, attempted };
}

async function main() {
  applyDotEnv();
  const uploadGroup = await prepareBatchUploadGroupEnv(process.env);
  if (uploadGroup) console.log(`[oauth-site-batch] upload group=${uploadGroup.name} (#${uploadGroup.id})`);
  const cfg = buildBatchConfig(process.env);
  const res = await runBatch(cfg);
  console.log(`[oauth-site-batch] done target_ok=${res.total} ok=${res.ok} failed=${res.failed} attempted=${res.attempted}${res.stopped ? ' stopped=true' : ''}`);
  if (res.stopped || res.ok < res.total) process.exitCode = 1;
  return res;
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  buildBatchConfig,
  delayMs,
  pickDelayMs,
  prepareBatchUploadGroupEnv,
  runBatch,
  main,
};

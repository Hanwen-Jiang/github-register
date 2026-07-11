#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { main: runOauthSite } = require('./oauth-site');
const { loadDotEnv, normalizeAdminKey, resolveUploadGroup } = require('./lib/api-nsnzd-uploader');
const sitesLibDefault = require('./lib/sites');
const storeDefault = require('./lib/session-store');
const { probeSiteGroupsHttp } = require('./lib/hybrid-oauth');
const {
  fallbackGroupOptions,
  promptSiteGroupSelection,
  readGroupConfig,
  writeGroupConfig,
} = require('./lib/site-groups');

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

function parseBatchArgs(argv = process.argv.slice(2)) {
  const out = { reuseGroupConfig: false, groupConfigFile: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reuse-group-config') out.reuseGroupConfig = true;
    else if (argv[i] === '--group-config') out.groupConfigFile = argv[++i] || '';
  }
  return out;
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

function defaultGroupConfigFile(rootDir, env = process.env) {
  return path.resolve(env.OAUTH_SITE_GROUP_CONFIG_FILE || path.join(rootDir, 'data', 'oauth-site-batch-groups.json'));
}

function resolveBatchSessionFile(rootDir, env = process.env, opts = {}) {
  if (opts.sessionFile) return path.resolve(opts.sessionFile);
  if (env.SESSION_STORE_FILE || env.SESSIONS_FILE) return path.resolve(env.SESSION_STORE_FILE || env.SESSIONS_FILE);
  const candidates = [
    path.join(rootDir, 'data', 'sessions.rescreened.usable.jsonl'),
    path.join(rootDir, 'data', 'sessions.win_gw_lou.usable.jsonl'),
  ];
  return candidates.find(file => fs.existsSync(file)) || path.join(rootDir, 'data', 'sessions.jsonl');
}

function applyBatchGroupConfigEnv(env, config, file) {
  if (config.uploadGroup) {
    env.UPLOAD_GROUP_ID = String(config.uploadGroup.id);
    env.UPLOAD_GROUP_NAME = String(config.uploadGroup.name || `group-${config.uploadGroup.id}`);
    env.UPLOAD_GROUP_PROMPT = 'false';
  }
  env.OAUTH_SITE_GROUP_CONFIG_FILE = file;
  return env;
}

async function prepareBatchGroupConfig(env = process.env, args = parseBatchArgs(), opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const sitesLib = opts.sitesLib || sitesLibDefault;
  const store = opts.store || storeDefault;
  const targetSites = opts.targetSites || sitesLib.resolveTargetSites();
  if (!targetSites.length) throw new Error('no target sites configured for oauth batch');
  const file = path.resolve(args.groupConfigFile || defaultGroupConfigFile(rootDir, env));
  const readConfig = opts.readGroupConfigFn || readGroupConfig;
  if (args.reuseGroupConfig) {
    const config = readConfig(file, targetSites);
    applyBatchGroupConfigEnv(env, config, file);
    const sessionFile = resolveBatchSessionFile(rootDir, env, opts);
    env.SESSION_STORE_FILE = sessionFile;
    return { config, file, sessionFile, targetSites, reused: true };
  }

  const uploadGroup = await prepareBatchUploadGroupEnv(env, opts);
  const sessionFile = resolveBatchSessionFile(rootDir, env, opts);
  env.SESSION_STORE_FILE = sessionFile;
  const routingProfiles = opts.routingProfiles || sitesLib.resolveRoutingProfiles();
  const findSession = opts.findSessionFn || (async site => store.findAvailableSession(site.name, { rootDir, file: sessionFile }));
  const getCookies = opts.getSessionCookiesFn || store.getSessionCookies;
  const probeGroups = opts.probeSiteGroupsFn || probeSiteGroupsHttp;
  const promptGroups = opts.promptSiteGroupSelectionFn || promptSiteGroupSelection;
  const siteSelections = {};

  for (const site of targetSites) {
    let options;
    let discoveryError = '';
    try {
      const session = await findSession(site);
      if (!session) throw new Error(`no usable session for ${site.name}`);
      const probe = await probeGroups(site, getCookies(session), {
        proxyUrl: require('./oauth-site').resolveSessionProxyUrl(session, env),
      });
      options = probe.options || probe;
      if (!Array.isArray(options) || !options.length) throw new Error(`${site.name}: group probe returned no options`);
    } catch (err) {
      discoveryError = String(err.message || err);
      options = fallbackGroupOptions(site, routingProfiles);
      if (opts.log !== false) console.log(`[oauth-site-batch] ${site.name} group discovery fallback: ${discoveryError}`);
    }
    const selected = await promptGroups(site, options, { promptFn: opts.sitePromptFn });
    siteSelections[site.name] = {
      source: options.every(option => option.source === options[0].source) ? options[0].source : 'mixed',
      selected,
      ...(discoveryError ? { discoveryError } : {}),
    };
  }

  const config = {
    version: 1,
    savedAt: new Date().toISOString(),
    uploadEnabled: Boolean(uploadGroup),
    uploadGroup: uploadGroup || null,
    sites: siteSelections,
  };
  const writeConfig = opts.writeGroupConfigFn || writeGroupConfig;
  writeConfig(file, config);
  applyBatchGroupConfigEnv(env, config, file);
  return { config, file, sessionFile, targetSites, reused: false };
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

async function main(opts = {}) {
  const env = opts.env || process.env;
  if (opts.loadEnv !== false) applyDotEnv(env);
  const args = opts.args || parseBatchArgs(opts.argv || process.argv.slice(2));
  const prepare = opts.prepareBatchGroupConfigFn || prepareBatchGroupConfig;
  const prepared = await prepare(env, args, opts);
  if (opts.log !== false) {
    const uploadGroup = prepared.config.uploadGroup;
    if (uploadGroup) console.log(`[oauth-site-batch] upload group=${uploadGroup.name} (#${uploadGroup.id})`);
    console.log(`[oauth-site-batch] group config=${prepared.file}${prepared.reused ? ' (reused)' : ''}`);
  }
  const cfg = { ...buildBatchConfig(env), ...(opts.runOne ? { runOne: opts.runOne } : {}) };
  const run = opts.runBatchFn || runBatch;
  const res = await run(cfg);
  if (opts.log !== false) console.log(`[oauth-site-batch] done target_ok=${res.total} ok=${res.ok} failed=${res.failed} attempted=${res.attempted}${res.stopped ? ' stopped=true' : ''}`);
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
  parseBatchArgs,
  delayMs,
  pickDelayMs,
  defaultGroupConfigFile,
  resolveBatchSessionFile,
  applyBatchGroupConfigEnv,
  prepareBatchGroupConfig,
  prepareBatchUploadGroupEnv,
  runBatch,
  main,
};

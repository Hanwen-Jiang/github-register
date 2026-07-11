'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

function normalizeLiveGroupOptions(data) {
  const entries = Array.isArray(data)
    ? data.map(item => [item?.value ?? item?.name ?? item?.id, item])
    : Object.entries(data && typeof data === 'object' ? data : {});
  return entries
    .filter(([value]) => value !== undefined && value !== null)
    .map(([rawValue, raw]) => {
      const item = raw && typeof raw === 'object' ? raw : {};
      const value = String(rawValue);
      const description = String(item.desc ?? item.description ?? item.label ?? item.name ?? value);
      return {
        value,
        label: String(item.label ?? item.desc ?? item.description ?? item.name ?? value),
        description,
        ratio: item.ratio,
        source: 'live',
      };
    });
}

function fallbackGroupOptions(site = {}, routingProfiles = []) {
  if (site.name === 'a6api') {
    return routingProfiles.map(profile => ({
      value: String(profile.name),
      label: String(profile.name),
      description: `a6api routing profile: ${profile.routing_preference || profile.name}`,
      source: 'fallback-routing',
      routing: { ...profile },
    }));
  }
  const value = site.tokenGroup ?? 'default';
  return [{
    value: String(value),
    label: value === '' ? '(空分组)' : String(value),
    description: '站点默认分组',
    source: 'fallback-default',
  }];
}

function parseGroupMultiSelection(answer, options = []) {
  const raw = String(answer ?? '').trim();
  if (!raw) throw new Error('at least one group must be selected');
  if (raw.toLowerCase() === 'all') return options.slice();
  const selected = [];
  const seen = new Set();
  for (const token of raw.split(',').map(item => item.trim()).filter(Boolean)) {
    const number = Number(token);
    let option = null;
    if (Number.isInteger(number) && number >= 1 && number <= options.length) option = options[number - 1];
    if (!option) option = options.find(item => String(item.value).toLowerCase() === token.toLowerCase());
    if (!option) option = options.find(item => String(item.label).toLowerCase() === token.toLowerCase());
    if (!option) throw new Error(`invalid group selection: ${token}`);
    const key = String(option.value);
    if (!seen.has(key)) {
      seen.add(key);
      selected.push(option);
    }
  }
  if (!selected.length) throw new Error('at least one group must be selected');
  return selected;
}

function renderSiteGroupOptions(site, options = []) {
  const lines = [`[${site.name}] 可创建 key 的分组：`];
  options.forEach((option, index) => {
    const ratio = option.ratio === undefined ? '' : ` ratio=${option.ratio}`;
    const source = option.source ? ` source=${option.source}` : '';
    lines.push(`  ${index + 1}) ${option.label} [${option.value || '<empty>'}]${ratio}${source}`);
  });
  lines.push('输入序号或分组值，多个用逗号分隔；输入 all 全选。');
  return lines.join('\n');
}

async function promptSiteGroupSelection(site, options, opts = {}) {
  if (!Array.isArray(options) || !options.length) throw new Error(`${site.name}: no selectable groups`);
  const message = renderSiteGroupOptions(site, options);
  if (typeof opts.promptFn === 'function') {
    const answer = await opts.promptFn({ site, options, message });
    return parseGroupMultiSelection(answer, options);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message}\n选择分组: `);
    return parseGroupMultiSelection(answer, options);
  } finally {
    rl.close();
  }
}

function validateGroupConfig(config, targetSites = []) {
  if (!config || typeof config !== 'object') throw new Error('group config must be an object');
  if (config.version !== 1) throw new Error(`unsupported group config version: ${config.version}`);
  const uploadId = config.uploadGroup?.id;
  if (config.uploadEnabled !== false && (uploadId === undefined || uploadId === null || uploadId === '')) {
    throw new Error('group config uploadGroup.id is required');
  }
  if (!config.sites || typeof config.sites !== 'object') throw new Error('group config sites are required');
  for (const site of targetSites) {
    const entry = config.sites[site.name];
    if (!entry) throw new Error(`group config missing target site: ${site.name}`);
    if (!Array.isArray(entry.selected) || !entry.selected.length) {
      throw new Error(`group config target site has no selections: ${site.name}`);
    }
    for (const option of entry.selected) {
      if (!option || !Object.prototype.hasOwnProperty.call(option, 'value')) {
        throw new Error(`group config selection has no value: ${site.name}`);
      }
    }
  }
  return config;
}

function writeGroupConfig(file, config) {
  validateGroupConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(temp, file);
  return file;
}

function readGroupConfig(file, targetSites = []) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`unable to read group config ${file}: ${err.message}`);
  }
  return validateGroupConfig(config, targetSites);
}

module.exports = {
  normalizeLiveGroupOptions,
  fallbackGroupOptions,
  parseGroupMultiSelection,
  renderSiteGroupOptions,
  promptSiteGroupSelection,
  validateGroupConfig,
  writeGroupConfig,
  readGroupConfig,
};

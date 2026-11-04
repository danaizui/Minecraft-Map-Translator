'use strict';

/**
 * Quest book translation:
 *  - FTB Quests (SNBT chapters, optional lang/en_us.snbt)
 *  - FTB Quests legacy NBT
 *  - Better Questing (JSON, keys like "name:8:0")
 *  - HQM and generic quest JSON/NBT under config/
 */

const fs = require('fs');
const path = require('path');
const util = require('./util');
const nbt = require('./nbt');
const snbt = require('./snbt');
const textUtil = require('./text');

function readText(file) {
  return util.decodeTextBuffer(fs.readFileSync(file));
}

function isLangFile(p) {
  return /[\\/]lang[\\/][^\\/]+\.(snbt|json)$/i.test(p);
}

function langCodeOf(p) {
  return path.basename(p).replace(/\.(snbt|json)$/i, '').toLowerCase();
}

function planQuests(instanceDir, options = {}) {
  const locale = options.locale || 'zh_cn';
  const tasks = [];
  const ftbRoot = path.join(instanceDir, 'config', 'ftbquests');
  const questsRoot = path.join(ftbRoot, 'quests');
  const langDir = path.join(questsRoot, 'lang');

  let hasLang = false;
  if (util.isDir(langDir)) {
    for (const ent of util.listDir(langDir)) {
      if (!ent.isFile()) continue;
      const low = ent.name.toLowerCase();
      if (low === 'en_us.snbt' || low === 'en_us.json') {
        const src = path.join(langDir, ent.name);
        const ext = path.extname(ent.name);
        const out = path.join(langDir, locale + ext);
        tasks.push({ type: ext === '.snbt' ? 'snbt' : 'json', file: src, out, mode: 'lang', label: 'FTB 任务书语言文件' });
        hasLang = true;
      }
    }
  }

  if (util.isDir(questsRoot)) {
    util.walk(questsRoot, (file) => {
      const low = file.toLowerCase();
      if (low.endsWith('.snbt')) {
        if (isLangFile(file) || /[\\/]lang[\\/]/.test(low)) return;
        if (hasLang) return; // lang file takes precedence, avoids duplicate edits
        tasks.push({ type: 'snbt', file, mode: 'quest', label: 'FTB 任务书' });
      } else if (low.endsWith('.nbt')) {
        tasks.push({ type: 'nbt', file, mode: 'quest', label: 'FTB 任务书（旧版）' });
      }
    });
  }

  // Legacy / other quest mods.
  const otherRoots = [
    path.join(instanceDir, 'config', 'betterquesting'),
    path.join(instanceDir, 'config', 'hqm'),
    path.join(instanceDir, 'config', 'quests'),
  ];
  for (const root of otherRoots) {
    if (!util.isDir(root)) continue;
    util.walk(root, (file) => {
      const low = file.toLowerCase();
      if (low.endsWith('.json')) {
        if (low.endsWith('namecache.json')) return;
        tasks.push({ type: 'json', file, mode: 'quest', label: '任务书 JSON' });
      } else if (low.endsWith('.nbt')) {
        tasks.push({ type: 'nbt', file, mode: 'quest', label: '任务书 NBT' });
      }
    });
  }

  return util.uniqueBy(tasks, (t) => t.file.toLowerCase());
}

function collectJsonStrings(obj, key, mode, out, holders) {
  if (Array.isArray(obj)) {
    for (const item of obj) collectJsonStrings(item, key, mode, out, holders);
    return;
  }
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const base = textUtil.normalizeKey(k);
    if (typeof v === 'string') {
      out.push({ text: v, key: base, mode });
      holders.push({ obj, key: k });
    } else if (v && typeof v === 'object') {
      collectJsonStrings(v, base, mode, out, holders);
    }
  }
}

async function translateJsonFile(file, outFile, translator, ctx, mode) {
  const raw = readText(file);
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error('JSON 解析失败: ' + e.message);
  }
  const items = [];
  const holders = [];
  collectJsonStrings(data, null, mode, items, holders);
  if (!items.length) return { changed: false, total: 0, translated: 0 };
  const results = await translator.translateBatch(items);
  let changed = 0;
  for (let i = 0; i < items.length; i++) {
    const r = results[i];
    if (r != null && r !== items[i].text) {
      holders[i].obj[holders[i].key] = r;
      changed++;
    }
  }
  if (!changed) return { changed: false, total: items.length, translated: 0 };
  const indent = util.detectIndent(raw);
  const trailing = /\n$/.test(raw) ? '\n' : '';
  const body = JSON.stringify(data, null, indent) + trailing;
  ctx.writeFile(outFile || file, body);
  return { changed: true, total: items.length, translated: changed };
}

function collectNbtStrings(tag, key, mode, out, holders) {
  if (!tag) return;
  if (tag.type === nbt.TAG.String) {
    out.push({ text: tag.value, key: textUtil.normalizeKey(key), mode });
    holders.push({ tag });
    return;
  }
  if (tag.type === nbt.TAG.List) {
    for (const item of tag.value.items) collectNbtStrings(item, key, mode, out, holders);
    return;
  }
  if (tag.type === nbt.TAG.Compound) {
    for (const [k, v] of Object.entries(tag.value)) collectNbtStrings(v, k, mode, out, holders);
  }
}

async function translateNbtFile(file, outFile, translator, ctx, mode) {
  const parsed = nbt.readFile(file);
  const items = [];
  const holders = [];
  collectNbtStrings(parsed.tag, null, mode, items, holders);
  if (!items.length) return { changed: false, total: 0, translated: 0 };
  const results = await translator.translateBatch(items);
  let changed = 0;
  for (let i = 0; i < items.length; i++) {
    const r = results[i];
    if (r != null && r !== items[i].text) {
      holders[i].tag.value = r;
      changed++;
    }
  }
  if (!changed) return { changed: false, total: items.length, translated: 0 };
  const target = outFile || file;
  const data = nbt.serialize(parsed.name, parsed.tag);
  const writer = parsed.gzip ? require('zlib').gzipSync(data, { level: 6 }) : data;
  ctx.writeBuffer(target, writer);
  return { changed: true, total: items.length, translated: changed };
}

async function translateSnbtFile(file, outFile, translator, ctx, mode) {
  const raw = readText(file);
  const res = await snbt.translateSnbt(raw, translator, { mode });
  if (!res.changed) return { changed: false, total: res.total, translated: 0 };
  ctx.writeFile(outFile || file, res.text);
  return { changed: true, total: res.total, translated: res.translated };
}

async function runQuestTask(task, translator, ctx) {
  if (task.type === 'snbt') return translateSnbtFile(task.file, task.out, translator, ctx, task.mode);
  if (task.type === 'json') return translateJsonFile(task.file, task.out, translator, ctx, task.mode);
  if (task.type === 'nbt') return translateNbtFile(task.file, task.out, translator, ctx, task.mode);
  throw new Error('未知任务类型 ' + task.type);
}

module.exports = { planQuests, runQuestTask, translateJsonFile, translateNbtFile, translateSnbtFile };

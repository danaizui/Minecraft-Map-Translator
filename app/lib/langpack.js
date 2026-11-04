'use strict';

/**
 * Mod language files -> generated Chinese resource pack.
 * Never edits mod jars. Supports en_us.json / en_us.lang, KubeJS assets and
 * optionally Patchouli guide books.
 */

const fs = require('fs');
const path = require('path');
const util = require('./util');
const zip = require('./zip');
const textUtil = require('./text');

function localeForTarget(target) {
  return target === 'zh-Hant' ? 'zh_tw' : 'zh_cn';
}

// Legacy .lang files use `zh_CN.lang` (lowercase language, uppercase region).
function legacyLangFile(target) {
  return target === 'zh-Hant' ? 'zh_TW.lang' : 'zh_CN.lang';
}

function parseVersion(name) {
  const m = String(name).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

function packFormatForVersion(v) {
  if (!v) return 15;
  const [a, b, c] = v;
  if (a !== 1) return 15;
  if (b <= 12) return 3;
  if (b <= 14) return 4;
  if (b === 15) return 5;
  if (b === 16) return c <= 1 ? 5 : 6;
  if (b === 17) return 7;
  if (b === 18) return 8;
  if (b === 19) return c <= 2 ? 9 : (c === 3 ? 12 : 13);
  if (b === 20) {
    if (c <= 1) return 15;
    if (c === 2) return 18;
    if (c <= 4) return 22;
    return 32;
  }
  if (b === 21) {
    if (c <= 1) return 34;
    if (c <= 3) return 42;
    if (c === 4) return 46;
    return 55;
  }
  return 15;
}

function guessVersion(instanceDir) {
  const candidates = [];
  const versionRoot = path.join(instanceDir, 'versions');
  for (const ent of util.listDir(versionRoot)) {
    if (ent.isDirectory()) candidates.push(ent.name);
  }
  for (const f of ['minecraft_version.txt', 'version.txt', '.minecraft-version', 'instance.cfg']) {
    const p = path.join(instanceDir, f);
    if (util.isFile(p)) {
      try {
        const t = fs.readFileSync(p, 'utf8').slice(0, 4000);
        const m = t.match(/MCVersion\s*[=:]\s*([0-9][^\s\r\n]*)/i);
        if (m) candidates.push(m[1]);
        else {
          const m2 = t.match(/\b1\.(?:[0-9]{1,2})(?:\.[0-9]{1,2})?\b/);
          if (m2) candidates.push(m2[0]);
        }
      } catch (_) {}
    }
  }
  candidates.sort((a, b) => {
    const va = parseVersion(a), vb = parseVersion(b);
    if (!va) return 1;
    if (!vb) return -1;
    return vb[0] - va[0] || vb[1] - va[1] || vb[2] - va[2];
  });
  for (const c of candidates) {
    const v = parseVersion(c);
    if (v) return { version: c, format: packFormatForVersion(v) };
  }
  return { version: null, format: 15 };
}

function listLangEntryNames(jarFile, patchouli) {
  const re = patchouli
    ? /^assets\/[^/]+\/(?:lang\/en_us\.(?:json|lang)|patchouli_books\/.+\/en_us\/.+\.json)$/i
    : /^assets\/[^/]+\/lang\/en_us\.(?:json|lang)$/i;
  try { return zip.listNames(jarFile, (n) => re.test(n)); } catch (_) { return []; }
}

function planLang(instanceDir, options = {}) {
  const jarTasks = [];
  const modsDir = path.join(instanceDir, 'mods');
  for (const ent of util.listDir(modsDir)) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.jar')) continue;
    const jar = path.join(modsDir, ent.name);
    const names = listLangEntryNames(jar, !!options.patchouli);
    if (names.length) jarTasks.push({ type: 'jar', jar, names, label: ent.name });
  }

  const kubeRoot = path.join(instanceDir, 'kubejs', 'assets');
  const kubeTasks = [];
  if (util.isDir(kubeRoot)) {
    util.walk(kubeRoot, (file) => {
      if (/[\\/]lang[\\/]en_us\.json$/i.test(file)) {
        const parts = file.split(/[\\/]/);
        const ns = parts[parts.length - 3];
        kubeTasks.push({ type: 'single', file, ns, label: 'KubeJS ' + ns });
      }
    });
  }

  const info = options.packFormat && options.packFormat !== 'auto'
    ? { version: null, format: Number(options.packFormat) || 15 }
    : guessVersion(instanceDir);

  return {
    instanceDir,
    packDir: path.join(instanceDir, 'resourcepacks', options.packName || 'MC翻译_中文资源包'),
    tasks: jarTasks.concat(kubeTasks),
    packFormat: info.format,
    detectedVersion: info.version,
  };
}

function parseLang(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  return {
    eol,
    lines: lines.map((line) => {
      const trimmed = line.trimStart();
      if (!line.trim() || trimmed.startsWith('#') || trimmed.startsWith('!')) return { raw: line };
      const idx = line.indexOf('=');
      if (idx < 0) return { raw: line };
      return { key: line.slice(0, idx).trim(), prefix: line.slice(0, idx + 1), value: line.slice(idx + 1) };
    }),
  };
}

function collectJsonStrings(obj, items, holders, parentKey) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      if (typeof v === 'string') {
        items.push({ text: v, key: parentKey || 'text', mode: 'lang' });
        holders.push({ arr: obj, index: i });
      } else if (v && typeof v === 'object') {
        collectJsonStrings(v, items, holders, parentKey);
      }
    }
    return;
  }
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      items.push({ text: v, key: k, mode: 'lang' });
      holders.push({ obj, key: k });
    } else if (v && typeof v === 'object') {
      collectJsonStrings(v, items, holders, k);
    }
  }
}

async function runLangTask(task, translator, ctx, options = {}) {
  const locale = localeForTarget(translator.target);
  const entries = [];
  if (task.type === 'single') {
    const name = 'assets/' + task.ns + '/lang/en_us.json';
    entries.push({ name, data: fs.readFileSync(task.file) });
  } else {
    const re = options.patchouli
      ? /^assets\/[^/]+\/(?:lang\/en_us\.(?:json|lang)|patchouli_books\/.+\/en_us\/.+\.json)$/i
      : /^assets\/[^/]+\/lang\/en_us\.(?:json|lang)$/i;
    for (const e of zip.readEntries(task.jar, (n) => re.test(n))) entries.push(e);
  }

  const docs = [];
  const items = [];
  const holders = [];
  for (const ent of entries) {
    const m = ent.name.match(/^assets\/([^/]+)\//);
    if (!m) continue;
    const ns = m[1];
    if (ns === 'minecraft') continue;
    const low = ent.name.toLowerCase();
    const isPatchouli = low.includes('/patchouli_books/');
    if (!isPatchouli && low.endsWith('.json')) {
      let obj;
      try { obj = JSON.parse(util.decodeTextBuffer(ent.data)); } catch (_) { continue; }
      const before = items.length;
      collectJsonStrings(obj, items, holders);
      docs.push({ kind: 'json', ns, name: ent.name, obj, first: before, count: items.length - before });
    } else if (!isPatchouli && low.endsWith('.lang')) {
      const parsed = parseLang(util.decodeTextBuffer(ent.data));
      const before = items.length;
      for (const line of parsed.lines) {
        if (line.raw !== undefined) continue;
        items.push({ text: line.value, key: line.key, mode: 'lang' });
        holders.push({ line });
      }
      docs.push({ kind: 'lang', ns, name: ent.name, parsed, first: before, count: items.length - before });
    } else if (isPatchouli) {
      let obj;
      try { obj = JSON.parse(util.decodeTextBuffer(ent.data)); } catch (_) { continue; }
      const before = items.length;
      collectJsonStrings(obj, items, holders);
      docs.push({ kind: 'patchouli', ns, name: ent.name, obj, first: before, count: items.length - before });
    }
  }

  if (!items.length) return { changed: false, translated: 0, files: 0 };
  const results = await translator.translateBatch(items);
  let translated = 0;
  for (let i = 0; i < items.length; i++) {
    const r = results[i];
    if (r != null && r !== items[i].text) {
      const h = holders[i];
      if (h.obj) h.obj[h.key] = r;
      else if (h.line) h.line.value = r;
      else if (h.arr) h.arr[h.index] = r;
      translated++;
    }
  }
  if (!translated) return { changed: false, translated: 0, files: 0 };

  const mergedJson = new Map();
  const mergedLang = new Map();
  const patchouli = [];
  for (const doc of docs) {
    if (doc.kind === 'json') {
      let m = mergedJson.get(doc.ns);
      if (!m) { m = {}; mergedJson.set(doc.ns, m); }
      Object.assign(m, doc.obj);
    } else if (doc.kind === 'lang') {
      let m = mergedLang.get(doc.ns);
      if (!m) { m = { lines: [] }; mergedLang.set(doc.ns, m); }
      m.lines = m.lines.concat(doc.parsed.lines);
    } else {
      patchouli.push(doc);
    }
  }

  let files = 0;
  for (const [ns, obj] of mergedJson) {
    const p = path.join(ctx.packDir, 'assets', ns, 'lang', locale + '.json');
    ctx.writeBuffer(p, Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8'));
    files++;
  }
  for (const [ns, doc] of mergedLang) {
    const body = doc.lines.map((l) => (l.raw !== undefined ? l.raw : l.prefix + l.value)).join('\n').replace(/\n+$/, '') + '\n';
    const p = path.join(ctx.packDir, 'assets', ns, 'lang', legacyLangFile(translator.target));
    ctx.writeBuffer(p, Buffer.from(body, 'utf8'));
    files++;
  }
  for (const doc of patchouli) {
    const rel = doc.name.replace(/\/en_us\//, '/' + locale + '/');
    const p = path.join(ctx.packDir, ...rel.split('/'));
    ctx.writeBuffer(p, Buffer.from(JSON.stringify(doc.obj, null, 2) + '\n', 'utf8'));
    files++;
  }
  return { changed: true, translated, files };
}

function writePackMeta(ctx, packFormat) {
  const meta = {
    pack: {
      pack_format: Number(packFormat) || 15,
      description: '由 MC 地图翻译器自动生成 · 机器翻译 · 请勿手动修改',
    },
  };
  ctx.writeBuffer(path.join(ctx.packDir, 'pack.mcmeta'), Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8'));
  ctx.writeBuffer(path.join(ctx.packDir, '.mc-translator.json'), Buffer.from(JSON.stringify({
    generatedBy: 'MC Map Translator',
    generatedAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8'));
}

module.exports = {
  planLang, runLangTask, writePackMeta, localeForTarget, legacyLangFile,
  guessVersion, packFormatForVersion,
};

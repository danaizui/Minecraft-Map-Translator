'use strict';

/**
 * Orchestration: target detection, planning, execution, backup/undo, reports.
 */

const fs = require('fs');
const path = require('path');
const util = require('./util');
const nbt = require('./nbt');
const quests = require('./quests');
const world = require('./world');
const langpack = require('./langpack');
const { Translator } = require('./translate');

function levelName(worldDir) {
  try {
    const parsed = nbt.readFile(path.join(worldDir, 'level.dat'));
    const data = parsed.tag && parsed.tag.value && parsed.tag.value.Data;
    const name = data && data.value && data.value.LevelName;
    if (name && name.type === nbt.TAG.String && name.value.trim()) return name.value;
  } catch (_) {}
  return path.basename(worldDir);
}

function looksInstance(dir) {
  const names = ['mods', 'config', 'saves', 'versions', 'kubejs', 'resourcepacks'];
  return names.some((n) => util.isDir(path.join(dir, n))) || path.basename(dir).toLowerCase() === '.minecraft';
}

function addTarget(list, seen, t) {
  const key = (t.kind + '|' + path.resolve(t.path)).toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  list.push(t);
}

function detectTargets(rawPaths) {
  const targets = [];
  const warnings = [];
  const seen = new Set();
  for (const raw of rawPaths) {
    const p = path.resolve(String(raw || '').trim());
    if (!util.exists(p)) {
      warnings.push('路径不存在：' + p);
      continue;
    }
    if (util.isFile(p)) {
      if (p.toLowerCase().endsWith('.jar')) {
        const parent = path.dirname(p);
        if (path.basename(parent).toLowerCase() === 'mods') {
          const inst = path.dirname(parent);
          addTarget(targets, seen, { kind: 'instance', path: inst, label: path.basename(inst) || inst });
        } else {
          warnings.push('单个 jar 无法确定整合包位置，请选择整合包文件夹：' + p);
        }
      } else {
        warnings.push('不支持的文件：' + p);
      }
      continue;
    }
    if (world.isWorld(p)) {
      addTarget(targets, seen, { kind: 'world', path: p, label: levelName(p) });
      continue;
    }
    const base = path.basename(p).toLowerCase();
    if (base === 'saves') {
      let n = 0;
      for (const ent of util.listDir(p)) {
        const sub = path.join(p, ent.name);
        if (ent.isDirectory() && world.isWorld(sub)) {
          addTarget(targets, seen, { kind: 'world', path: sub, label: levelName(sub) });
          n++;
        }
      }
      if (!n) warnings.push('saves 文件夹中没有找到存档：' + p);
      continue;
    }
    if (base === 'mods') {
      const inst = path.dirname(p);
      addTarget(targets, seen, { kind: 'instance', path: inst, label: path.basename(inst) || inst });
      continue;
    }
    if (looksInstance(p)) {
      addTarget(targets, seen, { kind: 'instance', path: p, label: path.basename(p) || p });
      continue;
    }
    // Folder containing maps.
    let worlds = 0;
    for (const ent of util.listDir(p)) {
      const sub = path.join(p, ent.name);
      if (ent.isDirectory() && world.isWorld(sub)) {
        addTarget(targets, seen, { kind: 'world', path: sub, label: levelName(sub) });
        worlds++;
      }
    }
    if (worlds) continue;
    // Nested .minecraft folder (one level).
    let found = false;
    for (const ent of util.listDir(p)) {
      const sub = path.join(p, ent.name);
      if (ent.isDirectory() && looksInstance(sub)) {
        addTarget(targets, seen, { kind: 'instance', path: sub, label: path.basename(sub) });
        found = true;
      }
    }
    if (!found) {
      warnings.push('未识别为整合包 / 存档 / 地图文件夹：' + p + '（需要包含 mods、config、saves 或 level.dat）');
    }
  }
  return { targets, warnings };
}

function findSavesWorlds(instanceDir) {
  const out = [];
  const saves = path.join(instanceDir, 'saves');
  for (const ent of util.listDir(saves)) {
    const sub = path.join(saves, ent.name);
    if (ent.isDirectory() && world.isWorld(sub)) out.push(sub);
  }
  return out;
}

function expandTarget(target, options) {
  const locale = langpack.localeForTarget(options.target);
  const scope = options.scope || { quests: true, lang: true, world: true };
  const result = {
    target, quests: [], langs: [], worlds: [], packMeta: null, warnings: [],
  };
  if (target.kind === 'world') {
    result.worlds.push({ dir: target.path, label: target.label, plan: world.planWorld(target.path) });
    return result;
  }
  if (target.kind !== 'instance') return result;

  if (scope.lang) {
    const lp = langpack.planLang(target.path, {
      patchouli: !!options.patchouli,
      packName: options.packName || 'MC翻译_中文资源包',
      packFormat: options.packFormat || 'auto',
    });
    result.langs = lp.tasks;
    result.packMeta = { packDir: lp.packDir, packFormat: lp.packFormat, detectedVersion: lp.detectedVersion, instanceDir: target.path, label: target.label };
    if (!lp.tasks.length) result.warnings.push(target.label + '：mods 中没有找到 en_us 语言文件');
  }
  if (scope.quests) {
    result.quests = quests.planQuests(target.path, { locale });
    if (!result.quests.length) result.warnings.push(target.label + '：没有找到 FTB Quests / Better Questing 任务书');
  }
  if (scope.world) {
    for (const w of findSavesWorlds(target.path)) {
      result.worlds.push({ dir: w, label: levelName(w), plan: world.planWorld(w) });
    }
  }
  return result;
}

function buildPlan(options) {
  const { targets, warnings } = detectTargets(options.paths || []);
  const plans = [];
  const tasks = [];
  const packMetas = [];
  const warningsAll = warnings.slice();
  let questFiles = 0, jars = 0, regions = 0, dataFiles = 0, npcJson = 0, worldCount = 0;

  for (const t of targets) {
    const exp = expandTarget(t, options);
    warningsAll.push(...exp.warnings);
    const targetInfo = {
      kind: t.kind, path: t.path, label: t.label,
      quests: exp.quests.length,
      jars: exp.langs.filter((x) => x.type === 'jar').length,
      worlds: exp.worlds.length,
      regions: exp.worlds.reduce((a, w) => a + w.plan.regions.length, 0),
      dataFiles: exp.worlds.reduce((a, w) => a + w.plan.dataFiles.length, 0),
      npcJson: exp.worlds.reduce((a, w) => a + w.plan.jsonFiles.length, 0),
    };
    questFiles += targetInfo.quests;
    jars += targetInfo.jars;
    regions += targetInfo.regions;
    dataFiles += targetInfo.dataFiles;
    npcJson += targetInfo.npcJson;
    worldCount += targetInfo.worlds;

    for (const q of exp.quests) {
      tasks.push({ jtype: 'quest', task: q, file: q.file, label: q.label + ' · ' + path.basename(q.file), target: t.label });
    }
    for (const l of exp.langs) {
      tasks.push({ jtype: 'lang', task: l, file: l.jar || l.file, label: '语言文件 · ' + (l.label || path.basename(l.file || l.jar)), target: t.label, packDir: exp.packMeta ? exp.packMeta.packDir : null });
    }
    for (const w of exp.worlds) {
      for (const f of w.plan.regions) {
        tasks.push({ jtype: 'world', task: { type: 'region', file: f }, file: f, label: '地图区块 · ' + w.label + ' · ' + path.basename(f), target: t.label });
      }
      for (const f of w.plan.dataFiles) {
        tasks.push({ jtype: 'world', task: { type: 'data', file: f }, file: f, label: '计分板/数据 · ' + w.label + ' · ' + path.basename(f), target: t.label });
      }
      for (const f of w.plan.jsonFiles) {
        tasks.push({ jtype: 'world', task: { type: 'json', file: f }, file: f, label: 'NPC 对话 · ' + w.label + ' · ' + path.basename(f), target: t.label });
      }
    }
    if (exp.packMeta && exp.langs.length) packMetas.push(exp.packMeta);
    plans.push({ target: t, info: targetInfo });
  }

  // De-duplicate tasks by file when the user selected overlapping paths.
  const seen = new Set();
  const uniqueTasks = [];
  for (const t of tasks) {
    const key = (t.jtype + '|' + path.resolve(t.file)).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTasks.push(t);
  }
  const seenMeta = new Set();
  const uniqueMetas = packMetas.filter((m) => {
    const k = m.packDir.toLowerCase();
    if (seenMeta.has(k)) return false;
    seenMeta.add(k);
    return true;
  });

  if (!uniqueTasks.length) {
    warningsAll.push('没有找到可翻译的内容。请确认选择的是整合包根目录或存档文件夹。');
  }

  return {
    targets: targets.map((t) => ({ kind: t.kind, path: t.path, label: t.label, detail: plans.find((p) => p.target === t)?.info })),
    tasks: uniqueTasks,
    packMetas: uniqueMetas,
    warnings: util.uniqueBy(warningsAll, (w) => w),
    totals: { questFiles, jars, regions, dataFiles, npcJson, worlds: worldCount, files: uniqueTasks.length },
  };
}

// ---- backups -------------------------------------------------------------

class Backups {
  constructor(runId) {
    this.runId = runId;
    this.dir = path.join(util.BACKUP_DIR, runId);
    this.entries = [];
    this.seen = new Set();
  }
  add(file) {
    const key = path.resolve(file).toLowerCase();
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (util.isFile(file)) {
      const idx = this.entries.length;
      const rel = path.join(this.runId, String(idx).padStart(5, '0') + '.bak');
      const dest = path.join(util.BACKUP_DIR, rel);
      util.copyFile(file, dest);
      this.entries.push({ path: file, backup: rel, existed: true });
    } else {
      this.entries.push({ path: file, existed: false });
    }
  }
  save(meta) {
    if (!this.entries.length) return null;
    const manifest = {
      runId: this.runId,
      createdAt: new Date().toISOString(),
      ...meta,
      entries: this.entries,
    };
    const runsDir = path.join(util.DATA_DIR, 'runs');
    const file = path.join(runsDir, this.runId + '.json');
    util.atomicWrite(file, JSON.stringify(manifest, null, 2));
    util.atomicWrite(path.join(runsDir, 'last.json'), JSON.stringify(manifest, null, 2));
    pruneRuns();
    return file;
  }
}

function pruneRuns(keep = 10) {
  const runsDir = path.join(util.DATA_DIR, 'runs');
  const manifests = util.listDir(runsDir)
    .filter((e) => e.isFile() && e.name.endsWith('.json') && e.name !== 'last.json')
    .map((e) => ({ name: e.name, time: fs.statSync(path.join(runsDir, e.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const m of manifests.slice(keep)) {
    try { fs.unlinkSync(path.join(runsDir, m.name)); } catch (_) {}
    const id = m.name.replace(/\.json$/, '');
    try { fs.rmSync(path.join(util.BACKUP_DIR, id), { recursive: true, force: true }); } catch (_) {}
  }
}

function pruneEmptyDirs(file, stopDir) {
  if (!stopDir) return;
  const stop = path.resolve(stopDir);
  let dir = path.dirname(path.resolve(file));
  while (dir.toLowerCase().startsWith(stop.toLowerCase())) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      else break;
    } catch (_) { break; }
    if (dir.toLowerCase() === stop.toLowerCase()) break;
    dir = path.dirname(dir);
  }
}

function undoLast() {
  const lastFile = path.join(util.DATA_DIR, 'runs', 'last.json');
  if (!util.isFile(lastFile)) throw new Error('没有可撤销的翻译记录');
  const manifest = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
  const packDirs = Array.isArray(manifest.packDirs) ? manifest.packDirs : [];
  let restored = 0;
  for (let i = manifest.entries.length - 1; i >= 0; i--) {
    const e = manifest.entries[i];
    try {
      if (e.existed) {
        const src = path.join(util.BACKUP_DIR, e.backup);
        if (util.isFile(src)) {
          fs.mkdirSync(path.dirname(e.path), { recursive: true });
          fs.copyFileSync(src, e.path);
          restored++;
        }
      } else {
        if (util.exists(e.path)) {
          fs.rmSync(e.path, { force: true, recursive: false });
          const owner = packDirs.find((d) => path.resolve(e.path).toLowerCase().startsWith(path.resolve(d).toLowerCase() + path.sep));
          if (owner) pruneEmptyDirs(e.path, owner);
          restored++;
        }
      }
    } catch (_) {}
  }
  try { fs.unlinkSync(lastFile); } catch (_) {}
  try { fs.unlinkSync(path.join(util.DATA_DIR, 'last-report.json')); } catch (_) {}
  return { restored, runId: manifest.runId, entries: manifest.entries.length };
}

// ---- run -----------------------------------------------------------------

function createContext({ dryRun, translator, backups, emit, log }) {
  const changed = new Set();
  const preview = [];
  const previewSeen = new Set();
  const ctx = {
    dryRun: !!dryRun,
    packDir: null,
    changed,
    preview,
    previewSeen,
    backup(file) { if (!dryRun) backups.add(file); },
    markChanged(file) { changed.add(path.resolve(file)); },
    writeBuffer(file, data) {
      const abs = path.resolve(file);
      const existed = util.isFile(file);
      if (existed) {
        try {
          const old = fs.readFileSync(file);
          if (Buffer.compare(old, data) === 0) return false;
        } catch (_) {}
      }
      if (dryRun) { changed.add(abs); return true; }
      backups.add(file);
      util.atomicWrite(file, data);
      changed.add(abs);
      return true;
    },
    writeFile(file, text) {
      return ctx.writeBuffer(file, Buffer.from(text, 'utf8'));
    },
  };
  return ctx;
}

async function runTranslation(options, emit, control = {}) {
  const started = Date.now();
  const runId = util.timestampName() + '-' + String(started).slice(-4);
  util.ensureDirs();
  const plan = buildPlan(options);
  const backups = new Backups(runId);
  const errors = [];
  const translator = new Translator({
    engine: options.engine || 'bing',
    target: options.target || 'zh-Hans',
    source: options.source || 'en',
    concurrency: options.concurrency || 2,
    batchChars: options.batchChars || 4200,
    minInterval: options.minInterval == null ? 120 : options.minInterval,
    cache: options.cache !== false,
  });
  control.stop = () => {
    control.stopped = true;
    translator.stop();
  };
  if (control.stopped) translator.stop();

  const logFile = path.join(util.LOG_DIR, 'run-' + util.timestampName() + '.log');
  const origEmit = emit;
  const log = (level, msg) => {
    try { fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + level.toUpperCase() + ' ' + msg + '\n'); } catch (_) {}
    origEmit({ type: 'log', level, msg, time: Date.now() });
  };
  const ctx = createContext({ dryRun: !!options.dryRun, translator, backups, emit, log });
  const PREVIEW_MAX = 5000;
  translator.onTranslated = (original, translated, key, label) => {
    if (typeof original !== 'string' || typeof translated !== 'string') return;
    if (!translated.trim() || translated === original) return;
    const dedupeKey = original + '\u0000' + translated;
    if (ctx.previewSeen.has(dedupeKey)) return;
    ctx.previewSeen.add(dedupeKey);
    if (ctx.preview.length >= PREVIEW_MAX) return;
    ctx.preview.push({ file: label || '', key: key || '', original, translated });
  };
  const stats = translator.stats;
  let lastStats = 0;
  const onStats = () => {
    const now = Date.now();
    if (now - lastStats < 250) return;
    lastStats = now;
    origEmit({ type: 'stats', stats: { ...stats }, cacheSize: translator.cache.size });
  };

  log('info', '开始翻译：共 ' + plan.tasks.length + ' 个文件' + (options.dryRun ? '（预览模式，不写入）' : ''));
  for (const w of plan.warnings) log('warn', w);
  origEmit({
    type: 'start',
    total: plan.tasks.length + plan.packMetas.length,
    plan: { totals: plan.totals, warnings: plan.warnings, targets: plan.targets },
    runId,
  });

  let done = 0;
  const total = plan.tasks.length + plan.packMetas.length;
  const langChanged = new Set();
  const markPack = (targetLabel) => langChanged.add(targetLabel);

  for (const t of plan.tasks) {
    if (control.stopped) break;
    done++;
    origEmit({ type: 'progress', done: done - 1, total, current: t.label });
    log('info', '[' + done + '/' + total + '] ' + t.label);
    translator.currentLabel = t.label;
    try {
      let res;
      if (t.jtype === 'quest') res = await quests.runQuestTask(t.task, translator, ctx);
      else if (t.jtype === 'lang') {
        ctx.packDir = t.packDir;
        res = await langpack.runLangTask(t.task, translator, ctx, { patchouli: !!options.patchouli });
      } else if (t.jtype === 'world') res = await world.runWorldTask(t.task, translator, ctx);
      if (res && res.changed) {
        ctx.changed.add(path.resolve(t.task.out || t.file));
        if (t.jtype === 'lang' && t.task) markPack(t.target);
        log('success', '完成：' + (res.translated || 0) + ' 条文本');
      } else if (res) {
        log('info', '无需修改（' + (res.total != null ? res.total : res.parsed || 0) + ' 条候选文本）');
      }
    } catch (e) {
      if (control.stopped && /已停止/.test(String(e.message))) {
        log('warn', '已停止：' + t.label);
        break;
      }
      errors.push({ file: t.file, message: e.message, stack: process.env.MCT_DEBUG ? e.stack : undefined });
      log('error', '失败：' + t.label + ' — ' + e.message);
    }
    origEmit({ type: 'progress', done, total, current: t.label });
    onStats();
  }

  // pack.mcmeta for language packs
  const packDirs = [];
  for (const meta of plan.packMetas) {
    if (control.stopped) break;
    done++;
    try {
      if (!langChanged.has(meta.label)) {
        log('info', '没有语言文件被修改，跳过生成资源包：' + path.basename(meta.packDir));
      } else {
        ctx.packDir = meta.packDir;
        langpack.writePackMeta(ctx, meta.packFormat);
        packDirs.push(meta.packDir);
        log('success', '已生成资源包：' + meta.packDir + '（pack_format ' + meta.packFormat + '）');
      }
    } catch (e) {
      errors.push({ file: meta.packDir, message: e.message });
      log('error', '生成资源包失败：' + e.message);
    }
    origEmit({ type: 'progress', done, total, current: '资源包信息' });
  }

  translator.flush();
  const finished = Date.now();

  // Preview text file (only in preview mode, and only if something was translated).
  let previewFile = null;
  if (options.dryRun && ctx.preview.length) {
    const lines = [];
    lines.push('MC 地图翻译器 · 预览结果');
    lines.push('生成时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('说明：预览模式不会修改任何文件，以下为本次实际翻译的对照结果。');
    lines.push('共 ' + ctx.preview.length + ' 条译文' + (ctx.preview.length >= PREVIEW_MAX ? '（仅保留前 ' + PREVIEW_MAX + ' 条）' : ''));
    lines.push('');
    ctx.preview.forEach((p, i) => {
      lines.push('[' + (i + 1) + '] ' + (p.file || ''));
      if (p.key) lines.push('    键名：' + p.key);
      lines.push('    原文：' + p.original.replace(/\r?\n/g, '\\n'));
      lines.push('    译文：' + p.translated.replace(/\r?\n/g, '\\n'));
      lines.push('');
    });
    previewFile = path.join(util.DATA_DIR, 'preview.txt');
    try {
      util.atomicWrite(previewFile, Buffer.from('\ufeff' + lines.join('\r\n'), 'utf8'));
    } catch (_) {
      previewFile = null;
    }
  }

  const previewSamples = ctx.preview.slice(0, 300).map((p) => ({
    file: p.file,
    key: p.key,
    original: p.original.length > 800 ? p.original.slice(0, 800) + '…' : p.original,
    translated: p.translated.length > 800 ? p.translated.slice(0, 800) + '…' : p.translated,
  }));

  const report = {
    runId,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    stopped: !!control.stopped,
    dryRun: !!options.dryRun,
    engine: translator.engineId,
    target: translator.target,
    totals: plan.totals,
    filesChanged: ctx.changed.size,
    changedFiles: Array.from(ctx.changed).slice(0, 500),
    packDirs,
    stats: { ...stats, cacheSize: translator.cache.size },
    errors,
    preview: previewSamples,
    previewTotal: ctx.preview.length,
    previewTruncated: ctx.preview.length > previewSamples.length,
    previewFile,
  };
  try { util.atomicWrite(path.join(util.DATA_DIR, 'last-report.json'), JSON.stringify(report, null, 2)); } catch (_) {}
  const manifestFile = backups.save({ report: { filesChanged: report.filesChanged, stats: report.stats, errors }, packDirs });
  log('info', '完成：修改 ' + report.filesChanged + ' 个文件，新翻译 ' + stats.translated + ' 条，缓存命中 ' + stats.cached + ' 条，失败 ' + stats.failed + ' 条');
  if (errors.length) log('warn', '有 ' + errors.length + ' 个文件处理失败，详见报告');
  origEmit({ type: 'done', report, logFile });
  return report;
}

function analyze(options) {
  const plan = buildPlan(options);
  return {
    targets: plan.targets,
    totals: plan.totals,
    warnings: plan.warnings,
    tasks: plan.tasks.length,
    packMetas: plan.packMetas.map((m) => ({ packDir: m.packDir, packFormat: m.packFormat, detectedVersion: m.detectedVersion })),
  };
}

function clearCache() {
  const file = path.join(util.DATA_DIR, 'cache.json');
  let removed = 0;
  try { fs.unlinkSync(file); removed = 1; } catch (_) {}
  return { removed };
}

function readLastReport() {
  try { return JSON.parse(fs.readFileSync(path.join(util.DATA_DIR, 'last-report.json'), 'utf8')); } catch (_) { return null; }
}

module.exports = {
  detectTargets, buildPlan, runTranslation, analyze, undoLast, clearCache, readLastReport,
};

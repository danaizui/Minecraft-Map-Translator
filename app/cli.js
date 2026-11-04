#!/usr/bin/env node
'use strict';

/**
 * Command line interface (optional; the desktop UI is the main entry).
 *
 *   node app/cli.js "D:\\packs\\MyPack" --scope quests,lang,world
 *   node app/cli.js "D:\\packs\\MyPack" --engine mymemory --dry-run
 *   node app/cli.js --undo
 */

const path = require('path');
const core = require('./lib/core');
const util = require('./lib/util');

function usage() {
  console.log(`MC 地图翻译器 CLI v1.1

用法:
  node app/cli.js <整合包/存档路径...> [选项]

选项:
  --engine bing|mymemory|mock   翻译引擎 (默认 bing)
  --scope quests,lang,world     翻译范围 (默认全部)
  --patchouli                   翻译 Patchouli 指南书 (较慢)
  --target zh-Hans|zh-Hant      目标语言 (默认 zh-Hans)
  --pack-name <名称>            生成资源包名称
  --pack-format auto|<数字>     资源包 pack_format
  --concurrency <1-4>           同时请求数
  --batch-chars <600-4800>      单批字符数
  --min-interval <毫秒>         请求间隔
  --no-cache                    不使用缓存
  --dry-run                     预览，不写文件
  --analyze                     只分析不翻译
  --undo                        撤销上一次翻译
  --help                        显示帮助

示例:
  node app/cli.js "D:\\Minecraft\\MyModpack" --scope quests,lang
  node app/cli.js "D:\\Minecraft\\saves\\MyMap" --engine bing
`);
}

function parseArgs(argv) {
  const out = { paths: [], scope: { quests: true, lang: true, world: true } };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--undo') out.undo = true;
    else if (a === '--analyze') out.analyze = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-cache') out.cache = false;
    else if (a === '--patchouli') out.patchouli = true;
    else if (a === '--engine') out.engine = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--pack-name') out.packName = argv[++i];
    else if (a === '--pack-format') {
      const v = argv[++i];
      out.packFormat = v === 'auto' ? 'auto' : Number(v);
    }
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--batch-chars') out.batchChars = Number(argv[++i]);
    else if (a === '--min-interval') out.minInterval = Number(argv[++i]);
    else if (a === '--scope') {
      const set = new Set(String(argv[++i] || '').split(',').map((s) => s.trim().toLowerCase()));
      out.scope = { quests: set.has('quests'), lang: set.has('lang'), world: set.has('world') };
    } else if (!a.startsWith('-')) out.paths.push(a);
    else console.warn('未知参数：' + a);
  }
  return out;
}

const LEVEL_TAG = { info: '   ', success: ' ✓ ', warn: ' ! ', error: ' ✗ ' };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.paths.length && !args.undo)) { usage(); return 0; }

  if (args.undo) {
    const r = core.undoLast();
    console.log(`已撤销 ${r.runId}：恢复 ${r.restored} / ${r.entries} 个文件`);
    return 0;
  }

  const options = {
    paths: args.paths,
    scope: args.scope,
    patchouli: !!args.patchouli,
    engine: args.engine || 'bing',
    target: args.target || 'zh-Hans',
    source: 'en',
    concurrency: args.concurrency || 2,
    batchChars: args.batchChars || 4200,
    minInterval: args.minInterval == null ? 120 : args.minInterval,
    cache: args.cache !== false,
    dryRun: !!args.dryRun,
    packName: args.packName || 'MC翻译_中文资源包',
    packFormat: args.packFormat || 'auto',
  };

  if (args.analyze) {
    const a = core.analyze(options);
    console.log(JSON.stringify(a, null, 2));
    return 0;
  }

  const control = {};
  process.on('SIGINT', () => {
    console.log('\n正在停止…');
    if (control.stop) control.stop();
  });

  const t0 = Date.now();
  const report = await core.runTranslation(options, (ev) => {
    if (ev.type === 'log') {
      const time = new Date(ev.time || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
      console.log(`[${time}]${LEVEL_TAG[ev.level] || '   '}${ev.msg}`);
    } else if (ev.type === 'progress' && ev.total) {
      const pct = Math.round((ev.done / ev.total) * 100);
      process.stdout.write(`\r进度 ${pct}% (${ev.done}/${ev.total}) ${String(ev.current || '').slice(0, 50)}          `);
      if (ev.done >= ev.total) process.stdout.write('\n');
    }
  }, control);

  const s = report.stats;
  console.log('\n================ 结果 ================');
  console.log(`耗时        ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  console.log(`修改文件    ${report.filesChanged}`);
  console.log(`新翻译      ${s.translated}`);
  console.log(`缓存命中    ${s.cached}`);
  console.log(`失败        ${s.failed}`);
  console.log(`错误文件    ${report.errors.length}`);
  if (report.packDirs.length) console.log('资源包      ' + report.packDirs.join('\n            '));
  if (report.dryRun) console.log('（预览模式，未写入任何文件）');
  if (report.errors.length) {
    console.log('\n错误：');
    for (const e of report.errors.slice(0, 20)) console.log(' - ' + (e.file || '') + ': ' + e.message);
  }
  return report.errors.length ? 2 : 0;
}

main().then((code) => process.exit(code || 0)).catch((e) => {
  console.error('失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

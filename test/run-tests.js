'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const nbt = require(path.join(ROOT, 'app', 'lib', 'nbt'));
const mca = require(path.join(ROOT, 'app', 'lib', 'mca'));
const core = require(path.join(ROOT, 'app', 'lib', 'core'));
const util = require(path.join(ROOT, 'app', 'lib', 'util'));

const TMP = path.join(__dirname, 'tmp');
const TAG = nbt.TAG;

// ---------- tiny zip writer (store) ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------- fixture builders ----------
function resetTmp() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}

function buildChunkNbt() {
  const blockEntities = nbt.listTag(TAG.Compound, [
    nbt.compound({
      id: nbt.stringTag('minecraft:sign'),
      x: nbt.intTag(1), y: nbt.intTag(64), z: nbt.intTag(1),
      Text1: nbt.stringTag('Welcome to the map'),
      Text2: nbt.stringTag('{"text":"Second line","color":"gold"}'),
      Text3: nbt.stringTag('§aGreen %s text'),
      Text4: nbt.stringTag(''),
    }),
    nbt.compound({
      id: nbt.stringTag('minecraft:sign'),
      front_text: nbt.compound({
        messages: nbt.listTag(TAG.String, [
          nbt.stringTag('{"text":"Front side"}'),
          nbt.stringTag('{"text":"Line two"}'),
        ]),
        filtered_messages: nbt.listTag(TAG.String, []),
      }),
    }),
    nbt.compound({
      id: nbt.stringTag('minecraft:written_book'),
      pages: nbt.listTag(TAG.String, [
        nbt.stringTag('{"text":"Once upon a time"}'),
        nbt.stringTag('A plain page'),
      ]),
      title: nbt.stringTag('The Legend'),
      author: nbt.stringTag('Steve'),
    }),
    nbt.compound({
      id: nbt.stringTag('minecraft:command_block'),
      Command: nbt.stringTag('tellraw @a {"text":"Hello players","color":"aqua"}'),
    }),
    nbt.compound({
      id: nbt.stringTag('minecraft:chest'),
      Items: nbt.listTag(TAG.Compound, [
        nbt.compound({
          id: nbt.stringTag('minecraft:written_book'),
          Count: nbt.byteTag(1),
          tag: nbt.compound({
            title: nbt.stringTag('Book in Chest'),
            pages: nbt.listTag(TAG.String, [nbt.stringTag('Page from chest')]),
          }),
        }),
      ]),
    }),
  ]);
  return nbt.compound({
    DataVersion: nbt.intTag(3700),
    xPos: nbt.intTag(0),
    zPos: nbt.intTag(0),
    Status: nbt.stringTag('full'),
    block_entities: blockEntities,
    entities: nbt.listTag(TAG.Compound, [
      nbt.compound({ id: nbt.stringTag('minecraft:armor_stand'), CustomName: nbt.stringTag('{"text":"Bob the Guide"}') }),
    ]),
  });
}

function buildRegion(file) {
  const root = buildChunkNbt();
  const chunks = [
    { index: 0, nbt: root, rootName: '', modified: true },
    { index: 1, nbt: buildChunkNbt(), rootName: '', modified: true },
  ];
  mca.writeRegion(file, null, chunks);
}

function buildInstance(dir, withFtbLang) {
  fs.mkdirSync(path.join(dir, 'config', 'ftbquests', 'quests', 'chapters'), { recursive: true });
  const snbt = `{
\t// This is a comment, keep me
\tdefault_quest_shape: "circle"
\tid: "chapter_1"
\ttitle: "The Beginning"
\tdescription: [
\t\t"Welcome to the adventure."
\t\t"Find the ancient sword."
\t]
\tquests: [
\t\t{
\t\t\tid: "quest_1"
\t\t\ttitle: "First Steps"
\t\t\ticon: "minecraft:stone"
\t\t\tdescription: ["Craft a stone pickaxe."]
\t\t}
\t]
}
`;
  fs.writeFileSync(path.join(dir, 'config', 'ftbquests', 'quests', 'chapters', 'chapter_1.snbt'), snbt, 'utf8');

  if (withFtbLang) {
    fs.mkdirSync(path.join(dir, 'config', 'ftbquests', 'quests', 'lang'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'ftbquests', 'quests', 'lang', 'en_us.snbt'),
      '{\n\t"chapter.chapter_1.title": "The Beginning"\n\t"quest.quest_1.title": "First Steps"\n}\n', 'utf8');
  }

  fs.mkdirSync(path.join(dir, 'config', 'betterquesting'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'betterquesting', 'DefaultQuests.json'), JSON.stringify({
    'format:8:0': '1.0',
    'questDatabase:9:0': {
      'abc-123:10:0': {
        'properties:10:0': {
          'betterquesting:10:0': {
            'name:8:0': 'A Better Quest',
            'desc:8:0': 'Talk to the village elder.',
            'icon:10:0': { id: 'minecraft:book' },
          },
        },
      },
    },
  }, null, 2), 'utf8');

  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const zip = makeZip([
    { name: 'META-INF/mods.toml', data: 'modLoader="javafml"\n' },
    {
      name: 'assets/testmod/lang/en_us.json',
      data: JSON.stringify({
        'item.testmod.ruby_sword': 'Ruby Sword',
        'item.testmod.ruby': 'Ruby',
        'tooltip.testmod.ruby_sword': 'A shiny sword. §7Right click to use.',
        'gui.testmod.title': 'Test Mod',
      }, null, 2),
    },
    {
      name: 'assets/testmod/lang/en_us.lang',
      data: '# comment\ntile.test_block.name=Test Block\nitem.test_item.name=Test Item\n',
    },
  ]);
  fs.writeFileSync(path.join(modsDir, 'testmod.jar'), zip);

  const world = path.join(dir, 'saves', 'TestWorld');
  fs.mkdirSync(path.join(world, 'region'), { recursive: true });
  fs.mkdirSync(path.join(world, 'data'), { recursive: true });
  const level = nbt.compound({ Data: nbt.compound({ LevelName: nbt.stringTag('Test World') }) });
  nbt.writeFile(path.join(world, 'level.dat'), '', level, true);
  buildRegion(path.join(world, 'region', 'r.0.0.mca'));
  const scoreboard = nbt.compound({
    Data: nbt.compound({
      Objectives: nbt.listTag(TAG.Compound, [
        nbt.compound({ Name: nbt.stringTag('kills'), DisplayName: nbt.stringTag('{"text":"Kills"}') }),
      ]),
      Teams: nbt.listTag(TAG.Compound, [
        nbt.compound({ Name: nbt.stringTag('red'), DisplayName: nbt.stringTag('{"text":"Red Team"}'), Prefix: nbt.stringTag('{"text":"[Red] "}') }),
      ]),
    }),
  });
  nbt.writeFile(path.join(world, 'data', 'scoreboard.dat'), '', scoreboard, true);
  return { dir, world, snbtFile: path.join(dir, 'config', 'ftbquests', 'quests', 'chapters', 'chapter_1.snbt') };
}

function findCompounds(tag, pred, out = []) {
  if (!tag) return out;
  if (tag.type === TAG.Compound) {
    if (pred(tag)) out.push(tag);
    for (const v of Object.values(tag.value)) findCompounds(v, pred, out);
  } else if (tag.type === TAG.List) {
    for (const it of tag.value.items) findCompounds(it, pred, out);
  }
  return out;
}

function idOf(tag) {
  const t = tag.value.id;
  return t && t.type === TAG.String ? t.value : '';
}

function getStr(comp, key) {
  const t = comp.value[key];
  return t && t.type === TAG.String ? t.value : null;
}

// ---------- tests ----------
async function main() {
  resetTmp();
  const base = buildInstance(path.join(TMP, 'TestPack'), false);
  const originalQuest = fs.readFileSync(base.snbtFile);
  const originalRegion = fs.readFileSync(path.join(base.world, 'region', 'r.0.0.mca'));
  const originalScore = fs.readFileSync(path.join(base.world, 'data', 'scoreboard.dat'));

  const events = [];
  const report = await core.runTranslation({
    paths: [base.dir],
    scope: { quests: true, lang: true, world: true },
    engine: 'mock',
    target: 'zh-Hans',
    concurrency: 2,
    batchChars: 2000,
    minInterval: 0,
    cache: false,
    dryRun: false,
    packName: 'TestPack_CN',
    packFormat: 15,
  }, (ev) => events.push(ev), {});

  // 1. quest SNBT
  const snbtOut = fs.readFileSync(base.snbtFile, 'utf8');
  assert(snbtOut.includes('【译】The Beginning'), 'SNBT title translated');
  assert(snbtOut.includes('【译】First Steps'), 'SNBT quest title translated');
  assert(snbtOut.includes('id: "chapter_1"'), 'SNBT id untouched');
  assert(snbtOut.includes('icon: "minecraft:stone"'), 'SNBT icon untouched');
  assert(snbtOut.includes('// This is a comment, keep me'), 'SNBT comment preserved');
  assert(snbtOut.includes('default_quest_shape: "circle"'), 'SNBT enum untouched');
  assert(snbtOut.includes('title: "【译】The Beginning"'), 'SNBT title quoted correctly');
  assert(!snbtOut.includes('"The Beginning"'), 'SNBT no untranslated quoted title');

  // 2. Better Questing JSON
  const bq = JSON.parse(fs.readFileSync(path.join(base.dir, 'config', 'betterquesting', 'DefaultQuests.json'), 'utf8'));
  assert.strictEqual(bq['questDatabase:9:0']['abc-123:10:0']['properties:10:0']['betterquesting:10:0']['name:8:0'], '【译】A Better Quest');
  assert.strictEqual(bq['questDatabase:9:0']['abc-123:10:0']['properties:10:0']['betterquesting:10:0']['desc:8:0'], '【译】Talk to the village elder.');
  assert.strictEqual(bq['questDatabase:9:0']['abc-123:10:0']['properties:10:0']['betterquesting:10:0']['icon:10:0'].id, 'minecraft:book');

  // 3. resource pack
  const packDir = path.join(base.dir, 'resourcepacks', 'TestPack_CN');
  const zh = JSON.parse(fs.readFileSync(path.join(packDir, 'assets', 'testmod', 'lang', 'zh_cn.json'), 'utf8'));
  assert.strictEqual(zh['item.testmod.ruby_sword'], '【译】Ruby Sword');
  assert.strictEqual(zh['tooltip.testmod.ruby_sword'], '【译】A shiny sword. §7Right click to use.');
  assert(fs.existsSync(path.join(packDir, 'assets', 'testmod', 'lang', 'zh_CN.lang')), 'legacy lang generated');
  assert(fs.existsSync(path.join(packDir, 'pack.mcmeta')), 'pack.mcmeta generated');
  const meta = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.mcmeta'), 'utf8'));
  assert.strictEqual(meta.pack.pack_format, 15);

  // 4. region text
  const reg = mca.readRegion(path.join(base.world, 'region', 'r.0.0.mca'));
  assert.strictEqual(reg.chunks.length, 2, 'two chunks preserved');
  const root = reg.chunks[0].nbt;
  const signs = findCompounds(root, (c) => idOf(c).includes('sign'));
  assert.strictEqual(signs.length, 2, 'two signs');
  assert.strictEqual(getStr(signs[0], 'Text1'), '【译】Welcome to the map');
  const text2 = JSON.parse(getStr(signs[0], 'Text2'));
  assert.strictEqual(text2.text, '【译】Second line');
  assert.strictEqual(text2.color, 'gold', 'sign JSON metadata preserved');
  assert.strictEqual(getStr(signs[0], 'Text3'), '【译】§aGreen %s text', 'placeholders preserved');
  const front = signs[1].value.front_text.value.messages.value.items;
  assert.strictEqual(JSON.parse(front[0].value).text, '【译】Front side');
  assert.strictEqual(JSON.parse(front[1].value).text, '【译】Line two');

  const books = findCompounds(root, (c) => idOf(c).includes('written_book'));
  assert(books.length >= 2, 'books found');
  const tileBook = books.find((b) => getStr(b, 'title') === '【译】The Legend');
  assert(tileBook, 'book title translated');
  const pages = tileBook.value.pages.value.items;
  assert.strictEqual(JSON.parse(pages[0].value).text, '【译】Once upon a time');
  assert.strictEqual(pages[1].value, '【译】A plain page');
  assert.strictEqual(getStr(tileBook, 'author'), 'Steve', 'author untouched');

  const cmd = findCompounds(root, (c) => idOf(c).includes('command_block'))[0];
  const command = getStr(cmd, 'Command');
  assert(command.startsWith('tellraw @a '), 'command syntax preserved');
  assert(JSON.parse(command.slice('tellraw @a '.length)).text === '【译】Hello players');

  const stand = findCompounds(root, (c) => idOf(c).includes('armor_stand'))[0];
  assert.strictEqual(JSON.parse(getStr(stand, 'CustomName')).text, '【译】Bob the Guide');

  // untouched technical fields
  assert.strictEqual(root.value.Status.value, 'full');
  assert.strictEqual(root.value.DataVersion.value, 3700);

  // 5. scoreboard
  const sb = nbt.readFile(path.join(base.world, 'data', 'scoreboard.dat'));
  const objs = sb.tag.value.Data.value.Objectives.value.items;
  assert.strictEqual(JSON.parse(objs[0].value.DisplayName.value).text, '【译】Kills');
  const teams = sb.tag.value.Data.value.Teams.value.items;
  assert.strictEqual(JSON.parse(teams[0].value.DisplayName.value).text, '【译】Red Team');

  // 6. report
  assert(report.filesChanged > 0, 'files changed');
  assert(report.stats.translated > 0, 'translated strings');
  assert(report.stats.failed === 0, 'no failed strings');
  assert(report.errors.length === 0, 'no errors: ' + JSON.stringify(report.errors));
  assert(Array.isArray(report.preview) && report.preview.length > 0, 'report has preview samples');

  // 7. undo
  const undo = core.undoLast();
  assert(undo.restored > 0, 'undo restored files');
  assert.deepStrictEqual(fs.readFileSync(base.snbtFile), originalQuest, 'SNBT restored byte-for-byte');
  assert.deepStrictEqual(fs.readFileSync(path.join(base.world, 'region', 'r.0.0.mca')), originalRegion, 'region restored byte-for-byte');
  assert.deepStrictEqual(fs.readFileSync(path.join(base.world, 'data', 'scoreboard.dat')), originalScore, 'scoreboard restored byte-for-byte');
  assert(!fs.existsSync(path.join(packDir, 'assets', 'testmod', 'lang', 'zh_cn.json')), 'generated lang removed on undo');

  // 8. dry run
  const dry = await core.runTranslation({
    paths: [base.dir],
    scope: { quests: true, lang: false, world: true },
    engine: 'mock',
    dryRun: true,
    cache: false,
    minInterval: 0,
  }, () => {}, {});
  assert(dry.dryRun, 'dry run flag');
  assert(dry.filesChanged > 0, 'dry run would change files');
  assert(Array.isArray(dry.preview) && dry.preview.length > 0, 'preview samples collected');
  assert(dry.previewTotal >= dry.preview.length, 'preview total');
  assert(dry.preview.some((p) => p.translated.includes('【译】')), 'preview entries contain translations');
  assert(dry.previewFile && fs.existsSync(dry.previewFile), 'preview file written');
  const previewText = fs.readFileSync(dry.previewFile, 'utf8');
  assert(previewText.includes('【译】'), 'preview file contains translations');
  assert(previewText.includes('原文：'), 'preview file is readable');
  assert.deepStrictEqual(fs.readFileSync(base.snbtFile), originalQuest, 'dry run did not write SNBT');
  assert.deepStrictEqual(fs.readFileSync(path.join(base.world, 'region', 'r.0.0.mca')), originalRegion, 'dry run did not write region');

  // 9. FTB lang file takes precedence
  const base2 = buildInstance(path.join(TMP, 'TestPackLang'), true);
  await core.runTranslation({
    paths: [base2.dir],
    scope: { quests: true, lang: false, world: false },
    engine: 'mock',
    cache: false,
    minInterval: 0,
  }, () => {}, {});
  const zhSnbt = path.join(base2.dir, 'config', 'ftbquests', 'quests', 'lang', 'zh_cn.snbt');
  assert(fs.existsSync(zhSnbt), 'zh_cn.snbt generated');
  const langOut = fs.readFileSync(zhSnbt, 'utf8');
  assert(langOut.includes('【译】The Beginning'), 'lang title translated');
  const chapterOut = fs.readFileSync(base2.snbtFile, 'utf8');
  assert(chapterOut.includes('title: "The Beginning"'), 'chapter not modified when lang exists');

  // 10. NBT string round-trip with emoji / modified UTF-8
  const emojiTag = nbt.compound({ s: nbt.stringTag('Hello 😀 世界'), long: { type: TAG.Long, value: 9223372036854775807n } });
  const bytes = nbt.serialize('', emojiTag);
  const parsed = nbt.parse(bytes).tag;
  assert.strictEqual(parsed.value.s.value, 'Hello 😀 世界');
  assert.strictEqual(parsed.value.long.value, 9223372036854775807n);

  console.log('ALL TESTS PASSED');
  console.log('report:', { filesChanged: report.filesChanged, translated: report.stats.translated, cached: report.stats.cached });
}

main().catch((e) => {
  console.error('TEST FAILED:', e.stack || e);
  process.exit(1);
});

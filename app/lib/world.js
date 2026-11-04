'use strict';

/**
 * World text translation:
 *  - signs (legacy Text1-4 and 1.20+ front_text/back_text)
 *  - written books (pages/title, old tag and 1.20.5 components)
 *  - text_display entities
 *  - custom names, item display names, lore
 *  - scoreboard / team display names
 *  - command blocks (only JSON text components, never command syntax)
 *  - scoreboard.dat and CustomNPCs JSON
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const util = require('./util');
const nbt = require('./nbt');
const mca = require('./mca');
const textUtil = require('./text');
const quests = require('./quests');

const TAG = nbt.TAG;

function tagString(tag, key) {
  const t = tag.value[key];
  return t && t.type === TAG.String ? t.value : null;
}

function isWorld(dir) {
  return util.isFile(path.join(dir, 'level.dat'));
}

function planWorld(worldDir) {
  const regions = [];
  const dataFiles = [];
  const jsonFiles = [];
  util.walk(worldDir, (file) => {
    const low = file.toLowerCase();
    if (low.endsWith('.mca')) regions.push(file);
  }, {
    skip: (full, ent) => {
      const n = ent.name.toLowerCase();
      return n === 'resourcepacks' || n === 'backup' || n === '.git' || n === 'logs';
    },
  });
  for (const ent of util.listDir(path.join(worldDir, 'data'))) {
    if (ent.isFile() && ent.name.toLowerCase().endsWith('.dat')) {
      dataFiles.push(path.join(worldDir, 'data', ent.name));
    }
  }
  const npcDir = path.join(worldDir, 'customnpcs');
  if (util.isDir(npcDir)) {
    util.walk(npcDir, (file) => {
      if (file.toLowerCase().endsWith('.json')) jsonFiles.push(file);
    });
  }
  return {
    regions: regions.sort(),
    dataFiles: dataFiles.sort(),
    jsonFiles: jsonFiles.sort(),
  };
}

function addValue(raw, key, assign, items, jsonHosts, mode = 'json') {
  if (typeof raw !== 'string' || !raw.trim()) return;
  if (textUtil.looksLikeJsonComponent(raw)) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = undefined; }
    if (parsed !== undefined) {
      const nodes = [];
      textUtil.collectJsonTextNodes(parsed, nodes);
      if (nodes.length) {
        const host = { parsed, changed: false, assign };
        jsonHosts.push(host);
        for (const node of nodes) {
          items.push({
            text: node.text, key: 'text', mode,
            apply: (t) => { node.holder[node.key] = t; host.changed = true; },
          });
        }
      }
      // JSON component without a "text" field (e.g. translate keys) is left as-is.
      return;
    }
  }
  items.push({ text: raw, key, mode, apply: assign });
}

function addComponentTag(tag, key, items, jsonHosts) {
  if (!tag) return;
  if (tag.type === TAG.String) {
    addValue(tag.value, key, (v) => { tag.value = v; }, items, jsonHosts);
    return;
  }
  if (tag.type === TAG.List) {
    for (const item of tag.value.items) addComponentTag(item, key, items, jsonHosts);
    return;
  }
  if (tag.type === TAG.Compound) {
    for (const [k, v] of Object.entries(tag.value)) {
      if (k === 'text' || k === 'fallback') {
        if (v.type === TAG.String) addValue(v.value, k, (t) => { v.value = t; }, items, jsonHosts);
      } else if (k === 'extra' || k === 'with') {
        addComponentTag(v, key, items, jsonHosts);
      }
    }
  }
}

function addPages(listTag, key, items, jsonHosts) {
  if (!listTag || listTag.type !== TAG.List) return;
  for (const item of listTag.value.items) {
    if (item.type === TAG.String) {
      addValue(item.value, key, (v) => { item.value = v; }, items, jsonHosts);
    } else if (item.type === TAG.Compound) {
      if (item.value.raw && item.value.raw.type === TAG.String) {
        addValue(item.value.raw.value, key, (v) => { item.value.raw.value = v; }, items, jsonHosts);
      } else {
        addComponentTag(item, key, items, jsonHosts);
      }
    }
  }
}

function handleBookCompound(comp, items, jsonHosts) {
  if (comp.pages && comp.pages.type === TAG.List) addPages(comp.pages, 'pages', items, jsonHosts);
  const title = comp.title;
  if (title) {
    if (title.type === TAG.String) {
      addValue(title.value, 'title', (v) => { title.value = v; }, items, jsonHosts);
    } else if (title.type === TAG.Compound) {
      const raw = title.value.raw;
      if (raw && raw.type === TAG.String) {
        addValue(raw.value, 'title', (v) => { raw.value = v; }, items, jsonHosts);
      } else {
        addComponentTag(title, 'title', items, jsonHosts);
      }
    }
  }
}

function handleSignSide(comp, items, jsonHosts) {
  const msgs = comp.messages;
  if (!msgs || msgs.type !== TAG.List) return;
  for (const item of msgs.value.items) {
    if (item.type === TAG.String) {
      addValue(item.value, 'sign', (v) => { item.value = v; }, items, jsonHosts);
    } else if (item.type === TAG.Compound) {
      addComponentTag(item, 'sign', items, jsonHosts);
    }
  }
}

function handleSignCompound(comp, items, jsonHosts) {
  for (let i = 1; i <= 4; i++) {
    const t = comp['Text' + i];
    if (t && t.type === TAG.String) {
      addValue(t.value, 'sign', (v) => { t.value = v; }, items, jsonHosts);
    }
  }
  // front_text / back_text are handled by the main visitor, which also
  // avoids processing the same message list twice.
}

function handleDisplay(comp, items, jsonHosts) {
  const name = comp.Name;
  if (name) {
    if (name.type === TAG.String) {
      addValue(name.value, 'displayname', (v) => { name.value = v; }, items, jsonHosts);
    } else if (name.type === TAG.Compound) {
      addComponentTag(name, 'displayname', items, jsonHosts);
    }
  }
  const lore = comp.Lore;
  if (lore && lore.type === TAG.List) addPages(lore, 'lore', items, jsonHosts);
}

function handleCommand(comp, items, commandHosts) {
  const cmd = comp.Command;
  if (!cmd || cmd.type !== TAG.String) return;
  const segs = textUtil.findJsonSegments(cmd.value);
  if (!segs.length) return;
  const host = { tag: cmd, segs, changed: false };
  commandHosts.push(host);
  for (const seg of segs) {
    for (const node of seg.nodes) {
      items.push({
        text: node.text, key: 'text', mode: 'command',
        apply: (t) => { node.holder[node.key] = t; host.changed = true; },
      });
    }
  }
}

function collectWorldTexts(rootTag) {
  const items = [];
  const jsonHosts = [];
  const commandHosts = [];

  const genericKeys = new Set(['customname', 'displayname', 'prefix', 'suffix', 'itemname']);

  function visit(tag, key, bookCtx) {
    if (!tag || tag.type !== TAG.Compound) return;
    const id = (tagString(tag, 'id') || '').toLowerCase();
    const isBook = id.includes('written_book');
    const isSign = id.includes('sign');
    const isTextDisplay = id.includes('text_display');

    if (isSign) handleSignCompound(tag.value, items, jsonHosts);
    if (isBook) handleBookCompound(tag.value, items, jsonHosts);
    if (id.includes('command_block')) handleCommand(tag.value, items, commandHosts);

    for (const [k, v] of Object.entries(tag.value)) {
      const kl = k.toLowerCase();
      if (v.type === TAG.String) {
        if (genericKeys.has(kl)) {
          addValue(v.value, kl, (t) => { v.value = t; }, items, jsonHosts);
        } else if (kl === 'minecraft:custom_name' || kl === 'minecraft:item_name') {
          addValue(v.value, kl, (t) => { v.value = t; }, items, jsonHosts);
        } else if (bookCtx && kl === 'title') {
          addValue(v.value, 'title', (t) => { v.value = t; }, items, jsonHosts);
        } else if (isTextDisplay && kl === 'text') {
          addValue(v.value, 'text', (t) => { v.value = t; }, items, jsonHosts);
        }
      } else if (v.type === TAG.List) {
        if (kl === 'lore') {
          addPages(v, 'lore', items, jsonHosts);
        } else if (bookCtx && kl === 'pages') {
          addPages(v, 'pages', items, jsonHosts);
        } else if (kl === 'minecraft:lore') {
          addPages(v, 'lore', items, jsonHosts);
        } else {
          for (const item of v.value.items) {
            if (item.type === TAG.Compound) visit(item, k, bookCtx || isBook);
          }
        }
      } else if (v.type === TAG.Compound) {
        if (kl === 'display') {
          handleDisplay(v.value, items, jsonHosts);
        } else if (kl === 'front_text' || kl === 'back_text') {
          handleSignSide(v.value, items, jsonHosts);
        } else if (kl === 'minecraft:written_book_content') {
          handleBookCompound(v.value, items, jsonHosts);
        } else if (kl === 'minecraft:custom_name' || kl === 'minecraft:item_name') {
          addComponentTag(v, kl, items, jsonHosts);
        } else if (isTextDisplay && kl === 'text') {
          addComponentTag(v, 'text', items, jsonHosts);
        } else {
          visit(v, k, bookCtx || isBook);
        }
      }
    }
  }

  visit(rootTag, '', false);

  return { items, jsonHosts, commandHosts };
}

async function translateWorldNbt(rootTag, translator) {
  const { items, jsonHosts, commandHosts } = collectWorldTexts(rootTag);
  if (!items.length && !commandHosts.length) return 0;
  let translated = 0;
  if (items.length) {
    const results = await translator.translateBatch(items);
    for (let i = 0; i < items.length; i++) {
      const r = results[i];
      if (r != null && r !== items[i].text) {
        items[i].apply(r);
        translated++;
      }
    }
  }
  for (const host of jsonHosts) {
    if (host.changed) host.assign(JSON.stringify(host.parsed));
  }
  for (const host of commandHosts) {
    if (!host.changed) continue;
    let cmd = host.tag.value;
    for (let i = host.segs.length - 1; i >= 0; i--) {
      const seg = host.segs[i];
      cmd = cmd.slice(0, seg.start) + JSON.stringify(seg.parsed) + cmd.slice(seg.end);
    }
    host.tag.value = cmd;
  }
  return translated;
}

async function translateRegion(file, translator, ctx) {
  let translated = 0;
  const stats = await mca.processRegion(file, async (chunk) => {
    const n = await translateWorldNbt(chunk.nbt, translator);
    translated += n;
    return n > 0;
  }, () => ctx.backup(file), !ctx.dryRun);
  if (stats.modified > 0) ctx.markChanged(file);
  return { ...stats, translated, changed: stats.modified > 0 };
}

async function translateDataFile(file, translator, ctx) {
  const parsed = nbt.readFile(file);
  const n = await translateWorldNbt(parsed.tag, translator);
  if (n > 0) {
    let data = nbt.serialize(parsed.name, parsed.tag);
    if (parsed.gzip) data = zlib.gzipSync(data, { level: 6 });
    ctx.writeBuffer(file, data);
  }
  return { changed: n > 0, translated: n };
}

async function translateCustomNpcJson(file, translator, ctx) {
  return quests.translateJsonFile(file, file, translator, ctx, 'quest');
}

async function runWorldTask(task, translator, ctx) {
  if (task.type === 'region') return translateRegion(task.file, translator, ctx);
  if (task.type === 'data') return translateDataFile(task.file, translator, ctx);
  if (task.type === 'json') return translateCustomNpcJson(task.file, translator, ctx);
  throw new Error('未知世界任务类型 ' + task.type);
}

module.exports = {
  isWorld, planWorld, collectWorldTexts, translateWorldNbt,
  translateRegion, translateDataFile, runWorldTask,
};

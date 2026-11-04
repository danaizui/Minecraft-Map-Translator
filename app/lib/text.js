'use strict';

/**
 * Text analysis / filtering / placeholder protection / Minecraft JSON text.
 */

const KEY_BLACKLIST = new Set([
  'id', 'ids', 'icon', 'image', 'img', 'filename', 'file', 'files', 'path', 'paths',
  'sound', 'sounds', 'entity', 'entities', 'item', 'items', 'itemid', 'tag', 'tags',
  'advancement', 'advancements', 'structure', 'structures', 'dimension', 'biome',
  'command', 'commands', 'function', 'functions', 'reward_table', 'rewardtable',
  'table_id', 'tableid', 'texture', 'textures', 'model', 'models', 'particle',
  'effect', 'effects', 'attribute', 'attributes', 'key', 'keys', 'type', 'mode',
  'color', 'colour', 'uuid', 'owner', 'owneruuid', 'link', 'links', 'url', 'uri',
  'icon_name', 'iconname', 'item_id', 'itemid', 'quest_id', 'questid', 'chapter_id',
  'namespace', 'registry', 'mod', 'modid', 'pack', 'pack_id', 'resource', 'location',
  'pos', 'position', 'coords', 'nbt', 'snbt', 'json', 'code', 'format', 'pattern',
  'regex', 'script', 'class', 'method', 'event', 'handler', 'callback', 'sound_event',
  'loot_table', 'predicate', 'recipe', 'recipes', 'ingredient', 'ingredients',
  'translation_key', 'translate_key', 'lang_key', 'display_on_hover', 'show_toast',
  'announce_to_chat', 'hidden', 'silent', 'background', 'border', 'texture_path',
  'target', 'selector', 'scoreboard', 'objective_id', 'team_id', 'player', 'players',
  'author_uuid', 'owner_name', 'click_url', 'hover_url', 'data', 'value', 'values',
]);

const KEY_WHITELIST = new Set([
  'title', 'subtitle', 'description', 'desc', 'text', 'name', 'chapter', 'quest',
  'tip', 'tips', 'hint', 'hints', 'hover', 'tooltip', 'lore', 'page', 'pages',
  'message', 'messages', 'dialogue', 'dialog', 'line', 'lines', 'label', 'display',
  'displayname', 'display_name', 'prefix', 'suffix', 'objective', 'task', 'tasks',
  'reward', 'rewards', 'note', 'notes', 'info', 'summary', 'content', 'body',
  'header', 'footer', 'caption', 'greeting', 'landing_text', 'landingtext',
  'customname', 'itemname', 'item_name', 'text1', 'text2', 'text3', 'text4',
  'front_text', 'back_text', 'sign_text', 'motd', 'welcome', 'question', 'answer',
  'answers', 'option', 'options', 'comment', 'comments', 'story', 'npc_name',
  'npcname', 'dialog_text', 'dialogtext', 'quest_title', 'questtitle',
  'quest_desc', 'questdesc', 'quest_description', 'questdescription',
]);

const TOKEN_RE = /§[0-9a-fk-orA-FK-OR]|§#[0-9a-fA-F]{6}|%%|%(?:\d+\$)?[sdifh]|\{\d+\}|\$\{[^}]{1,64}\}|\n|\r|\\[nrt]|@[aprs](?:\[[^\]]{0,256}\])?|\{player\}|\{name\}/g;
const TOKEN_CHECK_RE = /⟦(\d+)⟧/g;
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;
const LATIN_RE = /[A-Za-z]/g;

function countMatches(str, re) {
  const m = str.match(re);
  return m ? m.length : 0;
}

function cjkRatio(text) {
  const cjk = countMatches(text, CJK_RE);
  if (!cjk) return 0;
  const latin = countMatches(text, LATIN_RE);
  return cjk / (cjk + latin + 1);
}

function normalizeKey(key) {
  if (key == null) return '';
  let k = String(key);
  if (k.includes(':')) k = k.split(':')[0];
  return k.toLowerCase().replace(/[\s_\-]/g, '');
}

function isTechnical(text, mode) {
  const s = text.trim();
  if (!s) return true;
  if (/^[a-z0-9_.\-]+:[a-z0-9_./\-]+$/i.test(s)) return true; // resource location
  if (/^https?:\/\//i.test(s) || /^www\./i.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^#?[0-9a-f]{6,8}$/i.test(s)) return true;
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return true;
  if (/\.(png|jpe?g|gif|webp|json|snbt|nbt|mca|ogg|wav|mp3|zip|jar|mcmeta|lang|txt|md|toml|cfg|yml|yaml|class|java|js)$/i.test(s)) return true;
  if (/^[A-Za-z0-9+/=]{24,}$/.test(s) && !/\s/.test(s)) return true;
  if (/^\$?\{[^{}]{1,80}\}$/.test(s) && !/[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(s)) return true;
  if (mode !== 'lang') {
    if (!/\s/.test(s) && /^[a-z0-9_.\-/:]+$/.test(s) && (s.includes('_') || s.includes('.') || s.includes('/') || s.includes(':'))) return true;
    if (/^[a-z]+(\.[a-z0-9_\-]+){2,}$/i.test(s)) return true;
    if (/^[A-Z0-9_]{4,}$/.test(s) && s.includes('_')) return true;
  }
  return false;
}

function sentenceLike(text) {
  const s = text.trim();
  if (/\s[A-Za-z]{2,}/.test(s)) return true;
  if (/[.!?,:;"'“”‘’]/.test(s) && /[A-Za-z]{2,}/.test(s)) return true;
  return false;
}

function contentTranslatable(text, mode) {
  if (typeof text !== 'string') return false;
  const s = text.trim();
  if (!s) return false;
  const plain = s.replace(/§./g, '');
  if (!/[A-Za-z]/.test(plain)) return false;
  if (plain.length < 2) return false;
  const ratio = cjkRatio(plain);
  if (ratio > 0.28) return false;
  if (isTechnical(plain, mode)) return false;
  return true;
}

function keyAllows(key, text, mode) {
  if (mode === 'lang' || mode === 'json' || mode === 'command' || mode === 'raw') {
    return contentTranslatable(text, mode);
  }
  const k = normalizeKey(key);
  if (KEY_BLACKLIST.has(k)) return false;
  if (KEY_WHITELIST.has(k)) return contentTranslatable(text, mode);
  if (!contentTranslatable(text, mode)) return false;
  return sentenceLike(text) || text.trim().length > 28;
}

function shouldTranslate(text, key, mode = 'quest') {
  if (typeof text !== 'string') return false;
  if (!text.trim()) return false;
  return keyAllows(key, text, mode);
}

// ---- placeholder protection ---------------------------------------------

function protect(text) {
  const tokens = [];
  const protectedText = text.replace(TOKEN_RE, (m) => {
    const idx = tokens.length;
    tokens.push(m);
    return '⟦' + idx + '⟧';
  });
  return { text: protectedText, tokens };
}

function restore(text, tokens) {
  let ok = true;
  const seen = new Set();
  const out = text.replace(TOKEN_CHECK_RE, (m, idxStr) => {
    const idx = Number(idxStr);
    if (idx < 0 || idx >= tokens.length) { ok = false; return m; }
    seen.add(idx);
    return tokens[idx];
  });
  if (seen.size !== tokens.length) ok = false;
  return ok ? out : null;
}

// ---- long text splitting -------------------------------------------------

function splitLongText(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    const lower = Math.max(8, Math.floor(max * 0.55));
    for (let i = Math.min(max, rest.length - 1); i >= lower; i--) {
      if (/[.!?;:，。！？；：、\s]/.test(rest[i])) { cut = i + 1; break; }
    }
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

// ---- Minecraft JSON text components -------------------------------------

function looksLikeJsonComponent(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try { JSON.parse(t); return true; } catch (_) { return false; }
}

function collectJsonTextNodes(node, out) {
  if (Array.isArray(node)) {
    for (const it of node) collectJsonTextNodes(it, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'text' || k === 'fallback') {
      if (typeof v === 'string' && v.trim()) out.push({ holder: node, key: k, text: v });
    } else if (k === 'extra' || k === 'with') {
      collectJsonTextNodes(v, out);
    }
  }
}

async function translateJsonComponent(str, translateFn) {
  let parsed;
  try { parsed = JSON.parse(str); } catch (_) { return null; }
  const nodes = [];
  collectJsonTextNodes(parsed, nodes);
  if (!nodes.length) return null;
  let changed = false;
  for (const node of nodes) {
    const translated = await translateFn(node.text, 'text', 'json');
    if (translated != null && translated !== node.text) {
      node.holder[node.key] = translated;
      changed = true;
    }
  }
  if (!changed) return null;
  return JSON.stringify(parsed);
}

async function translatePlainOrJson(str, translateFn, key, mode) {
  if (looksLikeJsonComponent(str)) {
    // Never rewrite JSON components as plain text: components may be
    // translate keys or contain click events and other technical data.
    return translateJsonComponent(str, translateFn);
  }
  return translateFn(str, key, mode);
}

function findJsonSegments(str) {
  const segments = [];
  if (typeof str !== 'string') return segments;
  const re = /\{/g;
  let m;
  while ((m = re.exec(str))) {
    const start = m.index;
    let depth = 0, j = start, inStr = false, quote = '', escape = false;
    for (; j < str.length; j++) {
      const c = str[j];
      if (inStr) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) { j++; break; } }
    }
    if (depth !== 0) break;
    const seg = str.slice(start, j);
    try {
      const parsed = JSON.parse(seg);
      const nodes = [];
      collectJsonTextNodes(parsed, nodes);
      if (nodes.length) segments.push({ start, end: j, parsed, nodes });
    } catch (_) {}
    re.lastIndex = j;
  }
  return segments;
}

// Translate only JSON display components embedded in a command string.
// This keeps command syntax (selectors, ids, NBT) intact.
async function translateCommandAsync(str, translateFn) {
  if (typeof str !== 'string' || !str.includes('{')) return null;
  let out = str;
  let changed = false;
  const segments = findJsonSegments(str);
  for (let s = segments.length - 1; s >= 0; s--) {
    const seg = segments[s];
    let segChanged = false;
    for (const node of seg.nodes) {
      const tr = await translateFn(node.text, 'text', 'command');
      if (tr != null && tr !== node.text) {
        node.holder[node.key] = tr;
        segChanged = true;
        changed = true;
      }
    }
    if (segChanged) {
      out = out.slice(0, seg.start) + JSON.stringify(seg.parsed) + out.slice(seg.end);
    }
  }
  return changed ? out : null;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function indentOf(text) {
  const m = text.match(/^([ \t]+)"/m);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}

module.exports = {
  KEY_BLACKLIST, KEY_WHITELIST,
  cjkRatio, normalizeKey, isTechnical, contentTranslatable, keyAllows,
  shouldTranslate, protect, restore, splitLongText,
  looksLikeJsonComponent, translateJsonComponent, translatePlainOrJson,
  translateCommandAsync, findJsonSegments, collectJsonTextNodes,
  decodeHtmlEntities, indentOf,
};

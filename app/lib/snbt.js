'use strict';

/**
 * SNBT (stringified NBT) tokenizer that only rewrites quoted string VALUES,
 * preserving all formatting, comments and keys byte-for-byte.
 */

const textUtil = require('./text');

function readQuoted(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) { i++; break; }
    i++;
  }
  const inner = text.slice(start + 1, Math.max(start + 1, i - 1));
  return { value: unescape(inner), end: i, quote };
}

function unescape(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === undefined) { out += '\\'; break; }
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case 'u': {
        const hex = s.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
        else out += 'u';
        break;
      }
      default: out += n;
    }
  }
  return out;
}

function escape(s, quote) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') out += '\\\\';
    else if (c === quote) out += '\\' + quote;
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (c === '\b') out += '\\b';
    else if (c === '\f') out += '\\f';
    else out += c;
  }
  return out;
}

function skipWs(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function scan(text) {
  const segs = [];
  const stack = [];
  let i = 0;
  let bufStart = 0;
  let valueIndex = 0;
  const n = text.length;

  const flushRaw = (end) => {
    if (end > bufStart) segs.push({ type: 'raw', text: text.slice(bufStart, end) });
  };

  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      const q = readQuoted(text, i);
      i = q.end;
      const top = stack[stack.length - 1];
      let j = skipWs(text, i);
      const isKey = text[j] === ':' && top && top.type === '{';
      flushRaw(start);
      if (isKey) {
        segs.push({ type: 'raw', text: text.slice(start, i) });
        if (top) top.pending = q.value;
      } else {
        const key = top ? (top.pending != null ? top.pending : top.inheritedKey) : null;
        segs.push({
          type: 'value', raw: text.slice(start, i), value: q.value,
          quote: c, key, index: valueIndex++,
        });
        if (top) top.pending = null;
      }
      bufStart = i;
      continue;
    }
    if (c === '{' || c === '[') {
      const top = stack[stack.length - 1];
      const inherited = top ? (top.pending != null ? top.pending : top.inheritedKey) : null;
      stack.push({ type: c, pending: null, inheritedKey: inherited });
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      i++;
      continue;
    }
    if (c === ',') {
      if (stack.length) stack[stack.length - 1].pending = null;
      i++;
      continue;
    }
    if (c === ':' || /\s/.test(c)) { i++; continue; }
    if (c === ';') { i++; continue; }
    // Bare token (number, boolean, enum, unquoted key).
    const start = i;
    while (i < n && !/[\s,:[\]{};]/.test(text[i])) i++;
    if (i === start) { i++; continue; }
    const tok = text.slice(start, i);
    const top = stack[stack.length - 1];
    const j = skipWs(text, i);
    if (text[j] === ':' && top && top.type === '{') {
      top.pending = tok;
    } else if (top) {
      top.pending = null;
    }
  }
  flushRaw(n);
  return segs;
}

/**
 * translator must expose: async translateBatch(items) -> string[]
 * items: {text, key, mode}
 */
async function translateSnbt(text, translator, opts = {}) {
  const mode = opts.mode || 'quest';
  const segs = scan(text);
  const values = segs.filter((s) => s.type === 'value');
  if (!values.length) return { text, changed: false, total: 0, translated: 0 };
  const items = values.map((v) => ({ text: v.value, key: v.key, mode }));
  const results = await translator.translateBatch(items);
  let out = '';
  let vi = 0;
  let changed = false;
  let translated = 0;
  for (const seg of segs) {
    if (seg.type === 'raw') { out += seg.text; continue; }
    const tr = results[vi++];
    if (tr != null && tr !== seg.value && tr.trim()) {
      out += seg.quote + escape(tr, seg.quote) + seg.quote;
      changed = true;
      translated++;
    } else {
      out += seg.raw;
    }
  }
  return { text: out, changed, total: values.length, translated };
}

module.exports = { translateSnbt, scan, unescape, escape };

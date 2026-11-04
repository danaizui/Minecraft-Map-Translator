'use strict';

/**
 * Minecraft Java Edition NBT (Named Binary Tag) reader / writer.
 * Supports all standard tag types, including BigInt longs.
 * Strings use Java "modified UTF-8" like DataInput.readUTF.
 */

const zlib = require('zlib');

const TAG = Object.freeze({
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4,
  Float: 5, Double: 6, ByteArray: 7, String: 8,
  List: 9, Compound: 10, IntArray: 11, LongArray: 12,
});

function decodeModifiedUtf8(buf) {
  const units = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i++];
    if (b < 0x80) {
      units.push(b);
    } else if ((b & 0xE0) === 0xC0) {
      const b2 = i < buf.length ? buf[i++] : 0;
      units.push(((b & 0x1F) << 6) | (b2 & 0x3F));
    } else if ((b & 0xF0) === 0xE0) {
      const b2 = i < buf.length ? buf[i++] : 0;
      const b3 = i < buf.length ? buf[i++] : 0;
      units.push(((b & 0x0F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F));
    } else if ((b & 0xF8) === 0xF0) {
      // Non-standard 4-byte UTF-8; convert to a surrogate pair.
      const b2 = i < buf.length ? buf[i++] : 0;
      const b3 = i < buf.length ? buf[i++] : 0;
      const b4 = i < buf.length ? buf[i++] : 0;
      let cp = ((b & 0x07) << 18) | ((b2 & 0x3F) << 12) | ((b3 & 0x3F) << 6) | (b4 & 0x3F);
      if (cp <= 0xFFFF) units.push(cp);
      else {
        cp -= 0x10000;
        units.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    } else {
      units.push(0xFFFD);
    }
  }
  let out = '';
  for (let i = 0; i < units.length; i += 8192) {
    out += String.fromCharCode.apply(null, units.slice(i, i + 8192));
  }
  return out;
}

function encodeModifiedUtf8(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0) {
      bytes.push(0xC0, 0x80);
    } else if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    } else {
      bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
  }
  return Buffer.from(bytes);
}

class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.pos = offset;
  }
  need(n) {
    if (this.pos + n > this.buf.length) throw new Error('NBT: unexpected end of data');
  }
  u8() { this.need(1); return this.buf[this.pos++]; }
  i8() { this.need(1); const v = this.buf.readInt8(this.pos); this.pos += 1; return v; }
  u16() { this.need(2); const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  i32() { this.need(4); const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  i64() { this.need(8); const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
  f32() { this.need(4); const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  bytes(n) { this.need(n); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  string() {
    const len = this.u16();
    return decodeModifiedUtf8(this.bytes(len));
  }
}

class Writer {
  constructor(capacity = 1024) {
    this.buf = Buffer.allocUnsafe(capacity);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2;
    const nb = Buffer.allocUnsafe(cap);
    this.buf.copy(nb, 0, 0, this.pos);
    this.buf = nb;
  }
  u8(v) { this.ensure(1); this.buf[this.pos++] = v & 0xFF; }
  i16(v) { this.ensure(2); this.buf.writeInt16BE(v, this.pos); this.pos += 2; }
  u16(v) { this.ensure(2); this.buf.writeUInt16BE(v, this.pos); this.pos += 2; }
  i32(v) { this.ensure(4); this.buf.writeInt32BE(v, this.pos); this.pos += 4; }
  i64(v) { this.ensure(8); this.buf.writeBigInt64BE(typeof v === 'bigint' ? v : BigInt(Math.trunc(v)), this.pos); this.pos += 8; }
  f32(v) { this.ensure(4); this.buf.writeFloatBE(v, this.pos); this.pos += 4; }
  f64(v) { this.ensure(8); this.buf.writeDoubleBE(v, this.pos); this.pos += 8; }
  bytes(b) { this.ensure(b.length); b.copy(this.buf, this.pos); this.pos += b.length; }
  string(s) {
    const b = encodeModifiedUtf8(String(s));
    if (b.length > 65535) throw new Error('NBT string too long: ' + b.length);
    this.u16(b.length);
    this.bytes(b);
  }
  result() { return this.buf.subarray(0, this.pos); }
}

function readPayload(r, type) {
  switch (type) {
    case TAG.Byte: return { type, value: r.i8() };
    case TAG.Short: return { type, value: r.i16() };
    case TAG.Int: return { type, value: r.i32() };
    case TAG.Long: return { type, value: r.i64() };
    case TAG.Float: return { type, value: r.f32() };
    case TAG.Double: return { type, value: r.f64() };
    case TAG.ByteArray: {
      const len = r.i32();
      return { type, value: Buffer.from(r.bytes(len)) };
    }
    case TAG.String: return { type, value: r.string() };
    case TAG.List: {
      const elemType = r.u8();
      const len = r.i32();
      if (len < 0 || len > 100000000) throw new Error('NBT: invalid list length ' + len);
      const items = [];
      for (let i = 0; i < len; i++) items.push(readPayload(r, elemType));
      return { type, value: { elemType, items } };
    }
    case TAG.Compound: {
      const obj = Object.create(null);
      while (true) {
        const t = r.u8();
        if (t === TAG.End) break;
        const name = r.string();
        obj[name] = readPayload(r, t);
      }
      return { type, value: obj };
    }
    case TAG.IntArray: {
      const len = r.i32();
      const arr = new Array(len);
      for (let i = 0; i < len; i++) arr[i] = r.i32();
      return { type, value: arr };
    }
    case TAG.LongArray: {
      const len = r.i32();
      const arr = new Array(len);
      for (let i = 0; i < len; i++) arr[i] = r.i64();
      return { type, value: arr };
    }
    default:
      throw new Error('NBT: unknown tag type ' + type);
  }
}

function writePayload(w, tag) {
  const { type, value } = tag;
  switch (type) {
    case TAG.Byte: return w.u8(value);
    case TAG.Short: return w.i16(value);
    case TAG.Int: return w.i32(value);
    case TAG.Long: return w.i64(value);
    case TAG.Float: return w.f32(value);
    case TAG.Double: return w.f64(value);
    case TAG.ByteArray:
      w.i32(value.length); return w.bytes(value);
    case TAG.String: return w.string(value);
    case TAG.List: {
      const items = value.items;
      w.u8(value.elemType);
      w.i32(items.length);
      for (const item of items) writePayload(w, item);
      return;
    }
    case TAG.Compound: {
      for (const key of Object.keys(value)) {
        const child = value[key];
        w.u8(child.type);
        w.string(key);
        writePayload(w, child);
      }
      w.u8(TAG.End);
      return;
    }
    case TAG.IntArray: {
      w.i32(value.length);
      for (const v of value) w.i32(v);
      return;
    }
    case TAG.LongArray: {
      w.i32(value.length);
      for (const v of value) w.i64(v);
      return;
    }
    default:
      throw new Error('NBT: cannot write tag type ' + type);
  }
}

function parse(buf, offset = 0) {
  const r = new Reader(buf, offset);
  const type = r.u8();
  if (type === TAG.End) return { name: '', tag: null, offset: r.pos };
  const name = r.string();
  const tag = readPayload(r, type);
  return { name, tag, offset: r.pos };
}

function serialize(name, tag) {
  const w = new Writer(8192);
  w.u8(tag.type);
  w.string(name || '');
  writePayload(w, tag);
  return w.result();
}

function isGzip(buf) {
  return buf.length > 2 && buf[0] === 0x1F && buf[1] === 0x8B;
}

function readFile(file) {
  const raw = require('fs').readFileSync(file);
  const gzip = isGzip(raw);
  const data = gzip ? zlib.gunzipSync(raw) : raw;
  const parsed = parse(data);
  return { ...parsed, gzip, raw };
}

function writeFile(file, name, tag, gzip) {
  let data = serialize(name, tag);
  if (gzip) data = zlib.gzipSync(data, { level: 6 });
  const util = require('./util');
  util.atomicWrite(file, data);
}

// ---- convenience helpers -------------------------------------------------

function get(tag, key) {
  if (!tag || tag.type !== TAG.Compound) return null;
  return tag.value[key] || null;
}

function getString(tag, key) {
  const t = get(tag, key);
  return t && t.type === TAG.String ? t.value : null;
}

function setString(tag, key, value) {
  if (!tag || tag.type !== TAG.Compound) return;
  tag.value[key] = { type: TAG.String, value: String(value) };
}

function compound(obj) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(obj)) out[k] = v;
  return { type: TAG.Compound, value: out };
}

function stringTag(v) { return { type: TAG.String, value: String(v) }; }
function intTag(v) { return { type: TAG.Int, value: v }; }
function byteTag(v) { return { type: TAG.Byte, value: v }; }
function listTag(elemType, items) { return { type: TAG.List, value: { elemType, items } }; }

module.exports = {
  TAG, Reader, Writer, parse, serialize, readPayload, writePayload,
  readFile, writeFile, isGzip, get, getString, setString,
  compound, stringTag, intTag, byteTag, listTag,
  decodeModifiedUtf8, encodeModifiedUtf8,
};

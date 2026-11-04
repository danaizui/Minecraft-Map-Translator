'use strict';

/**
 * Minimal ZIP reader (store + deflate). Enough for Minecraft mod jars.
 * ZIP64 is not supported (extremely rare for mod jars).
 */

const fs = require('fs');
const zlib = require('zlib');

function readEntries(file, filter, namesOnly = false) {
  const buf = fs.readFileSync(file);
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  const start = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) return [];
  let p = cdOffset;
  const out = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800) ? rawName.toString('utf8') : rawName.toString('latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (filter && !filter(name)) continue;
    if (namesOnly) { out.push({ name }); continue; }
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) continue;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else continue;
    } catch (_) { continue; }
    if (uncompSize && data.length !== uncompSize) {
      // Some jars have slightly wrong sizes; keep data anyway.
    }
    out.push({ name, data });
  }
  return out;
}

module.exports = { readEntries, listNames };

function listNames(file, filter) {
  return readEntries(file, filter, true).map((e) => e.name);
}

'use strict';

/**
 * Minecraft Anvil region (.mca) reader / writer.
 * Rewrites the region sequentially with fresh sector allocation, which is
 * safe and avoids in-place fragmentation bugs.
 */

const fs = require('fs');
const zlib = require('zlib');
const nbt = require('./nbt');
const util = require('./util');

const SECTOR = 4096;
const HEADER_SECTORS = 2;

function decompress(type, data) {
  if (type === 1) return zlib.gunzipSync(data);
  if (type === 2) return zlib.inflateSync(data);
  if (type === 3) return data;
  return null; // LZ4 / unknown
}

function readRegion(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < HEADER_SECTORS * SECTOR) return { chunks: [], buf };
  const chunks = [];
  for (let i = 0; i < 1024; i++) {
    const loc = buf.readUInt32BE(i * 4);
    if (!loc) continue;
    let sector = loc >>> 8;
    let count = loc & 0xFF;
    if (count === 0) count = 256;
    const off = sector * SECTOR;
    if (off + 5 > buf.length) continue;
    const len = buf.readUInt32BE(off);
    if (len < 1 || off + 4 + len > buf.length) continue;
    const type = buf[off + 4];
    const compressed = buf.subarray(off + 5, off + 4 + len);
    const payload = buf.subarray(off + 4, off + 4 + len);
    let data;
    try { data = decompress(type, compressed); } catch (_) { data = null; }
    if (!data) {
      chunks.push({ index: i, cx: i % 32, cz: Math.floor(i / 32), nbt: null, raw: Buffer.from(payload), compression: type, error: 'unsupported compression' });
      continue;
    }
    try {
      const parsed = nbt.parse(data);
      chunks.push({ index: i, cx: i % 32, cz: Math.floor(i / 32), nbt: parsed.tag, rootName: parsed.name, raw: Buffer.from(payload), compression: type, error: null });
    } catch (e) {
      chunks.push({ index: i, cx: i % 32, cz: Math.floor(i / 32), nbt: null, raw: Buffer.from(payload), compression: type, error: e.message });
    }
  }
  return { chunks, buf };
}

function buildPayload(chunk) {
  if (!chunk.modified) return chunk.raw;
  const data = nbt.serialize(chunk.rootName || '', chunk.nbt);
  const deflated = zlib.deflateSync(data, { level: 6 });
  return Buffer.concat([Buffer.from([2]), deflated]);
}

function writeRegion(file, originalBuf, chunks) {
  let sector = HEADER_SECTORS;
  const locs = Buffer.alloc(4096);
  const entries = [];
  for (const chunk of chunks) {
    const payload = buildPayload(chunk);
    if (!payload || payload.length === 0) continue;
    const count = Math.ceil(payload.length / SECTOR);
    if (count > 256) throw new Error('chunk too large: ' + (payload.length / 1024 / 1024).toFixed(1) + ' MB');
    locs.writeUInt32BE(((sector << 8) | (count >= 256 ? 0 : count)) >>> 0, chunk.index * 4);
    entries.push({ sector, payload });
    sector += count;
  }
  const out = Buffer.alloc(sector * SECTOR);
  // Copy timestamps from the original header.
  if (originalBuf && originalBuf.length >= 8192) {
    originalBuf.copy(out, 4096, 4096, 8192);
  }
  locs.copy(out, 0);
  subcopyTimestamps(out, chunks);
  for (const e of entries) {
    const off = e.sector * SECTOR;
    out.writeUInt32BE(e.payload.length, off);
    e.payload.copy(out, off + 4);
  }
  util.atomicWrite(file, out);
}

function subcopyTimestamps(out, chunks) {
  const now = Math.floor(Date.now() / 1000);
  for (const chunk of chunks) {
    if (!chunk.modified) continue;
    out.writeUInt32BE(now, 4096 + chunk.index * 4);
  }
}

/**
 * Process all readable chunks in a region. handler(chunk) may mutate chunk.nbt.
 * Returns stats { chunks, parsed, modified }.
 */
async function processRegion(file, handler, beforeWrite, write = true) {
  const { chunks, buf } = readRegion(file);
  let modified = 0;
  let parsed = 0;
  for (const chunk of chunks) {
    if (!chunk.nbt) continue;
    parsed++;
    let changed = false;
    try {
      changed = await handler(chunk, file);
    } catch (e) {
      changed = false;
      chunk.error = (chunk.error ? chunk.error + '; ' : '') + e.message;
    }
    if (changed) {
      chunk.modified = true;
      modified++;
    }
  }
  if (modified > 0 && write) {
    if (beforeWrite) beforeWrite(file);
    writeRegion(file, buf, chunks);
  }
  return { chunks: chunks.length, parsed, modified, errors: chunks.filter((c) => c.error) };
}

module.exports = { readRegion, writeRegion, processRegion, SECTOR };

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(ROOT, 'backup');
const LOG_DIR = path.join(ROOT, 'logs');

function ensureDirs() {
  for (const d of [DATA_DIR, BACKUP_DIR, LOG_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
}

function sha1(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.mctmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

function walk(dir, onFile, opts = {}) {
  const maxDepth = opts.maxDepth == null ? 40 : opts.maxDepth;
  const skip = opts.skip || (() => false);
  function rec(d, depth) {
    if (depth > maxDepth) return;
    for (const ent of listDir(d)) {
      const full = path.join(d, ent.name);
      if (skip(full, ent)) continue;
      if (ent.isDirectory()) rec(full, depth + 1);
      else if (ent.isFile()) onFile(full, ent);
    }
  }
  rec(dir, 0);
}

function findFiles(dir, re, opts = {}) {
  const out = [];
  walk(dir, (f) => { if (re.test(f)) out.push(f); }, opts);
  return out;
}

function detectIndent(text) {
  const m = text.match(/^([ \t]+)"/m);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}

function decodeTextBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.toString('utf8', 3);
  }
  return buf.toString('utf8');
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePathForCompare(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

function uniqueBy(arr, fn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const key = fn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function timestampName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + '-' +
    p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds())
  );
}

module.exports = {
  ROOT, DATA_DIR, BACKUP_DIR, LOG_DIR,
  ensureDirs, sha1, sleep, formatBytes, atomicWrite, copyFile,
  exists, isDir, isFile, listDir, walk, findFiles,
  detectIndent, decodeTextBuffer, clamp, safeJsonParse, escapeRegExp,
  normalizePathForCompare, uniqueBy, timestampName,
};

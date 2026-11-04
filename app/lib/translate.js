'use strict';

/**
 * Translation engines (no API key required) + cache + batching.
 *  - Bing: Microsoft Translator public web endpoint, ~5000 chars/request.
 *  - MyMemory: public fallback, ~450 chars/request.
 *  - mock: deterministic pseudo-translator for self tests.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const util = require('./util');
const textUtil = require('./text');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0';

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

class BingEngine {
  constructor() {
    this.id = 'bing';
    this.name = '微软必应（免费）';
    this.maxChars = 4500;
    this.token = null;
    this.key = null;
    this.ig = null;
    this.expiry = 0;
    this.cookies = '';
    this.authPromise = null;
    this.cacheBust = 0;
  }

  async auth(force = false) {
    if (!force && this.token && Date.now() < this.expiry) return;
    if (this.authPromise) return this.authPromise;
    this.authPromise = (async () => {
      const url = 'https://cn.bing.com/translator?ref=TThis&from=en&to=zh-Hans' + (this.cacheBust++ ? '&cb=' + Date.now() : '');
      const res = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      }, 30000);
      if (!res.ok) throw new Error('必应页面加载失败 HTTP ' + res.status);
      const html = await res.text();
      const ig = (html.match(/IG:"([^"]+)"/) || [])[1];
      const m = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)",(\d+)\]/);
      if (!ig || !m) throw new Error('必应接口参数解析失败（页面结构可能已更新）');
      this.ig = ig;
      this.key = m[1];
      this.token = m[2];
      const interval = Number(m[3]) || 3600000;
      this.expiry = Date.now() + Math.max(60000, interval - 120000);
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (sc && sc.length) this.cookies = sc.map((c) => c.split(';')[0]).join('; ');
    })();
    try {
      await this.authPromise;
    } finally {
      this.authPromise = null;
    }
  }

  async translate(text, source = 'en', target = 'zh-Hans') {
    if (!text.trim()) return text;
    await this.auth();
    const to = target === 'zh-Hant' ? 'zh-Hant' : 'zh-Hans';
    const from = source === 'auto' ? 'auto-detect' : source || 'en';
    const body = new URLSearchParams({
      fromLang: from,
      to,
      text,
      token: this.token,
      key: this.key,
    });
    const url = 'https://cn.bing.com/ttranslatev3?isVertical=1&IG=' + encodeURIComponent(this.ig) + '&IID=translator.5023.1';
    const headers = {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://cn.bing.com/translator',
      'Origin': 'https://cn.bing.com',
      'Accept': 'application/json, text/plain, */*',
    };
    if (this.cookies) headers['Cookie'] = this.cookies;
    const res = await fetchWithTimeout(url, { method: 'POST', headers, body }, 35000);
    if (res.status === 429) throw new Error('必应请求过于频繁（429）');
    if (!res.ok) throw new Error('必应翻译接口 HTTP ' + res.status);
    const json = await res.json().catch(() => null);
    if (!Array.isArray(json) || !json[0] || !json[0].translations || !json[0].translations[0]) {
      if (json && json.statusCode === 205) {
        this.expiry = 0;
        throw new Error('必应令牌失效，正在重试');
      }
      throw new Error('必应返回数据异常');
    }
    const out = json[0].translations[0].text;
    if (typeof out !== 'string') throw new Error('必应返回空译文');
    return out;
  }
}

class MyMemoryEngine {
  constructor() {
    this.id = 'mymemory';
    this.name = 'MyMemory（备用）';
    this.maxChars = 430;
  }

  async translate(text, source = 'en', target = 'zh-Hans') {
    if (!text.trim()) return text;
    const pair = target === 'zh-Hant' ? 'en|zh-TW' : 'en|zh-CN';
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + encodeURIComponent(pair);
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    }, 30000);
    if (!res.ok) throw new Error('MyMemory HTTP ' + res.status);
    const json = await res.json().catch(() => null);
    if (!json || !json.responseData) throw new Error('MyMemory 返回数据异常');
    if (json.responseStatus && Number(json.responseStatus) !== 200) {
      throw new Error('MyMemory: ' + (json.responseDetails || json.responseStatus));
    }
    const out = textUtil.decodeHtmlEntities(String(json.responseData.translatedText || ''));
    if (!out) throw new Error('MyMemory 返回空译文');
    return out;
  }
}

class MockEngine {
  constructor() {
    this.id = 'mock';
    this.name = '本地测试（不联网）';
    this.maxChars = 100000;
  }
  async translate(text) {
    return text.split('\n').map((line) => {
      if (!/[A-Za-z]/.test(line)) return line;
      if ((line.match(/[\u4e00-\u9fff]/g) || []).length > 2) return line;
      return '【译】' + line;
    }).join('\n');
  }
}

class Cache {
  constructor(file, enabled) {
    this.file = file;
    this.enabled = enabled;
    this.map = new Map();
    this.dirty = 0;
    if (enabled) this.load();
  }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.version === 1 && raw.entries) {
        for (const [k, v] of Object.entries(raw.entries)) {
          if (typeof v === 'string') this.map.set(k, v);
        }
      }
    } catch (_) {}
  }
  get(key) { return this.enabled ? this.map.get(key) : undefined; }
  set(key, val) {
    if (!this.enabled) return;
    this.map.set(key, val);
    this.dirty++;
    if (this.dirty >= 300) this.save();
  }
  save() {
    if (!this.enabled) return;
    this.dirty = 0;
    try {
      let entries = this.map;
      if (entries.size > 250000) {
        const arr = Array.from(entries.entries()).slice(-200000);
        entries = new Map(arr);
        this.map = entries;
      }
      util.atomicWrite(this.file, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }));
    } catch (_) {}
  }
  clear() {
    this.map.clear();
    try { fs.unlinkSync(this.file); } catch (_) {}
  }
  get size() { return this.map.size; }
}

class Translator {
  constructor(options = {}) {
    this.options = options;
    this.source = options.source || 'en';
    this.target = options.target || 'zh-Hans';
    this.engineId = options.engine || 'bing';
    this.engines = {
      bing: new BingEngine(),
      mymemory: new MyMemoryEngine(),
      mock: new MockEngine(),
    };
    this.engine = this.engines[this.engineId] || this.engines.bing;
    this.fallback = this.engineId === 'bing' ? this.engines.mymemory : null;
    this.maxChars = Math.min(4500, options.batchChars || this.engine.maxChars);
    this.concurrency = Math.max(1, Math.min(4, options.concurrency || 2));
    this.minInterval = options.minInterval == null ? 120 : Math.max(0, options.minInterval);
    this.cache = new Cache(path.join(util.DATA_DIR, 'cache.json'), options.cache !== false);
    this.stats = {
      translated: 0, cached: 0, skipped: 0, failed: 0,
      requests: 0, chars: 0, batches: 0,
    };
    this.lastRequest = 0;
    this.stopped = false;
    this.dirty = false;
    this.onTranslated = typeof options.onTranslated === 'function' ? options.onTranslated : null;
    this.currentLabel = '';
  }

  isStopped() { return this.stopped; }
  stop() { this.stopped = true; }

  cacheKey(text) {
    return this.engineId + '|' + this.target + '|' + util.sha1(text);
  }

  async throttle() {
    const wait = this.lastRequest + this.minInterval - Date.now();
    if (wait > 0) await util.sleep(wait);
    this.lastRequest = Date.now();
  }

  async rawTranslate(text, attempt = 0) {
    if (this.stopped) throw new Error('已停止');
    for (const engine of [this.engine, this.fallback]) {
      if (!engine) continue;
      try {
        await this.throttle();
        this.stats.requests++;
        this.stats.chars += text.length;
        let out;
        if (text.length > engine.maxChars) {
          const parts = textUtil.splitLongText(text, engine.maxChars);
          const bits = [];
          for (const part of parts) {
            if (!part.trim()) { bits.push(part); continue; }
            bits.push(await engine.translate(part, this.source, this.target));
          }
          out = bits.join('');
        } else {
          out = await engine.translate(text, this.source, this.target);
        }
        if (out && out.trim()) return out;
        throw new Error('空译文');
      } catch (e) {
        if (this.stopped) throw e;
        if (attempt < 2 && engine === this.engine) {
          if (engine.id === 'bing') engine.expiry = 0;
          await util.sleep(600 * (attempt + 1));
          return this.rawTranslate(text, attempt + 1);
        }
        if (engine === this.engine && this.fallback) continue;
        throw e;
      }
    }
    throw new Error('没有可用的翻译引擎');
  }

  async translateLongItem(text) {
    const parts = textUtil.splitLongText(text, this.maxChars);
    const outs = [];
    for (const part of parts) {
      if (!part.trim()) { outs.push(part); continue; }
      outs.push(await this.rawTranslate(part));
    }
    return outs.join('');
  }

  async translateSegmented(text) {
    // Fallback: translate text pieces between protected tokens separately.
    const splitter = new RegExp('(' + textUtil.TOKEN_RE.source + ')', 'g');
    const parts = text.split(splitter);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i % 2 === 1) { out.push(part); continue; }
      if (!part.trim() || !textUtil.contentTranslatable(part, 'lang')) { out.push(part); continue; }
      try {
        out.push(await this.translateLongItem(part));
      } catch (_) {
        out.push(part);
      }
    }
    return out.join('');
  }

  async translateOne(candidate) {
    const { protectedText, tokens } = candidate;
    try {
      let translated;
      if (protectedText.length > this.maxChars) {
        translated = await this.translateLongItem(protectedText);
      } else {
        translated = await this.rawTranslate(protectedText);
      }
      const restored = textUtil.restore(translated, tokens);
      if (restored != null && restored.trim()) return restored;
      return await this.translateSegmented(candidate.original);
    } catch (e) {
      this.stats.failed++;
      return null;
    }
  }

  async translateGroup(group) {
    // group: [{original, protectedText, tokens, key}]
    if (group.length === 1) {
      const r = await this.translateOne(group[0]);
      return [r];
    }
    const joined = group.map((g) => g.protectedText).join('\n');
    let translated;
    try {
      translated = await this.rawTranslate(joined);
    } catch (_) {
      return Promise.all(group.map((g) => this.translateOne(g)));
    }
    const lines = translated.split(/\r?\n/);
    if (lines.length !== group.length) {
      return Promise.all(group.map((g) => this.translateOne(g)));
    }
    const results = [];
    for (let i = 0; i < group.length; i++) {
      const restored = textUtil.restore(lines[i], group[i].tokens);
      if (restored != null && restored.trim()) results.push(restored);
      else results.push(await this.translateOne(group[i]));
    }
    return results;
  }

  async translateBatch(items, onStats) {
    const results = new Array(items.length);
    const candidates = [];
    const candidateByText = new Map();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const original = it.text;
      if (!textUtil.shouldTranslate(original, it.key, it.mode)) {
        results[i] = original;
        if (original && original.trim()) this.stats.skipped++;
        continue;
      }
      let cand = candidateByText.get(original);
      if (!cand) {
        const p = textUtil.protect(original);
        cand = { original, protectedText: p.text, tokens: p.tokens, key: it.key, indexes: [] };
        candidateByText.set(original, cand);
        candidates.push(cand);
      }
      cand.indexes.push(i);
    }

    // Cache lookups.
    const missing = [];
    for (const cand of candidates) {
      const hit = this.cache.get(this.cacheKey(cand.original));
      if (hit != null) {
        cand.result = hit;
        this.stats.cached += cand.indexes.length;
      } else {
        missing.push(cand);
      }
    }

    // Build batches.
    const groups = [];
    let cur = [];
    let curLen = 0;
    for (const cand of missing) {
      const len = Math.min(cand.protectedText.length, this.maxChars);
      if (cur.length && curLen + len + 1 > this.maxChars) {
        groups.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(cand);
      curLen += len + 1;
    }
    if (cur.length) groups.push(cur);

    let cursor = 0;
    const runNext = async () => {
      while (cursor < groups.length) {
        if (this.stopped) throw new Error('已停止');
        const g = groups[cursor++];
        try {
          const outs = await this.translateGroup(g);
          for (let i = 0; i < g.length; i++) {
            const cand = g[i];
            const out = outs[i];
            if (out != null && out.trim()) {
              cand.result = out;
              this.cache.set(this.cacheKey(cand.original), out);
              this.stats.translated += cand.indexes.length;
              this.stats.batches++;
            } else {
              cand.result = cand.original;
              this.stats.failed += cand.indexes.length;
            }
          }
        } catch (e) {
          if (this.stopped) throw e;
          for (const cand of g) {
            cand.result = cand.original;
            this.stats.failed += cand.indexes.length;
          }
        }
        if (onStats) onStats(this.stats);
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(this.concurrency, groups.length); i++) workers.push(runNext());
    await Promise.all(workers);

    for (const cand of candidates) {
      const out = cand.result != null ? cand.result : cand.original;
      for (const idx of cand.indexes) results[idx] = out;
    }
    if (this.onTranslated) {
      for (const cand of candidates) {
        if (cand.result != null && cand.result !== cand.original) {
          try { this.onTranslated(cand.original, cand.result, cand.key, this.currentLabel); } catch (_) {}
        }
      }
    }
    if (onStats) onStats(this.stats);
    return results;
  }

  flush() { this.cache.save(); }
  clearCache() { this.cache.clear(); }
}

module.exports = { Translator, BingEngine, MyMemoryEngine, Cache };

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const util = require('./lib/util');
const core = require('./lib/core');

const VERSION = '1.1.0';
const HOST = '127.0.0.1';
const BASE_PORT = 17321;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOT_DIR = path.resolve(__dirname, '..');
const MAX_BODY = 4 * 1024 * 1024;

util.ensureDirs();

const state = {
  running: false,
  control: null,
  progress: { done: 0, total: 0, current: '' },
  stats: null,
  runId: null,
  lastReport: null,
  logTail: [],
  startedAt: null,
};
state.lastReport = core.readLastReport();

const clients = new Set();

function broadcast(event) {
  const payload = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
  if (event.type === 'log') {
    state.logTail.push(event);
    if (state.logTail.length > 300) state.logTail.shift();
  } else if (event.type === 'progress') {
    state.progress = { done: event.done, total: event.total, current: event.current };
  } else if (event.type === 'stats') {
    state.stats = event.stats;
  } else if (event.type === 'done') {
    state.lastReport = event.report;
    state.running = false;
    state.control = null;
    state.progress = { ...state.progress, current: '' };
  }
}

function emit(event) {
  broadcast(event);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function staticFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': type + '; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function openPath(target) {
  if (!target) throw new Error('路径为空');
  const abs = path.resolve(String(target));
  if (!util.exists(abs)) throw new Error('路径不存在：' + abs);
  if (util.isDir(abs)) {
    spawn('explorer.exe', [abs], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  } else {
    spawn('explorer.exe', ['/select,' + abs], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  }
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function pickFolder(title) {
  const script = `
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = ${psQuote(title || '选择 Minecraft 整合包文件夹 / 存档文件夹 / 地图文件夹')}
$dialog.ShowNewFolderButton = $false
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$owner.Show()
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }
`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true, timeout: 10 * 60 * 1000, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ path: String(stdout || '').trim() || null });
    });
  });
}

function openAppWindow(port) {
  const url = `http://${HOST}:${port}/`;
  const bases = [
    process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA,
    'C:\\Program Files (x86)', 'C:\\Program Files',
  ].filter(Boolean);
  const candidates = [];
  for (const b of bases) {
    candidates.push(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    candidates.push(path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  for (const exe of candidates) {
    if (util.isFile(exe)) {
      try {
        spawn(exe, ['--app=' + url, '--window-size=1280,880', '--no-first-run'], {
          detached: true, stdio: 'ignore', windowsHide: false,
        }).unref();
        return true;
      } catch (_) {}
    }
  }
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  } catch (_) {}
  return false;
}

async function isOurServer(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/ping`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return false;
    const j = await res.json();
    return !!(j && j.app === 'mc-map-translator');
  } catch (_) { return false; }
}

function sanitizeOptions(body) {
  const scope = body.scope || {};
  return {
    paths: Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === 'string' && p.trim()) : [],
    scope: {
      quests: scope.quests !== false,
      lang: scope.lang !== false,
      world: scope.world !== false,
    },
    patchouli: !!body.patchouli,
    engine: ['bing', 'mymemory', 'mock'].includes(body.engine) ? body.engine : 'bing',
    target: body.target === 'zh-Hant' ? 'zh-Hant' : 'zh-Hans',
    source: body.source === 'auto' ? 'auto' : 'en',
    concurrency: util.clamp(Number(body.concurrency) || 2, 1, 4),
    batchChars: util.clamp(Number(body.batchChars) || 4200, 600, 4800),
    minInterval: util.clamp(Number(body.minInterval) == null ? 120 : Number(body.minInterval), 0, 5000),
    cache: body.cache !== false,
    dryRun: !!body.dryRun,
    packName: String(body.packName || 'MC翻译_中文资源包').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 60) || 'MC翻译_中文资源包',
    packFormat: body.packFormat === 'auto' || body.packFormat == null ? 'auto' : Number(body.packFormat) || 'auto',
  };
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  if (route === '/api/ping') return json(res, 200, { ok: true, app: 'mc-map-translator', version: VERSION });

  if (route === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    clients.add(res);
    const snapshot = {
      type: 'snapshot',
      running: state.running,
      progress: state.progress,
      stats: state.stats,
      report: state.lastReport,
      logTail: state.logTail,
      version: VERSION,
    };
    res.write('data: ' + JSON.stringify(snapshot) + '\n\n');
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 25000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
    return;
  }

  if (route === '/api/analyze' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.paths || !body.paths.length) return json(res, 400, { error: '请先添加文件夹' });
    const options = sanitizeOptions(body);
    const result = core.analyze(options);
    return json(res, 200, result);
  }

  if (route === '/api/start' && req.method === 'POST') {
    if (state.running) return json(res, 409, { error: '已有翻译任务正在进行' });
    const body = await readBody(req);
    const options = sanitizeOptions(body);
    if (!options.paths.length) return json(res, 400, { error: '请先添加文件夹' });
    const control = { stopped: false };
    state.running = true;
    state.control = control;
    state.progress = { done: 0, total: 0, current: '准备中…' };
    state.stats = null;
    state.logTail = [];
    state.startedAt = Date.now();
    core.runTranslation(options, emit, control)
      .catch((e) => {
        emit({ type: 'log', level: 'error', msg: '任务异常：' + (e && e.message ? e.message : e), time: Date.now() });
        emit({ type: 'done', report: { error: e && e.message ? e.message : String(e), filesChanged: 0, stats: {}, errors: [{ message: String(e) }] } });
      })
      .finally(() => {
        state.running = false;
        state.control = null;
      });
    return json(res, 200, { ok: true });
  }

  if (route === '/api/stop' && req.method === 'POST') {
    if (!state.running || !state.control) return json(res, 200, { ok: true, running: false });
    state.control.stop();
    emit({ type: 'log', level: 'warn', msg: '正在停止（当前批次结束后停止）…', time: Date.now() });
    return json(res, 200, { ok: true, stopping: true });
  }

  if (route === '/api/report' && req.method === 'GET') {
    return json(res, 200, { report: core.readLastReport() });
  }

  if (route === '/api/undo' && req.method === 'POST') {
    if (state.running) return json(res, 409, { error: '翻译进行中，无法撤销' });
    const result = core.undoLast();
    state.lastReport = null;
    emit({ type: 'report-cleared' });
    emit({ type: 'log', level: 'success', msg: '已撤销上次翻译，恢复 ' + result.restored + ' 个文件', time: Date.now() });
    return json(res, 200, result);
  }

  if (route === '/api/clear-cache' && req.method === 'POST') {
    if (state.running) return json(res, 409, { error: '翻译进行中，无法清空缓存' });
    const r = core.clearCache();
    return json(res, 200, r);
  }

  if (route === '/api/pick' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const r = await pickFolder(body.title);
    return json(res, 200, r);
  }

  if (route === '/api/open' && req.method === 'POST') {
    const body = await readBody(req);
    openPath(body.path);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/shutdown' && req.method === 'POST') {
    json(res, 200, { ok: true });
    emit({ type: 'log', level: 'info', msg: '程序已退出', time: Date.now() });
    setTimeout(() => process.exit(0), 250);
    return;
  }

  return json(res, 404, { error: 'Not found' });
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.woff2': 'font/woff2', '.json': 'application/json',
};

function createServer() {
  return http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${HOST}`); }
    catch (_) { res.writeHead(400); return res.end('Bad request'); }

    if (url.pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url);
      } catch (e) {
        if (!res.headersSent) json(res, 500, { error: e && e.message ? e.message : String(e) });
        else { try { res.end(); } catch (_) {} }
      }
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel === '/app.ico') {
      staticFile(res, path.join(ROOT_DIR, 'app.ico'), 'image/x-icon');
      return;
    }
    if (rel.includes('..')) { res.writeHead(403); return res.end('Forbidden'); }
    const file = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    staticFile(res, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

async function listen(port) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

(async () => {
  let server = null;
  let port = BASE_PORT;
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (await isOurServer(p)) {
      try { fs.writeFileSync(path.join(util.DATA_DIR, 'port.txt'), String(p)); } catch (_) {}
      openAppWindow(p);
      process.exit(0);
    }
    try {
      server = await listen(p);
      port = p;
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') {
        fs.appendFileSync(path.join(util.LOG_DIR, 'server-error.log'), String(e.stack || e) + '\n');
      }
    }
  }
  if (!server) {
    fs.appendFileSync(path.join(util.LOG_DIR, 'server-error.log'), 'No available port\n');
    process.exit(1);
  }
  try { fs.writeFileSync(path.join(util.DATA_DIR, 'port.txt'), String(port)); } catch (_) {}
  fs.appendFileSync(path.join(util.LOG_DIR, 'server.log'), `[${new Date().toISOString()}] listening on ${port}\n`);
  openAppWindow(port);

  process.on('uncaughtException', (e) => {
    try { fs.appendFileSync(path.join(util.LOG_DIR, 'server-error.log'), `[${new Date().toISOString()}] ${e.stack || e}\n`); } catch (_) {}
  });
  process.on('unhandledRejection', (e) => {
    try { fs.appendFileSync(path.join(util.LOG_DIR, 'server-error.log'), `[${new Date().toISOString()}] unhandled: ${e && e.stack ? e.stack : e}\n`); } catch (_) {}
  });
})();

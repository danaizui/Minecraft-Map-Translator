'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  paths: [],
  analysis: null,
  analyzing: false,
  running: false,
  report: null,
  analyzeSeq: 0,
  startTime: 0,
  progress: { done: 0, total: 0, current: '' },
  stats: null,
  preview: [],
  previewFile: null,
};

const OPTION_IDS = [
  'scopeQuests', 'scopeLang', 'scopeWorld', 'patchouli',
  'engine', 'target', 'packFormat', 'concurrency',
  'dryRun', 'cache', 'source', 'batchChars', 'minInterval', 'packName',
];

const ENGINE_NAMES = {
  bing: '微软必应（免费）',
  mymemory: 'MyMemory（备用）',
  mock: '本地测试（不联网）',
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function normPath(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

async function api(url, body) {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = {};
  try { j = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(j.error || ('请求失败 HTTP ' + res.status));
  return j;
}

function toast(msg, type = 'info', ms = 4200) {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all .2s';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

function setStatus(kind, text) {
  const pill = $('statusPill');
  pill.className = 'pill ' + kind;
  $('statusText').textContent = text;
}

function collectOptions() {
  return {
    scope: {
      quests: $('scopeQuests').checked,
      lang: $('scopeLang').checked,
      world: $('scopeWorld').checked,
    },
    patchouli: $('patchouli').checked,
    engine: $('engine').value,
    target: $('target').value,
    packFormat: $('packFormat').value,
    concurrency: Number($('concurrency').value),
    dryRun: $('dryRun').checked,
    cache: $('cache').checked,
    source: $('source').value,
    batchChars: Number($('batchChars').value) || 4200,
    minInterval: Number($('minInterval').value) || 0,
    packName: $('packName').value.trim() || 'MC翻译_中文资源包',
    paths: state.paths.slice(),
  };
}

function saveSettings() {
  try {
    const data = {};
    for (const id of OPTION_IDS) {
      const el = $(id);
      data[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    data.paths = state.paths;
    localStorage.setItem('mct.settings.v1', JSON.stringify(data));
  } catch (_) {}
}

function loadSettings() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem('mct.settings.v1') || '{}'); } catch (_) {}
  for (const id of OPTION_IDS) {
    if (!(id in data)) continue;
    const el = $(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!data[id];
    else el.value = data[id];
  }
  state.paths = Array.isArray(data.paths) ? data.paths.filter((p) => typeof p === 'string') : [];
}

function updateStartButton() {
  const hasWork = state.analysis && state.analysis.totals && state.analysis.totals.files > 0;
  $('startBtn').disabled = state.running || state.analyzing || !state.paths.length || (!hasWork && !!state.analysis);
  $('startBtn').hidden = state.running;
  $('stopBtn').hidden = !state.running;
  $('startBtnText').textContent = state.report && state.report.filesChanged ? '再次翻译' : '开始翻译';
}

function renderPaths() {
  const list = $('pathList');
  const empty = $('emptyPaths');
  $('pathCount').textContent = String(state.paths.length);
  empty.hidden = state.paths.length > 0;
  const byPath = new Map();
  if (state.analysis && state.analysis.targets) {
    for (const t of state.analysis.targets) byPath.set(normPath(t.path), t);
  }
  list.innerHTML = '';
  state.paths.forEach((p, i) => {
    const info = byPath.get(normPath(p));
    const kind = info ? info.kind : 'pending';
    const detail = info && info.detail ? info.detail : null;
    const item = document.createElement('div');
    item.className = 'path-item ' + (kind === 'world' ? 'world' : '');
    const chips = [];
    if (detail) {
      if (detail.quests) chips.push('任务书 ' + detail.quests);
      if (detail.jars) chips.push('模组 ' + detail.jars);
      if (detail.worlds) chips.push('存档 ' + detail.worlds);
      if (detail.regions) chips.push('区块 ' + detail.regions);
      if (detail.dataFiles) chips.push('数据 ' + detail.dataFiles);
      if (detail.npcJson) chips.push('NPC ' + detail.npcJson);
    }
    item.innerHTML = `
      <div class="path-badge">${kind === 'world' ? '🗺️' : '📦'}</div>
      <div class="path-main">
        <div class="path-name">
          <span class="name-text"></span>
          <span class="tag ${kind === 'world' ? 'world' : (kind === 'pending' ? 'pending' : '')}">${kind === 'world' ? '存档' : (kind === 'instance' ? '整合包' : '待分析')}</span>
        </div>
        <div class="path-full"></div>
        ${chips.length ? `<div class="path-detail">${chips.map((c) => `<span>${escapeHtml(c)}</span>`).join('')}</div>` : ''}
      </div>
      <button class="path-remove" data-index="${i}" title="移除">✕</button>`;
    item.querySelector('.name-text').textContent = info ? info.label : (p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p);
    const full = item.querySelector('.path-full');
    full.textContent = p;
    full.title = p;
    list.appendChild(item);
  });
}

function updateSummary() {
  const a = state.analysis;
  if (!a || !a.totals) {
    $('statFiles').textContent = '0';
    $('statFilesSub').textContent = '任务书 0 · 模组 0 · 区块 0';
    return;
  }
  const t = a.totals;
  $('statFiles').textContent = String(t.files || 0);
  $('statFilesSub').textContent = `任务书 ${t.questFiles} · 模组 ${t.jars} · 区块 ${t.regions}`;
}

function renderWarnings(warnings) {
  const el = $('warningBanner');
  const list = (warnings || []).filter(Boolean);
  if (!list.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<b>提示</b><ul>${list.slice(0, 8).map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
}

async function analyze() {
  saveSettings();
  const seq = ++state.analyzeSeq;
  if (!state.paths.length) {
    state.analysis = null;
    state.analyzing = false;
    renderPaths();
    updateSummary();
    renderWarnings([]);
    setStatus('ready', '就绪');
    updateStartButton();
    return;
  }
  state.analyzing = true;
  setStatus('working', '分析中');
  updateStartButton();
  try {
    const res = await api('/api/analyze', collectOptions());
    if (seq !== state.analyzeSeq) return;
    state.analysis = res;
    renderPaths();
    updateSummary();
    renderWarnings(res.warnings);
    setStatus(res.totals.files ? 'ready' : 'error', res.totals.files ? '就绪' : '无内容');
    if (!res.totals.files) toast('没有找到可翻译内容，请检查路径或翻译范围', 'warn', 6000);
  } catch (e) {
    if (seq !== state.analyzeSeq) return;
    state.analysis = null;
    renderPaths();
    updateSummary();
    renderWarnings([e.message]);
    setStatus('error', '分析失败');
    toast(e.message, 'error', 6000);
  } finally {
    if (seq === state.analyzeSeq) {
      state.analyzing = false;
      updateStartButton();
    }
  }
}

function addPath(p) {
  let v = String(p || '').trim().replace(/^"(.*)"$/, '$1');
  if (!v) return;
  if (state.paths.some((x) => normPath(x) === normPath(v))) {
    toast('这个路径已经添加过了', 'warn');
    return;
  }
  state.paths.push(v);
  saveSettings();
  renderPaths();
  analyze();
}

async function pickAndAdd() {
  if (state.analyzing || state.running) return;
  try {
    const r = await api('/api/pick', { title: '选择 Minecraft 整合包 / 存档 / 地图文件夹' });
    if (r.path) addPath(r.path);
  } catch (e) {
    toast('无法打开文件夹选择器：' + e.message, 'error', 6000);
  }
}

function setProgress(done, total, current) {
  state.progress = { done, total, current };
  const pct = total > 0
    ? Math.min(100, Math.round((done / total) * 100))
    : (!state.running && state.report ? 100 : 0);
  const bar = $('progressBar');
  bar.style.width = pct + '%';
  bar.className = 'bar-fill' + (pct >= 100 ? ' full' : (pct === 0 ? ' idle' : ''));
  $('progressPct').textContent = pct + '%';
  $('progressText').textContent = state.running ? (pct >= 100 ? '收尾中…' : '翻译中…') : (pct >= 100 ? '已完成' : '尚未开始');
  $('progressCount').textContent = total ? `${done} / ${total}` : '';
  $('currentFile').textContent = current || (state.running ? '准备中…' : '选择文件夹并点击「开始翻译」');
  $('currentFile').title = current || '';
}

function setStats(stats) {
  if (!stats) return;
  state.stats = stats;
  $('statTranslated').textContent = String(stats.translated || 0);
  $('statCached').textContent = String(stats.cached || 0);
  $('statFailed').textContent = String(stats.failed || 0);
  $('statSkipped').textContent = '跳过 ' + (stats.skipped || 0) + ' 条';
}

function timeLabel(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

const LEVEL_NAME = { info: '信息', success: '完成', warn: '注意', error: '错误' };

function appendLog(ev, forceScroll) {
  const box = $('logBox');
  const empty = box.querySelector('.log-empty');
  if (empty) empty.remove();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const line = document.createElement('div');
  line.className = 'log-line ' + (ev.level || 'info');
  line.innerHTML = `
    <span class="log-time">${timeLabel(ev.time)}</span>
    <span class="log-level">${LEVEL_NAME[ev.level] || '信息'}</span>
    <span class="log-msg"></span>`;
  line.querySelector('.log-msg').textContent = ev.msg || '';
  box.appendChild(line);
  while (box.children.length > 1600) box.removeChild(box.firstChild);
  if (forceScroll || atBottom) box.scrollTop = box.scrollHeight;
}

function resetLog() {
  $('logBox').innerHTML = '<div class="log-empty">日志会显示在这里。所有翻译都会先备份，出问题可一键撤销。</div>';
}

function switchTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('logPanel').hidden = name !== 'log';
  $('reportPanel').hidden = name !== 'report';
  $('previewPanel').hidden = name !== 'preview';
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0 秒';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return m + ' 分 ' + r + ' 秒';
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
}

function renderReport(report) {
  const panel = $('reportPanel');
  if (!report) {
    panel.innerHTML = '<div class="report-empty">完成一次翻译后，这里会显示统计、资源包位置和错误列表。</div>';
    return;
  }
  if (report.error && !report.runId) {
    panel.innerHTML = `<div class="report-body">
      <div class="report-head"><div><div class="report-title">任务异常</div>
      <div class="report-sub">${escapeHtml(report.error)}</div></div>
      <button class="btn small ghost" data-open-root>打开程序目录</button></div></div>`;
    return;
  }
  const st = report.stats || {};
  const errors = report.errors || [];
  const changed = report.changedFiles || [];
  const packs = report.packDirs || [];
  const title = report.stopped ? '已停止（已完成部分）' : (report.dryRun ? '预览完成（未写入文件）' : '翻译完成');
  const parts = [];
  parts.push(`<div class="report-body">
    <div class="report-head">
      <div>
        <div class="report-title">${title}</div>
        <div class="report-sub">${escapeHtml(report.runId || '')} · 耗时 ${formatDuration(report.durationMs)} · 引擎 ${escapeHtml(ENGINE_NAMES[report.engine] || report.engine || '')}</div>
      </div>
      <div class="report-actions">
        ${packs.map((p, i) => `<button class="btn small" data-open-pack="${i}">📂 打开资源包</button>`).join(' ')}
      </div>
    </div>
    <div class="report-grid">
      <div class="report-stat"><span>修改文件</span><strong>${report.filesChanged || 0}</strong></div>
      <div class="report-stat"><span>新翻译</span><strong>${st.translated || 0}</strong></div>
      <div class="report-stat"><span>缓存命中</span><strong>${st.cached || 0}</strong></div>
      <div class="report-stat"><span>失败文本</span><strong>${st.failed || 0}</strong></div>
    </div>`);

  if (report.dryRun) {
    parts.push(`<div class="banner warn" style="display:block">预览模式：没有写入任何文件。切换到上方「译文预览」标签可查看原文与译文对照${report.previewFile ? '；完整内容已保存到 data\\preview.txt' : ''}。</div>`);
  }
  if (packs.length) {
    parts.push(`<div class="report-section"><h4>生成的中文资源包</h4>`);
    packs.forEach((p, i) => {
      parts.push(`<div class="pack-row"><code>${escapeHtml(p)}</code><button class="btn tiny ghost" data-open-pack="${i}">打开</button></div>`);
    });
    parts.push(`<div class="report-note">进入游戏后在「选项 → 资源包」中启用它。任务书语言文件通常无需手动启用。</div></div>`);
  }
  if (errors.length) {
    parts.push(`<div class="report-section"><h4>失败与警告（${errors.length}）</h4>`);
    for (const e of errors.slice(0, 100)) {
      parts.push(`<div class="err-item"><b>${escapeHtml(e.file || '')}</b><span>${escapeHtml(e.message || '')}</span></div>`);
    }
    if (errors.length > 100) parts.push(`<div class="report-note">仅显示前 100 条，共 ${errors.length} 条。</div>`);
    parts.push('</div>');
  }
  parts.push(`<div class="report-section"><h4>修改的文件（${report.filesChanged || 0}）</h4>`);
  if (changed.length) {
    parts.push(`<div class="file-list">${changed.map((f) => `<div>${escapeHtml(f)}</div>`).join('')}</div>`);
    if ((report.filesChanged || 0) > changed.length) parts.push(`<div class="report-note">仅列出前 ${changed.length} 个文件。</div>`);
  } else {
    parts.push(`<div class="report-note">${report.dryRun ? '预览模式未写入文件。' : '没有文件被修改，可能所有内容都已翻译过。'}</div>`);
  }
  parts.push('</div></div>');
  panel.innerHTML = parts.join('');
  panel.querySelectorAll('[data-open-pack]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = packs[Number(btn.dataset.openPack)];
      if (p) openPath(p);
    });
  });
}

function paintPreview(query) {
  const list = $('previewList');
  const items = state.preview || [];
  const q = String(query || '').trim().toLowerCase();
  const rows = q
    ? items.filter((p) => (p.original + '\n' + p.translated + '\n' + (p.file || '') + '\n' + (p.key || '')).toLowerCase().includes(q))
    : items;
  if (!rows.length) {
    list.innerHTML = `<div class="report-empty">${items.length ? '没有匹配的条目。' : '预览模式下完成一次翻译后，这里会显示原文与译文对照；普通翻译完成后也会保留前 300 条样例。'}</div>`;
    return;
  }
  list.innerHTML = rows.map((p, i) => `
    <div class="preview-row">
      <div class="preview-orig"><span class="preview-marker">${i + 1}</span>${escapeHtml(p.original)}</div>
      <div class="preview-trans">${escapeHtml(p.translated)}</div>
      <div class="preview-meta">${escapeHtml(p.file || '')}${p.key ? ' · ' + escapeHtml(p.key) : ''}</div>
    </div>`).join('');
}

function renderPreview(report) {
  state.preview = (report && Array.isArray(report.preview)) ? report.preview : [];
  state.previewFile = (report && report.previewFile) || null;
  const total = (report && report.previewTotal) || state.preview.length;
  const countEl = $('previewCount');
  countEl.textContent = state.preview.length
    ? `样例 ${state.preview.length} 条 / 共 ${total} 条`
    : '';
  $('openPreviewFileBtn').hidden = !state.previewFile;
  $('previewSearch').value = '';
  paintPreview('');
}

function resetPreview() {
  state.preview = [];
  state.previewFile = null;
  $('previewCount').textContent = '';
  $('openPreviewFileBtn').hidden = true;
  $('previewSearch').value = '';
  paintPreview('');
}

async function openPath(p) {
  try { await api('/api/open', { path: p }); }
  catch (e) { toast('无法打开：' + e.message, 'error'); }
}

function handleDone(report) {
  state.running = false;
  state.report = report;
  setStatus(report.stopped ? 'ready' : (report.error ? 'error' : 'done'), report.stopped ? '已停止' : (report.error ? '出错' : '已完成'));
  setProgress(state.progress.done, state.progress.total, report.stopped ? '已停止' : '全部完成');
  setStats(report.stats || state.stats);
  const body = { ...report };
  if (!body.changedFiles && Array.isArray(report.changedFiles)) body.changedFiles = report.changedFiles;
  renderReport(report);
  renderPreview(report);
  switchTab(report.dryRun && state.preview.length ? 'preview' : 'report');
  updateStartButton();
  const hasUndo = (report.filesChanged || 0) > 0;
  $('undoBtn').disabled = !hasUndo || !!report.dryRun;
  if (report.error && !report.runId) toast('任务出错：' + report.error, 'error', 8000);
  else if (report.stopped) toast('已停止。已完成的文件都已有备份，可撤销。', 'warn', 6000);
  else if (report.dryRun) toast(`预览完成：共 ${report.previewTotal || 0} 条译文，可在「译文预览」查看。`, 'info', 6000);
  else toast(`翻译完成：修改 ${report.filesChanged || 0} 个文件，新翻译 ${(report.stats || {}).translated || 0} 条`, 'success', 6000);
}

function handleSnapshot(s) {
  if (s.running) {
    state.running = true;
    setStatus('working', '翻译中');
    $('startBtn').disabled = true;
    $('startBtn').hidden = true;
    $('stopBtn').hidden = false;
    $('stopBtn').disabled = false;
    $('stopBtn').innerHTML = '<span class="btn-icon">■</span>停止';
    resetLog();
    for (const ev of s.logTail || []) appendLog(ev, false);
    $('logBox').scrollTop = $('logBox').scrollHeight;
    setProgress(s.progress.done || 0, s.progress.total || 0, s.progress.current);
    setStats(s.stats);
  } else if (s.report) {
    state.report = s.report;
    setStatus('done', '已完成');
    setProgress(0, 0, '上次翻译已完成，可再次运行');
    if (s.report.stats) setStats(s.report.stats);
    $('undoBtn').disabled = !(s.report.filesChanged > 0) || !!s.report.dryRun;
    renderReport(s.report);
    renderPreview(s.report);
    if (s.report.dryRun && (s.report.preview || []).length) switchTab('preview');
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    if (ev.type === 'snapshot') { handleSnapshot(ev); return; }
    if (ev.type === 'log') appendLog(ev, true);
    else if (ev.type === 'stats') setStats(ev.stats);
    else if (ev.type === 'report-cleared') {
      state.report = null;
      renderReport(null);
      $('undoBtn').disabled = true;
      setStatus('ready', '已撤销');
      resetPreview();
    } else if (ev.type === 'progress') {
      setProgress(ev.done, ev.total, ev.current);
    } else if (ev.type === 'start') {
      state.running = true;
      state.startTime = Date.now();
      state.report = null;
      $('startBtn').hidden = true;
      $('stopBtn').hidden = false;
      $('stopBtn').disabled = false;
      $('undoBtn').disabled = true;
      if (ev.plan && ev.plan.totals) {
        state.analysis = { ...(state.analysis || {}), totals: ev.plan.totals, warnings: ev.plan.warnings || [] };
        updateSummary();
        renderWarnings(ev.plan.warnings || []);
      }
      setStatus('working', '翻译中');
      setProgress(0, ev.total || 0, '准备中…');
      switchTab('log');
    } else if (ev.type === 'done') {
      handleDone(ev.report || {});
    }
  };
  es.onerror = () => {
    if (state.running) setStatus('error', '连接中断');
  };
}

function updateEngineHint() {
  const e = $('engine').value;
  $('engineHint').textContent = '引擎：' + (ENGINE_NAMES[e] || e) + (e === 'mock' ? '（不产生真实译文）' : '');
}

async function startTranslation() {
  if (state.running) return;
  const opts = collectOptions();
  if (!opts.paths.length) { toast('请先添加文件夹', 'warn'); return; }
  if (!opts.scope.quests && !opts.scope.lang && !opts.scope.world) {
    toast('请至少选择一个翻译范围', 'warn');
    return;
  }
  saveSettings();
  $('startBtn').disabled = true;
  try {
    const r = await api('/api/start', opts);
    if (r.error) throw new Error(r.error);
    state.running = true;
    state.report = null;
    state.progress = { done: 0, total: 0, current: '准备中…' };
    state.startTime = Date.now();
    resetLog();
    resetPreview();
    setStats({ translated: 0, cached: 0, failed: 0, skipped: 0 });
    setProgress(0, 0, '准备中…');
    setStatus('working', '翻译中');
    $('startBtn').hidden = true;
    $('stopBtn').hidden = false;
    $('stopBtn').disabled = false;
    $('stopBtn').innerHTML = '<span class="btn-icon">■</span>停止';
    $('undoBtn').disabled = true;
    switchTab('log');
  } catch (e) {
    toast(e.message, 'error', 7000);
    setStatus('error', '启动失败');
    updateStartButton();
  }
}

async function stopTranslation() {
  if (!state.running) return;
  $('stopBtn').disabled = true;
  $('stopBtn').innerHTML = '正在停止…';
  try { await api('/api/stop', {}); toast('已发送停止请求，当前批次结束后停止', 'warn'); }
  catch (e) { toast(e.message, 'error'); $('stopBtn').disabled = false; }
}

async function undoLast() {
  if (state.running) return;
  if (!confirm('确定撤销上一次翻译吗？所有被修改的文件会恢复到翻译前的状态。')) return;
  try {
    const r = await api('/api/undo', {});
    toast(`已撤销：恢复 ${r.restored} 个文件`, 'success', 6000);
    $('undoBtn').disabled = true;
    state.report = null;
    renderReport(null);
    setStatus('ready', '已撤销');
    resetPreview();
  } catch (e) { toast(e.message, 'error', 6000); }
}

async function clearCache() {
  if (state.running) return;
  if (!confirm('确定清空翻译缓存吗？清除后同样的文本会重新请求翻译。')) return;
  try {
    await api('/api/clear-cache', {});
    $('cacheInfo').textContent = '缓存已清空';
    toast('翻译缓存已清空', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function bindEvents() {
  $('addPathBtn').addEventListener('click', pickAndAdd);
  $('manualAddBtn').addEventListener('click', () => {
    const v = $('manualPath').value;
    if (v.trim()) { addPath(v); $('manualPath').value = ''; }
  });
  $('manualPath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('manualAddBtn').click(); }
  });
  $('pathList').addEventListener('click', (e) => {
    const btn = e.target.closest('.path-remove');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    if (Number.isInteger(idx) && idx >= 0) {
      state.paths.splice(idx, 1);
      saveSettings();
      renderPaths();
      analyze();
    }
  });

  for (const id of OPTION_IDS) {
    const el = $(id);
    if (!el) continue;
    const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      saveSettings();
      if (['scopeQuests', 'scopeLang', 'scopeWorld', 'patchouli', 'target', 'packName'].includes(id)) analyze();
      if (id === 'engine') updateEngineHint();
    });
  }

  $('startBtn').addEventListener('click', startTranslation);
  $('stopBtn').addEventListener('click', stopTranslation);
  $('undoBtn').addEventListener('click', undoLast);
  $('clearCacheBtn').addEventListener('click', clearCache);
  $('clearLogBtn').addEventListener('click', resetLog);
  $('previewSearch').addEventListener('input', (e) => paintPreview(e.target.value));
  $('openPreviewFileBtn').addEventListener('click', () => {
    if (state.previewFile) openPath(state.previewFile);
  });
  $('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
  $('closeHelp').addEventListener('click', () => $('helpDialog').close());
  $('helpDialog').addEventListener('click', (e) => {
    if (e.target === $('helpDialog')) $('helpDialog').close();
  });
  $('quitBtn').addEventListener('click', async () => {
    if (state.running && !confirm('翻译正在进行中，确定退出吗？')) return;
    if (!state.running && !confirm('确定退出 MC 地图翻译器吗？')) return;
    try { await api('/api/shutdown', {}); } catch (_) {}
    window.close();
  });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
}

async function init() {
  loadSettings();
  bindEvents();
  updateEngineHint();
  renderPaths();
  updateSummary();
  updateStartButton();
  connectEvents();
  setProgress(0, 0, '');
  if (state.paths.length) analyze();
  else setStatus('ready', '就绪');

  try {
    const r = await api('/api/report');
    if (r.report) {
      state.report = r.report;
      renderReport(r.report);
      renderPreview(r.report);
      $('undoBtn').disabled = !(r.report.filesChanged > 0) || !!r.report.dryRun;
      if (r.report.dryRun && (r.report.preview || []).length) switchTab('preview');
    }
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', init);

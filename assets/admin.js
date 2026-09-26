/* 本机管理模式：只有监听在回环地址的服务才会启用写入控件。 */
(function () {
  'use strict';

  const admin = {
    enabled: false,
    mode: '',
    candidates: [],
    selected: null,
    jobTimer: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));

  function setAdminVisible(visible) {
    admin.enabled = visible;
    document.body.classList.toggle('is-admin', visible);
    document.querySelectorAll('.admin-only, .admin-write-only').forEach((element) => {
      element.hidden = !visible;
    });
    const badge = $('#adminStatus');
    if (badge) badge.textContent = visible ? '本机管理 · 已启动' : '本机管理';
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
    return body;
  }

  async function refreshPublicMeta() {
    try {
      const meta = await api('/api/public-meta');
      if (!meta?.lastSync) return;
      const date = new Date(meta.lastSync);
      const mode = meta.mode === 'full' ? '全量' : '增量';
      const syncTime = $('#syncTime');
      if (syncTime) syncTime.textContent = `公开数据最近同步：${date.toLocaleString('zh-CN', { hour12: false })} · ${mode}`;
    } catch {}
  }

  function renderCandidateList() {
    const list = $('#adminCandidates');
    if (!list) return;
    if (!admin.candidates.length) {
      list.innerHTML = '<p class="admin-empty">没有搜索结果，请换一个关键词。</p>';
      return;
    }
    list.innerHTML = admin.candidates.map((item, index) => `
      <button type="button" class="admin-candidate ${admin.selected?.id === item.id ? 'is-selected' : ''}" data-candidate-index="${index}">
        <span class="admin-candidate-poster">${item.cover ? `<img src="${escapeHtml(item.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.hidden=true; this.nextElementSibling.hidden=false">` : ''}<span class="admin-candidate-cover-fallback" ${item.cover ? 'hidden' : ''}>海报</span></span>
        <span class="admin-candidate-info">
          <b>${escapeHtml(item.title)}</b>
          <small>${escapeHtml(item.year || item.abstract || item.type || '')}${item.score ? ` · 豆瓣 ${item.score}` : ''}</small>
        </span>
      </button>`).join('');
    list.querySelectorAll('[data-candidate-index]').forEach((button) => {
      button.addEventListener('click', () => {
        admin.selected = admin.candidates[Number(button.dataset.candidateIndex)];
        list.querySelectorAll('.admin-candidate').forEach((item) => item.classList.toggle('is-selected', item === button));
        $('#adminDialogSubmit').textContent = admin.mode === 'library' ? '添加这本书' : '添加这部影视';
      });
    });
  }

  function openSearchDialog(mode) {
    admin.mode = mode;
    admin.candidates = [];
    admin.selected = null;
    const isLibrary = mode === 'library';
    $('#adminDialogTitle').textContent = isLibrary ? '从豆瓣添加书籍' : '从豆瓣添加影视';
    $('#adminDialogBody').innerHTML = `
      <label class="admin-label">搜索名称
        <input class="modal-input" id="adminSearchInput" autocomplete="off" placeholder="输入${isLibrary ? '书名' : '电影、剧集或动漫名称'}…">
      </label>
      ${isLibrary ? '' : `<label class="admin-label">分类
        <select class="sort-select admin-category" id="adminCategory"><option value="movie">电影</option><option value="series">剧集</option><option value="anime">动漫</option></select>
      </label>`}
      <div class="admin-candidates" id="adminCandidates"><p class="admin-empty">输入关键词后点击搜索。</p></div>`;
    $('#adminDialogSubmit').textContent = '搜索';
    $('#adminDialogSubmit').disabled = false;
    $('#adminDialog').showModal();
    const input = $('#adminSearchInput');
    input.addEventListener('input', () => {
      admin.selected = null;
      $('#adminDialogSubmit').textContent = '搜索';
      document.querySelectorAll('#adminCandidates .admin-candidate').forEach((item) => item.classList.remove('is-selected'));
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        searchCandidates();
      }
    });
    input.focus();
  }

  function openSyncModeDialog() {
    admin.mode = 'favorites-sync-mode';
    admin.selected = null;
    $('#adminDialogTitle').textContent = '同步收藏';
    $('#adminDialogBody').innerHTML = `
      <p class="modal-desc">选择本次同步方式。增量同步保留已取消内容，全量同步会重新校对并清理已取消内容。</p>
      <label class="admin-label">同步方式
        <select class="sort-select admin-category" id="adminSyncMode">
          <option value="incremental" selected>增量同步（推荐）</option>
          <option value="full">全量同步</option>
        </select>
      </label>`;
    $('#adminDialogSubmit').textContent = '开始同步';
    $('#adminDialogSubmit').disabled = false;
    $('#adminDialog').showModal();
  }

  function openTheatreEditDialog() {
    const modal = $('#theatreModal');
    const id = modal?.dataset.theatreId || '';
    if (!id) return showToast('请先打开一部影视的详情', true);
    admin.mode = 'theatre-edit';
    admin.selected = null;
    const currentDate = modal.dataset.theatreCurrentDate || new Date().toISOString().slice(0, 10);
    $('#adminDialogTitle').textContent = '修改观看时间';
    $('#adminDialogBody').innerHTML = `
      <p class="modal-desc">保存后会更新本地影视源文件，重新生成 Theatre 数据并发布到公开站点。</p>
      <label class="admin-label">观看日期
        <input class="modal-input" id="theatreWatchDate" type="date" value="${escapeHtml(currentDate)}">
      </label>`;
    $('#adminDialogSubmit').textContent = '保存并发布';
    $('#adminDialogSubmit').disabled = false;
    $('#adminDialog').showModal();
  }

  async function searchCandidates() {
    const query = $('#adminSearchInput').value.trim();
    if (!query) return showToast('请输入搜索关键词', true);
    const button = $('#adminDialogSubmit');
    button.disabled = true;
    button.textContent = '搜索中…';
    try {
      const endpoint = admin.mode === 'library' ? '/api/douban/books/search' : '/api/douban/movies/search';
      const data = await api(`${endpoint}?q=${encodeURIComponent(query)}`);
      admin.candidates = data.results || [];
      admin.selected = null;
      renderCandidateList();
      button.textContent = '搜索';
    } catch (error) {
      showToast(error.message, true);
      button.textContent = '搜索';
    } finally {
      button.disabled = false;
    }
  }

  async function addSelected() {
    if (admin.mode === 'theatre-edit') {
      const button = $('#adminDialogSubmit');
      const id = $('#theatreModal')?.dataset.theatreId || '';
      const currentDate = $('#theatreWatchDate')?.value || '';
      if (!currentDate) return showToast('请选择观看日期', true);
      button.disabled = true;
      button.textContent = '保存中…';
      try {
        const job = await api('/api/theatre/update', { method: 'POST', body: JSON.stringify({ id, currentDate }) });
        $('#adminDialog').close();
        $('#theatreModal')?.close();
        showToast('观看时间已保存，正在生成并发布…');
        watchJob(job.id);
      } catch (error) {
        showToast(error.message, true);
        button.disabled = false;
        button.textContent = '保存并发布';
      }
      return;
    }
    if (admin.mode === 'favorites-sync-mode') {
      const fullSync = $('#adminSyncMode').value === 'full';
      $('#adminDialog').close();
      startWorkflow('favorites', fullSync);
      return;
    }
    if (!admin.selected) return searchCandidates();
    const button = $('#adminDialogSubmit');
    button.disabled = true;
    button.textContent = '处理中…';
    try {
      const payload = admin.mode === 'library'
        ? { id: admin.selected.id, query: admin.selected.title }
        : { ...admin.selected, category: $('#adminCategory').value };
      const result = await api(`/api/${admin.mode}/add`, { method: 'POST', body: JSON.stringify(payload) });
      $('#adminDialog').close();
      showToast(`${admin.mode === 'library' ? '书籍' : '影视'}已加入，正在生成并发布…`);
      watchJob(result.id);
    } catch (error) {
      showToast(error.message, true);
      button.disabled = false;
      button.textContent = '添加这条记录';
    }
  }

  async function startWorkflow(type, fullSync = false) {
    try {
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ type, fullSync }) });
      showToast(type === 'music' ? '已触发音乐抓取' : '已触发收藏同步');
      watchJob(job.id);
    } catch (error) {
      showToast(error.message, true);
    }
  }

  async function repairTheatre() {
    if (!confirm('修复 Theatre 中缺少海报或详情的影视？')) return;
    try {
      const job = await api('/api/theatre/repair', { method: 'POST', body: '{}' });
      showToast('已开始修复影视信息');
      watchJob(job.id);
    } catch (error) {
      showToast(error.message, true);
    }
  }

  async function watchJob(id) {
    clearInterval(admin.jobTimer);
    admin.jobTimer = setInterval(async () => {
      try {
        const job = await api(`/api/jobs/${id}`);
        if (job.status === 'running') return;
        clearInterval(admin.jobTimer);
        if (job.status === 'completed') {
          showToast('任务完成，页面即将刷新');
          setTimeout(() => location.reload(), 1000);
        } else showToast(job.message || '任务失败', true);
      } catch (error) {
        clearInterval(admin.jobTimer);
        showToast(error.message, true);
      }
    }, 2500);
  }

  async function shutdown() {
    if (!confirm('关闭本机管理进程？关闭后需要重新双击启动脚本。')) return;
    try {
      await api('/api/shutdown', { method: 'POST', body: '{}' });
      showToast('管理服务已关闭');
      document.querySelectorAll('.admin-only').forEach((element) => { element.hidden = true; });
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function bind() {
    $('#libraryAdminAdd')?.addEventListener('click', () => openSearchDialog('library'));
    $('#theatreAdminAdd')?.addEventListener('click', () => openSearchDialog('theatre'));
    $('#theatreAdminRepair')?.addEventListener('click', repairTheatre);
    $('#theatreEdit')?.addEventListener('click', openTheatreEditDialog);
    $('#musicAdminRefresh')?.addEventListener('click', () => startWorkflow('music'));
    $('#adminFavoritesSync')?.addEventListener('click', openSyncModeDialog);
    $('#adminShutdown')?.addEventListener('click', shutdown);
    $('#adminDialogCancel')?.addEventListener('click', () => $('#adminDialog').close());
    $('#adminDialogSubmit')?.addEventListener('click', addSelected);
    $('#adminDialog')?.addEventListener('click', (event) => {
      if (event.target === $('#adminDialog')) $('#adminDialog').close();
    });
  }

  async function init() {
    bind();
    try {
      const status = await api('/api/status');
      if (!status.admin) return;
      setAdminVisible(true);
      setTimeout(refreshPublicMeta, 1000);
    } catch {
      setAdminVisible(false);
    }
  }

  window.addEventListener('DOMContentLoaded', init);
}());

/* 本机管理模式：公开 GitHub Pages 不提供 /api/status，因此所有控件默认隐藏。 */
(function () {
  'use strict';

  const admin = {
    enabled: false,
    authenticated: false,
    csrf: '',
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
    document.querySelectorAll('.admin-only').forEach((element) => {
      element.hidden = !visible;
    });
  }

  function setAuthenticated(authenticated) {
    admin.authenticated = authenticated;
    document.querySelectorAll('.admin-write-only').forEach((element) => {
      element.hidden = !authenticated;
    });
    const unlock = $('#adminAuthButton');
    if (unlock) unlock.hidden = authenticated;
    const badge = $('#adminStatus');
    if (badge) badge.textContent = authenticated ? '本机管理 · 已解锁' : '本机管理 · 未解锁';
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (options.method && options.method !== 'GET') headers['X-WS-CSRF'] = admin.csrf;
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
        ${item.cover ? `<img src="${escapeHtml(item.cover)}" alt="" loading="lazy">` : '<span class="admin-candidate-cover">无图</span>'}
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
    $('#adminSearchInput').focus();
  }

  function openAuthDialog(mode) {
    admin.mode = mode;
    admin.selected = null;
    const register = mode === 'auth-register';
    $('#adminDialogTitle').textContent = register ? '注册本机 Passkey' : '解锁本机管理';
    $('#adminDialogBody').innerHTML = `<p class="modal-desc">${register
      ? '首次使用请通过 Windows Hello、指纹、PIN 或安全密钥注册。凭据只保存在本机管理服务中。'
      : '请使用已经注册的 Windows Hello、指纹、PIN 或安全密钥确认是你本人。'}</p>`;
    $('#adminDialogSubmit').textContent = register ? '注册 Passkey' : '使用 Passkey 解锁';
    $('#adminDialogSubmit').disabled = false;
    $('#adminDialog').showModal();
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

  function base64urlToBytes(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
    const binary = atob(normalized);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function bytesToBase64url(value) {
    const bytes = new Uint8Array(value);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function registrationOptions(options) {
    return {
      ...options,
      challenge: base64urlToBytes(options.challenge),
      user: { ...options.user, id: base64urlToBytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: base64urlToBytes(item.id) })),
    };
  }

  function authenticationOptions(options) {
    return {
      ...options,
      challenge: base64urlToBytes(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id: base64urlToBytes(item.id) })),
    };
  }

  function credentialResponse(credential, registration) {
    const response = credential.response;
    const result = {
      id: credential.id,
      rawId: bytesToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bytesToBase64url(response.clientDataJSON),
      },
    };
    if (registration) {
      result.response.attestationObject = bytesToBase64url(response.attestationObject);
      if (response.getTransports) result.response.transports = response.getTransports();
    } else {
      result.response.authenticatorData = bytesToBase64url(response.authenticatorData);
      result.response.signature = bytesToBase64url(response.signature);
      result.response.userHandle = response.userHandle ? bytesToBase64url(response.userHandle) : null;
    }
    return result;
  }

  async function authenticate() {
    if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('当前浏览器不支持 Windows Hello/Passkey');
    const register = admin.mode === 'auth-register';
    const options = await api(register ? '/api/auth/register/options' : '/api/auth/login/options');
    const credential = register
      ? await navigator.credentials.create({ publicKey: registrationOptions(options) })
      : await navigator.credentials.get({ publicKey: authenticationOptions(options) });
    if (!credential) throw new Error('未完成 Passkey 操作');
    const result = await api(register ? '/api/auth/register/verify' : '/api/auth/login/verify', {
      method: 'POST', body: JSON.stringify(credentialResponse(credential, register)),
    });
    admin.csrf = result.csrf || '';
    setAuthenticated(true);
    $('#adminDialog').close();
    showToast(register ? 'Passkey 注册完成，管理页面已解锁' : '管理页面已解锁');
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
      button.textContent = '选择结果后添加';
    } catch (error) {
      showToast(error.message, true);
      button.textContent = '搜索';
    } finally {
      button.disabled = false;
    }
  }

  async function addSelected() {
    if (admin.mode === 'auth-register' || admin.mode === 'auth-login') {
      const button = $('#adminDialogSubmit');
      button.disabled = true;
      button.textContent = '等待验证…';
      try { await authenticate(); }
      catch (error) {
        if (admin.mode === 'auth-login' && error.message === '尚未注册 Passkey') {
          openAuthDialog('auth-register');
          showToast('当前管理服务尚未注册 Passkey，请先注册本机凭据', true);
          return;
        }
        showToast(error.message, true);
        button.disabled = false;
        button.textContent = admin.mode === 'auth-register' ? '注册 Passkey' : '使用 Passkey 解锁';
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
    $('#musicAdminRefresh')?.addEventListener('click', () => startWorkflow('music'));
    $('#adminFavoritesSync')?.addEventListener('click', openSyncModeDialog);
    $('#adminMusicSync')?.addEventListener('click', () => startWorkflow('music'));
    $('#adminShutdown')?.addEventListener('click', shutdown);
    $('#adminAuthButton')?.addEventListener('click', () => openAuthDialog('auth-login'));
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
      admin.csrf = status.csrf;
      setAuthenticated(Boolean(status.authenticated));
      setTimeout(refreshPublicMeta, 1000);
      if (status.setupRequired) {
        openAuthDialog('auth-register');
      }
    } catch {
      setAdminVisible(false);
    }
  }

  window.addEventListener('DOMContentLoaded', init);
}());

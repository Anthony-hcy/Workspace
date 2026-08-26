/**
 * ============================================================================
 * app.js — Workspace 收藏夹前端逻辑（原生 JS，无任何依赖）
 * ----------------------------------------------------------------------------
 * 数据来源：仓库内 data/*.json（由 Favorites 私有仓库的 Actions 定时同步）
 *
 * 功能清单：
 *   1. 并行加载 点赞 / 收藏 / 元信息 三份数据
 *   2. 来源 Tab（全部/点赞/收藏）× 类型筛选（视频/图文）× 关键词搜索
 *   3. 大数据量优化：IntersectionObserver 无限滚动分批渲染（每批 60 张）
 *   4. 封面热链直连抖音 CDN（referrerpolicy=no-referrer 绕过防盗链），
 *      加载失败自动回退为按 id 生成的渐变占位图
 *   5. 「立即同步」按钮 → 调 GitHub API 触发私有仓库的 Actions 工作流，
 *      Token 只存本机 localStorage，不进代码仓库
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * 配置区（换账号/改仓库名只动这里）
 * ------------------------------------------------------------------------- */
const CONFIG = {
  GITHUB_OWNER: 'Anthony-hcy',        // GitHub 用户名
  PRIVATE_REPO: 'Favorites',          // 私有仓库（抓取端，workflow 所在地）
  WORKFLOW_FILE: 'sync.yml',          // 要触发的工作流文件名
  BRANCH: 'main',                     // 工作流所在分支
  BATCH_SIZE: 60,                     // 每批渲染的卡片数量
};

const API_BASE = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.PRIVATE_REPO}`;
const PAT_KEY = 'ws_github_pat';      // localStorage 键名

/* ---------------------------------------------------------------------------
 * 全局状态
 * ------------------------------------------------------------------------- */
const state = {
  all: [],            // 合并后的全量数据 [{...item, sources:['like'|'collect']}]
  filtered: [],       // 当前筛选条件下的数据
  rendered: 0,        // 已渲染的卡片数（用于分批追加）
  source: 'all',      // 当前 Tab：all | like | collect
  type: 'all',        // 当前类型：all | video | image
  keyword: '',        // 搜索关键词
  syncing: false,     // 是否正在云端同步
};

/* 封面占位渐变色板（仿 Collecta 的多彩柔和风） */
const GRADIENTS = [
  ['#8ea5ff', '#c9a7ff'],
  ['#ff9db8', '#ffa48b'],
  ['#7fd8c8', '#7fb6ff'],
  ['#ffd08a', '#ff9d76'],
  ['#a7d8a0', '#79b8d8'],
  ['#f0a6ca', '#b39ddb'],
];

/* DOM 引用 */
const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const sentinel = $('#sentinel');
const emptyBox = $('#emptyBox');
const countLine = $('#countLine');

/* ---------------------------------------------------------------------------
 * 一、数据加载
 * ------------------------------------------------------------------------- */
async function loadData() {
  // Promise.allSettled：任何一个 JSON 缺失都不影响其他数据展示
  const [metaRes, likeRes, collectRes] = await Promise.allSettled([
    fetch('data/meta.json').then((r) => r.json()),
    fetch('data/douyin-like.json').then((r) => r.json()),
    fetch('data/douyin-collect.json').then((r) => r.json()),
  ]);

  // meta：顶栏显示"最近同步时间"
  if (metaRes.status === 'fulfilled' && metaRes.value?.lastSync) {
    const d = new Date(metaRes.value.lastSync);
    $('#syncTime').textContent = `最近同步：${d.toLocaleString('zh-CN', { hour12: false })}`;
  }

  // 给每个列表的数据打上来源标记，便于筛选和徽章显示
  const like = likeRes.status === 'fulfilled' && Array.isArray(likeRes.value) ? likeRes.value : [];
  const collect = collectRes.status === 'fulfilled' && Array.isArray(collectRes.value) ? collectRes.value : [];

  /** 按 id 合并：同一条作品既点赞又收藏时，合并来源而不是重复展示两张卡 */
  const map = new Map();
  const push = (item, src) => {
    if (!item?.id) return;
    if (map.has(item.id)) {
      map.get(item.id).sources.push(src);          // 已存在 → 追加来源
    } else {
      map.set(item.id, { ...item, sources: [src] }); // 新条目
    }
  };
  like.forEach((i) => push(i, 'like'));
  collect.forEach((i) => push(i, 'collect'));

  state.all = [...map.values()];
}

/* ---------------------------------------------------------------------------
 * 二、筛选
 * ------------------------------------------------------------------------- */
function applyFilter() {
  const kw = state.keyword.trim().toLowerCase();
  state.filtered = state.all.filter((it) => {
    // Tab：当前视图是否包含该来源
    if (state.source !== 'all' && !it.sources.includes(state.source)) return false;
    // 类型筛选
    if (state.type !== 'all' && it.type !== state.type) return false;
    // 关键词匹配标题或作者
    if (kw && !(it.title || '').toLowerCase().includes(kw) && !(it.author || '').toLowerCase().includes(kw)) return false;
    return true;
  });
  resetRender();
}

/* ---------------------------------------------------------------------------
 * 三、分批渲染（2000+ 条不卡的秘诀：先画一屏，滚到底再补下一批）
 * ------------------------------------------------------------------------- */
const observer = new IntersectionObserver((entries) => {
  // 哨兵元素进入视口 → 追加下一批
  if (entries[0].isIntersecting) renderBatch();
}, { rootMargin: '800px 0px' });   // 提前 800px 预加载，滚动体验更顺

function resetRender() {
  grid.innerHTML = '';
  state.rendered = 0;
  updateCountLine();
  renderBatch();
}

function renderBatch() {
  const batch = state.filtered.slice(state.rendered, state.rendered + CONFIG.BATCH_SIZE);
  const frag = document.createDocumentFragment();
  for (const item of batch) frag.appendChild(buildCard(item));
  grid.appendChild(frag);
  state.rendered += batch.length;

  // 空状态提示
  emptyBox.hidden = state.filtered.length !== 0;
  if (state.filtered.length === 0) {
    emptyBox.innerHTML = '<strong>◌</strong>没有匹配的作品<br><span style="font-size:12px">试试切换筛选条件，或先点右上角「立即同步」拉取数据</span>';
  }
}

/** 更新顶部统计行："共 N 条 · 视频 x · 图文 y" */
function updateCountLine() {
  const v = state.filtered.filter((i) => i.type === 'video').length;
  const m = state.filtered.length - v;
  countLine.textContent = state.filtered.length
    ? `共 ${state.filtered.length} 条 · 视频 ${v} · 图文 ${m}`
    : '';
}

/* ---------------------------------------------------------------------------
 * 四、卡片构建
 * ------------------------------------------------------------------------- */
function buildCard(item) {
  // 整张卡片是一个 <a>：点击新标签页打开原作品
  const a = document.createElement('a');
  a.className = 'card';
  a.href = item.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  /* -- 封面区 ---------------------------------------------------------- */
  const cover = document.createElement('div');
  cover.className = 'card-cover';

  // 用 id 的哈希从色板里选一组渐变作为占位背景（同一作品永远同色，稳定美观）
  const [c1, c2] = GRADIENTS[hashId(item.id) % GRADIENTS.length];
  cover.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;

  // 中央类型图标：视频=播放三角；图文=相册
  cover.insertAdjacentHTML('beforeend', `
    <span class="cover-icon">${item.type === 'video'
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .96 1.05 1.55 1.87 1.05l10.7-6.86a1.25 1.25 0 0 0 0-2.1L9.87 4.09C9.05 3.59 8 4.18 8 5.14z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2"/><path d="m21 15-4.35-4.35a1 1 0 0 0-1.42 0L7 19"/></svg>'}
    </span>`);

  // 封面图：no-referrer 是绕过抖音 CDN 防盗链的关键
  if (item.cover) {
    const img = document.createElement('img');
    img.loading = 'lazy';                       // 浏览器级懒加载
    img.referrerPolicy = 'no-referrer';
    img.alt = item.title || '封面';
    img.onload = () => img.classList.add('is-loaded');  // 加载成功淡入覆盖渐变
    img.onerror = () => img.remove();           // 失败则保留渐变占位
    img.src = item.cover;
    cover.appendChild(img);
  }

  // 左下角标签：平台 + 类型（类型分色，见 style.css）
  cover.insertAdjacentHTML('beforeend', `
    <div class="card-tags">
      <span class="tag tag-platform">抖音</span>
      <span class="tag tag-type ${item.type === 'video' ? 'is-video' : 'is-image'}">${item.type === 'video' ? '视频' : '图文'}</span>
    </div>`);

  /* -- 文字区 ---------------------------------------------------------- */
  const body = document.createElement('div');
  body.className = 'card-body';
  const srcBadge = item.sources.includes('collect') && state.source === 'all'
    ? `<span class="src-badge">收藏</span>`
    : item.sources.includes('like') && state.source === 'all'
      ? `<span class="src-badge">赞</span>` : '';
  body.innerHTML = `
    <p class="card-title">${escapeHtml(item.title || '无标题')}</p>
    <div class="card-meta">
      <span class="author">@${escapeHtml(item.author || '未知作者')}</span>
      <span class="dot">·</span>
      <span>${formatCount(item.stats?.digg)} 赞</span>
      ${srcBadge}
    </div>`;

  a.append(cover, body);
  return a;
}

/* ---------- 小工具函数 ---------- */

/** 字符串哈希（简单稳定即可，用于选渐变色） */
function hashId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 数字格式化：12345 → "1.2万" */
function formatCount(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

/** 防 XSS：所有用户内容入库前转义 */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ---------------------------------------------------------------------------
 * 五、「立即同步」按钮 → GitHub Actions workflow_dispatch
 * ------------------------------------------------------------------------- */
const btnSync = $('#btnSync');
const btnSyncText = $('#btnSyncText');

btnSync.addEventListener('click', () => {
  const pat = localStorage.getItem(PAT_KEY);
  if (!pat) {
    openPatModal();       // 第一次使用：先要 Token
  } else {
    triggerSync(pat);
  }
});

async function triggerSync(pat) {
  if (state.syncing) return;
  state.syncing = true;
  btnSync.disabled = true;
  btnSync.classList.add('is-busy');
  btnSyncText.textContent = '同步中…';
  showToast('已触发云端同步，通常需要 1~2 分钟');

  try {
    // 1. 触发工作流（dispatches 接口成功时返回 204 无内容）
    const res = await fetch(`${API_BASE}/actions/workflows/${CONFIG.WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({ ref: CONFIG.BRANCH }),
    });
    if (res.status === 401) throw new Error('Token 无效或已过期，请重新配置');
    if (res.status === 403) throw new Error('Token 权限不足，需要 Actions: Read and write');
    if (!res.ok) throw new Error(`触发失败（HTTP ${res.status}）`);

    // 2. 轮询最新一次运行的状态，直到完成（最长等 5 分钟）
    await pollRun(pat, Date.now());
    showToast('同步完成！即将刷新页面…');
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    showToast(err.message, true);
    resetSyncBtn();
  }
}

/** 每 10 秒查询一次 Actions 运行状态 */
async function pollRun(pat, startTime) {
  const deadline = startTime + 5 * 60 * 1000; // 最长等待 5 分钟
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    const res = await fetch(`${API_BASE}/actions/runs?per_page=3`, {
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) continue; // 网络抖动就下一轮再说
    const { workflow_runs } = await res.json();
    // 找到本次触发之后创建的运行记录
    const run = workflow_runs.find((r) => new Date(r.created_at).getTime() >= startTime - 5000);
    if (run && run.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error('同步运行失败，常见原因：Cookie 过期，请更新 Secrets');
      return;
    }
    btnSyncText.textContent = '同步中…';   // 保持忙碌态
  }
  throw new Error('等待超时，可稍后刷新页面查看结果');
}

function resetSyncBtn() {
  state.syncing = false;
  btnSync.disabled = false;
  btnSync.classList.remove('is-busy');
  btnSyncText.textContent = '立即同步';
}

/* ---------- PAT 弹窗 ---------- */
const patModal = $('#patModal');

function openPatModal() {
  patModal.showModal();
  $('#patInput').focus();
}

$('#patCancel').addEventListener('click', () => patModal.close());

$('#patSave').addEventListener('click', () => {
  const pat = $('#patInput').value.trim();
  if (!pat) return showToast('请输入 Token', true);
  localStorage.setItem(PAT_KEY, pat);
  patModal.close();
  triggerSync(pat);   // 存完直接开始第一次同步
});

/* ---------------------------------------------------------------------------
 * 六、Toast 提示
 * ------------------------------------------------------------------------- */
let toastTimer;
function showToast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('is-error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 4000 : 2500);
}

/* ---------------------------------------------------------------------------
 * 七、事件绑定 & 启动
 * ------------------------------------------------------------------------- */
// Tab 切换（事件委托：监听父容器，避免给每个按钮单独绑）
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('#tabs .tab').forEach((t) => t.classList.toggle('is-active', t === btn));
  state.source = btn.dataset.source;
  applyFilter();
});

// 类型 chip 切换
$('#typeChips').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('#typeChips .chip').forEach((c) => c.classList.toggle('is-active', c === btn));
  state.type = btn.dataset.type;
  applyFilter();
});

// 搜索框：300ms 防抖，避免每敲一个字就全量过滤
let searchTimer;
$('#searchBox').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.keyword = e.target.value;
    applyFilter();
  }, 300);
});

// 启动无限滚动观察
observer.observe(sentinel);

// 入口：加载数据 → 应用默认筛选
(async function init() {
  try {
    await loadData();
  } catch (err) {
    console.error(err);
  }
  applyFilter();

  // 数据为空时给出首次部署引导
  if (state.all.length === 0) {
    emptyBox.innerHTML =
      '<strong>◌</strong>还没有数据<br><span style="font-size:12px">' +
      '首次部署请参考 README 配置 Cookie 与 Secrets，然后点击右上角「立即同步」</span>';
    emptyBox.hidden = false;
  }
})();

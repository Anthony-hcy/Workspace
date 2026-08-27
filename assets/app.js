/**
 * ============================================================================
 * app.js — Workspace 收藏夹前端逻辑（原生 JS，无任何依赖）
 * ----------------------------------------------------------------------------
 * 数据来源：仓库内 data/*.json（由 Favorites 私有仓库的 Actions 定时同步）
 *
 * 功能清单：
 *   1. 并行加载 点赞 / 收藏 / 元信息 三份数据
 *   2. 来源 Tab（全部/点赞/收藏）× 类型筛选（视频/图文）× 关键词搜索
 *   3. 排序：默认 / 最近更新 / 最早发布 / 点赞最多
 *   4. 总览视图 = 行填充布局（Justified Rows）：每行铺满宽度、约一屏高
 *      即自动分页（每页条数动态）；抖音/B站单平台视图仍为固定每页 24 张
 *   5. 封面热链直连抖音 CDN（referrerpolicy=no-referrer 绕过防盗链），
 *      加载失败自动回退为按 id 生成的渐变占位图
 *   6. 「立即同步」按钮 → 调 GitHub API 触发私有仓库的 Actions 工作流，
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
  PAGE_SIZE: 24,                      // 每页显示的卡片数量
};

const API_BASE = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.PRIVATE_REPO}`;
const PAT_KEY = 'ws_github_pat';      // localStorage 键名

/* ---------------------------------------------------------------------------
 * 全局状态
 * ------------------------------------------------------------------------- */
const state = {
  all: [],            // 合并后的全量数据 [{...item, sources:['like'|'collect'], folderId?}]
  folders: [],        // B站收藏夹列表 [{id, title, count}]
  filtered: [],       // 当前筛选条件下的数据
  page: 1,            // 当前页码（从 1 开始）
  view: 'all',        // 侧边栏视图：all | bilibili | douyin | xhs
  sub: 'all',         // 二级筛选：all | like | collect（抖音）或 收藏夹id（B站）
  type: 'all',        // 当前类型：all | video | image
  keyword: '',        // 搜索关键词
  sort: 'default',    // 排序：default(最近更新) | oldest(最早更新) | likes(点赞最多)
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
const emptyBox = $('#emptyBox');
const countLine = $('#countLine');

/* ---------------------------------------------------------------------------
 * 一、数据加载
 * ------------------------------------------------------------------------- */
async function loadData() {
  // Promise.allSettled：任何一个 JSON 缺失都不影响其他数据展示
  // ⚠️ 加时间戳参数绕过浏览器/CDN 缓存（Pages 对静态资源缓存 10 分钟，
  //    否则同步完成后打开页面可能仍看到旧数据）
  const bust = `t=${Date.now()}`;
  const [metaRes, likeRes, collectRes, biliRes, foldersRes] = await Promise.allSettled([
    fetch(`data/meta.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
    fetch(`data/douyin-like.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
    fetch(`data/douyin-collect.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
    fetch(`data/bilibili-collect.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
    fetch(`data/bilibili-folders.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
  ]);

  // meta：顶栏显示"最近同步时间 + 本次模式"
  if (metaRes.status === 'fulfilled' && metaRes.value?.lastSync) {
    const d = new Date(metaRes.value.lastSync);
    const mode = metaRes.value.mode === 'full' ? '全量' : '增量';
    $('#syncTime').textContent = `最近同步：${d.toLocaleString('zh-CN', { hour12: false })} · ${mode}`;
  }

  // 给每个列表的数据打上来源标记，便于筛选和徽章显示
  const like = likeRes.status === 'fulfilled' && Array.isArray(likeRes.value) ? likeRes.value : [];
  const collect = collectRes.status === 'fulfilled' && Array.isArray(collectRes.value) ? collectRes.value : [];
  const bili = biliRes.status === 'fulfilled' && Array.isArray(biliRes.value) ? biliRes.value : [];
  state.folders = foldersRes.status === 'fulfilled' && Array.isArray(foldersRes.value) ? foldersRes.value : [];

  /** 按 id 合并：同一条抖音作品既点赞又收藏时，合并来源而不是重复展示 */
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
  // B站条目已自带 folderId，直接并入（id 命名空间与抖音天然不冲突）
  bili.forEach((i) => { if (i?.id) map.set(i.id, { ...i, sources: ['collect'] }); });

  state.all = [...map.values()];
}

/* ---------------------------------------------------------------------------
 * 二、筛选
 * ------------------------------------------------------------------------- */
function applyFilter() {
  const kw = state.keyword.trim().toLowerCase();
  state.filtered = state.all.filter((it) => {
    // 侧边栏视图：平台级过滤
    if (state.view === 'douyin' && it.platform !== 'douyin') return false;
    if (state.view === 'bilibili' && it.platform !== 'bilibili') return false;
    if (state.view === 'xhs') return false; // 小红书暂未接入
    // 二级筛选：抖音的点赞/收藏，或 B站的收藏夹
    if (state.view === 'douyin' && state.sub !== 'all' && !it.sources.includes(state.sub)) return false;
    if (state.view === 'bilibili' && state.sub !== 'all' && it.folderId !== state.sub) return false;
    // 类型筛选
    if (state.type !== 'all' && it.type !== state.type) return false;
    // 关键词匹配标题或作者
    if (kw && !(it.title || '').toLowerCase().includes(kw) && !(it.author || '').toLowerCase().includes(kw)) return false;
    return true;
  });

  // 排序（default = 最近更新时间倒序）
  if (state.sort !== 'default') {
    const by = {
      oldest: (a, b) => (a.createdAt || 0) - (b.createdAt || 0), // 发布时间 正序
      likes:  (a, b) => (b.stats?.digg || 0) - (a.stats?.digg || 0), // 点赞量 倒序
    }[state.sort];
    state.filtered.sort(by);
  } else {
    state.filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // 默认：发布时间 倒序
  }

  resetRender();
}

/* ---------------------------------------------------------------------------
 * 三、分页渲染（总览=行填充动态分页；抖音/B站视图=固定每页 24 张）
 * ------------------------------------------------------------------------- */
const totalPages = () => state.view === 'all'
  ? Math.max(1, rowLayout.pages.length)
  : Math.max(1, Math.ceil(state.filtered.length / CONFIG.PAGE_SIZE));

function resetRender() {
  state.page = 1;      // 条件变化后回到第一页
  if (state.view === 'all') rebuildRowLayout();   // 过滤结果变化 → 重算行与页边界
  renderPage();
}

function renderPage() {
  if (state.view === 'all') {
    // 行填充模式：页边界已预计算，任意跳页都是 O(1) 切片
    const pg = rowLayout.pages[state.page - 1];
    const slice = pg ? state.filtered.slice(pg.start, pg.end) : [];
    grid.innerHTML = '';
    renderRows(slice);
  } else {
    const start = (state.page - 1) * CONFIG.PAGE_SIZE;
    const slice = state.filtered.slice(start, start + CONFIG.PAGE_SIZE);
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const item of slice) frag.appendChild(buildCard(item));
    grid.appendChild(frag);
  }

  updatePager();
  updateCountLine();
  emptyBox.hidden = state.filtered.length !== 0;
  if (state.filtered.length === 0) {
    emptyBox.innerHTML = '<strong>◌</strong>没有匹配的作品<br><span style="font-size:12px">试试切换筛选条件，或先点右上角「立即同步」拉取数据</span>';
  }
}

/** 翻到指定页（自动夹取到合法范围），并滚回工具栏顶部 */
function goToPage(p) {
  state.page = Math.min(Math.max(1, Math.round(p) || 1), totalPages());
  renderPage();
  // 瞬时滚到工具栏（含 Tab/筛选/排序），scroll-margin-top 补偿 sticky 顶栏高度；
  // 不用 smooth：翻页后图片加载会改变页面高度，平滑滚动容易停错位置
  document.querySelector('.toolbar').scrollIntoView({ behavior: 'auto', block: 'start' });
}

/** 刷新分页控件的显示状态 */
function updatePager() {
  const total = totalPages();
  $('#pagination').hidden = state.filtered.length === 0;
  $('#pageTotal').textContent = total;
  const input = $('#pageInput');
  input.value = state.page;
  input.max = total;
  $('#prevPage').disabled = state.page <= 1;
  $('#nextPage').disabled = state.page >= total;
}

/** 更新顶部统计行："共 N 条 · 视频 x · 图文 y" */
function updateCountLine() {
  const v = state.filtered.filter((i) => i.type === 'video').length;
  const m = state.filtered.length - v;
  countLine.textContent = state.filtered.length
    ? `共 ${state.filtered.length} 条 · 视频 ${v} · 图文 ${m} · 第 ${state.page}/${totalPages()} 页`
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

  // 左下角标签：平台（按平台配色）+ 类型（类型分色，见 style.css）
  const isBili = item.platform === 'bilibili';
  if (isBili) a.classList.add('card--wide'); // B站视频为横屏封面
  cover.insertAdjacentHTML('beforeend', `
    <div class="card-tags">
      <span class="tag ${isBili ? 'tag-bilibili' : 'tag-platform'}">${isBili ? '哔哩' : '抖音'}</span>
      <span class="tag tag-type ${item.type === 'video' ? 'is-video' : 'is-image'}">${item.type === 'video' ? '视频' : '图文'}</span>
    </div>`);

  /* -- 文字区 ---------------------------------------------------------- */
  const body = document.createElement('div');
  body.className = 'card-body';
  // 抖音显示点赞数；B站显示播放量。总览视图下抖音卡带来源徽章（赞/收藏）
  const statText = isBili
    ? `${formatCount(item.stats?.digg)} 播放`
    : `${formatCount(item.stats?.digg)} 赞`;
  const srcBadge = !isBili && state.view === 'all'
    ? item.sources.includes('collect') ? '<span class="src-badge">收藏</span>'
      : '<span class="src-badge">赞</span>' : '';
  body.innerHTML = `
    <p class="card-title">${escapeHtml(item.title || '无标题')}</p>
    <div class="card-meta">
      <span class="author">@${escapeHtml(item.author || '未知作者')}</span>
      <span class="dot">·</span>
      <span>${statText}</span>
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
 * 行填充布局（Justified Rows，类似 Google Photos）
 * ---------------------------------------------------------------------------
 * 规则：按现有顺序逐卡累加封面宽高比，凑成一行后整行统一封面高度——
 *   封面高 = 可用宽度 ÷ 该行宽高比之和，每张卡按自己的比例分宽度。
 * 每一行都精确铺满容器（无空缺），横卡（B站 16:9）同行内天然更宽大；
 * 累计约一屏高就切为一页，因此每页条数是动态的，页面永远饱满。
 * ------------------------------------------------------------------------- */

const ROW_LAYOUT = {
  BODY_H: 66,      // 卡片文字区高度（单行省略标题 + meta 行 + 内边距），用于估算页高
  TARGET_COVER_H: 235,   // 目标封面高：桌面端一行 5~6 张竖卡 / 2~3 张混排
  NARROW_COVER_H: 185,   // 窄屏目标封面高
  MAX_STRETCH: 1.25,     // 页尾行最多拉伸 25% 填满宽度，超过则保持自然宽靠左
};

/** 封面宽高比：抖音竖屏 2:3；B站横屏 16:9（与 CSS 中 .card-cover 的 aspect-ratio 对应） */
function coverRatioOf(item) {
  return item.platform === 'bilibili' ? 16 / 9 : 2 / 3;
}

/** 行间距（与 style.css 中 .grid.rows 的 gap 保持一致） */
function rowGapPx() {
  return window.matchMedia('(max-width: 640px)').matches ? 12 : 16;
}

/** 当前视口下的目标封面高 */
function targetCoverH() {
  return window.innerWidth <= 640 ? ROW_LAYOUT.NARROW_COVER_H : ROW_LAYOUT.TARGET_COVER_H;
}

/**
 * 把 items 从 start 下标开始贪心分成若干"视觉行"。
 * 返回 [{first, last, covH}]：行的起止下标与统一封面高。
 */
function splitRows(items, start = 0) {
  const gap = rowGapPx();
  const width = grid.clientWidth;
  const tgt = targetCoverH();
  const rows = [];
  let buf = [];        // 当前行内已累积的下标
  let bufRatio = 0;    // 当前行宽高比之和
  let cur = start;     // 下一个待放置的下标

  while (cur < items.length) {
    buf.push(cur);
    bufRatio += coverRatioOf(items[cur]);
    cur++;
    const covH = (width - gap * (buf.length - 1)) / bufRatio;
    // 高度首次压到目标及以下即结算：此后 covH 只会更小，必须在当下决策。
    // 若「不含这张」的前一个断点更接近目标，就把这张退回（cur--），
    // 它会自然成为下一行的第一张，绝不能凭空丢弃
    if (covH <= tgt) {
      const tail = cur - 1;
      const prevCovH = buf.length > 1
        ? (width - gap * (buf.length - 2)) / (bufRatio - coverRatioOf(items[tail]))
        : Infinity;   // 行内首张没有更短的备选断点
      if (Math.abs(prevCovH - tgt) < Math.abs(covH - tgt)) {
        cur--;
        buf.pop();
        bufRatio -= coverRatioOf(items[cur]);
        rows.push({ first: buf[0], last: buf[buf.length - 1], covH: prevCovH });
      } else {
        rows.push({ first: buf[0], last: buf[buf.length - 1], covH });
      }
      buf = [];
      bufRatio = 0;
    }
  }

  // 收不了尾的零头
  if (buf.length === 1 && rows.length > 0) {
    // 只剩孤张且不成行 → 并回上一行重新均分（避免一行一张拉出超高卡片）
    const prev = rows[rows.length - 1];
    const merged = [];
    for (let i = prev.first; i <= prev.last; i++) merged.push(i);
    merged.push(cur - 1);
    merged.sort((a, b) => a - b);
    prev.last = merged[merged.length - 1];
    const rSum = merged.reduce((s, i) => s + coverRatioOf(items[i]), 0);
    prev.covH = (width - gap * (merged.length - 1)) / rSum;
  } else if (buf.length > 0) {
    // ≥2 张残余直接作为最后一行（渲染端会做页尾拉伸/靠左处理）
    rows.push({ first: buf[0], last: buf[buf.length - 1], covH: (width - gap * (buf.length - 1)) / bufRatio });
  }
  return rows;
}

/**
 * 预计算所有分页边界：按行累积高度达到约一屏即切页。
 * 返回 { pages: [{start, end}] }，start/end 为 state.filtered 中的切片下标。
 * 跳转任意页无需重放前面各页（O(1) 定位），窗口 resize 时整体重算也只需 O(N)。
 */
function computeRowPages(items) {
  const rows = splitRows(items);
  const pageTarget = Math.max(window.innerHeight * 1.15, 900);
  const gapStep = ROW_LAYOUT.BODY_H + rowGapPx();
  const pages = [];
  let acc = 0;
  let startRow = 0;

  for (let i = 0; i < rows.length; i++) {
    acc += rows[i].covH + gapStep;
    // 至少满两行才允许切页，防止极端数据下出现"一行一页"
    if (acc >= pageTarget && i - startRow >= 1) {
      pages.push({ start: rows[startRow].first, end: rows[i].last + 1 });
      startRow = i + 1;
      acc = 0;
    }
  }
  if (startRow < rows.length) {
    pages.push({ start: rows[startRow].first, end: rows[rows.length - 1].last + 1 });
  }
  return { pages };
}

/** 当前总览视图的布局缓存：{pages:[{start,end}]} */
let rowLayout = { pages: [] };

/** filtered 变化或窗口尺寸变化后重建分页边界 */
function rebuildRowLayout() {
  rowLayout = computeRowPages(state.filtered);
}

/**
 * 渲染总览视图的一页：局部重现行切分并给每张卡分配精确宽度。
 * 页尾一行若拉伸增幅不超过上限则铺满整行，否则保持自然宽度靠左。
 */
function renderRows(slice) {
  const cards = slice.map((item) => buildCard(item));
  const rows = splitRows(slice);
  const gap = rowGapPx();
  const width = grid.clientWidth;
  const frag = document.createDocumentFragment();

  rows.forEach((row, idx) => {
    const isLastRow = idx === rows.length - 1;
    let covH = Math.min(row.covH, 620);          // 兜底：极端情况下限制行高不失控
    // 行内宽高比之和 → 拉伸到刚满容器宽所需的高度
    let ratioSum = 0;
    for (let i = row.first; i <= row.last; i++) ratioSum += coverRatioOf(slice[i]);
    if (isLastRow) {
      const fullH = (width - gap * (row.last - row.first)) / ratioSum;
      if (fullH / covH <= ROW_LAYOUT.MAX_STRETCH) covH = fullH;   // 增幅可接受 → 拉伸铺满
    }
    for (let i = row.first; i <= row.last; i++) {
      const card = cards[i];
      card.style.width = `${Math.max(covH * coverRatioOf(slice[i]), 100)}px`;
      frag.appendChild(card);
    }
  });

  grid.innerHTML = '';
  grid.appendChild(frag);
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
        'Content-Type': 'application/json',
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
/* ---------------------------------------------------------------------------
 * 七、侧边栏视图 + 二级筛选
 * ------------------------------------------------------------------------- */
const VIEW_TITLES = {
  all: '我的跨平台收藏夹',
  bilibili: 'B站 · 我的收藏',
  douyin: '抖音 · 点赞与收藏',
  xhs: '小红书 · 敬请期待',
};

/** 根据当前视图动态生成二级筛选 chips（抖音：点赞/收藏；B站：各收藏夹） */
function renderSubFilters() {
  const box = $('#subFilters');
  let chips = [];
  if (state.view === 'douyin') {
    chips = [
      { sub: 'all', label: '全部' },
      { sub: 'like', label: '点赞' },
      { sub: 'collect', label: '收藏' },
    ];
  } else if (state.view === 'bilibili' && state.folders.length > 0) {
    chips = [
      { sub: 'all', label: '全部' },
      ...state.folders.map((f) => ({ sub: f.id, label: `${f.title} ${f.count}` })),
    ];
  }
  box.hidden = chips.length === 0;
  box.innerHTML = chips.map((c, i) =>
    `<button class="chip ${i === 0 ? 'is-active' : ''}" data-sub="${c.sub}">${escapeHtml(c.label)}</button>`,
  ).join('');
}

// 侧边栏切换（事件委托）
$('#sideNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.side-item');
  if (!btn) return;
  if (btn.classList.contains('is-disabled')) {
    return showToast('小红书接入筹备中，敬请期待');
  }
  document.querySelectorAll('#sideNav .side-item').forEach((b) => b.classList.toggle('is-active', b === btn));
  state.view = btn.dataset.view;
  state.sub = 'all';                       // 切视图后二级筛选重置
  $('#viewTitle').textContent = VIEW_TITLES[state.view] ?? '';
  // 布局模式随视图切换：
  //   总览 → 行填充布局（每行铺满宽度，横竖卡按原始比例混排）
  //   B站 → 宽列网格（统一 16:9 横屏）
  //   抖音 → 标准网格（统一竖屏）
  const grid = $('#grid');
  grid.classList.toggle('rows', state.view === 'all');
  grid.classList.toggle('wide', state.view === 'bilibili');
  renderSubFilters();
  applyFilter();
});

// 二级筛选点击（事件委托）
$('#subFilters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('#subFilters .chip').forEach((c) => c.classList.toggle('is-active', c === btn));
  state.sub = btn.dataset.sub;
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

// 排序切换
$('#sortSelect').addEventListener('change', (e) => {
  state.sort = e.target.value;
  applyFilter();
});

// 分页：上一页 / 下一页 / 跳转
$('#prevPage').addEventListener('click', () => goToPage(state.page - 1));
$('#nextPage').addEventListener('click', () => goToPage(state.page + 1));
$('#jumpBtn').addEventListener('click', () => goToPage(Number($('#pageInput').value)));
// 输入框里按回车直接跳转
$('#pageInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') goToPage(Number(e.target.value));
});

// 入口：加载数据 → 应用默认筛选
(async function init() {
  try {
    await loadData();
  } catch (err) {
    console.error(err);
  }
  // 默认总览视图 → 行填充布局
  $('#grid').classList.add('rows');
  renderSubFilters();
  applyFilter();

  // 数据为空时给出首次部署引导
  if (state.all.length === 0) {
    emptyBox.innerHTML =
      '<strong>◌</strong>还没有数据<br><span style="font-size:12px">' +
      '首次部署请参考 README 配置 Cookie 与 Secrets，然后点击右上角「立即同步」</span>';
    emptyBox.hidden = false;
  }

  // 窗口 resize 时重算行与分页边界，并尽量停在包含原首条作品的页上
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.view !== 'all') return;
      const firstItemIdx = rowLayout.pages[state.page - 1]?.start ?? 0;
      rebuildRowLayout();
      const hit = rowLayout.pages.findIndex((p) => firstItemIdx >= p.start && firstItemIdx < p.end);
      state.page = Math.max(1, hit + 1);
      renderPage();
    }, 200);
  });
})();

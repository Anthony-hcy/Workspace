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
 *   4. 总览视图 = 拼贴网格（4 行格板，竖卡 1 格 / B站横卡跨 2 格，
 *      每页恰好装满一块板，条数动态）；抖音/B站单平台视图仍为固定每页 24 张
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
  const [metaRes, likeRes, collectRes, biliRes, foldersRes, xhsLikeRes, xhsCollectRes] = await Promise.allSettled([
    fetch(`data/meta.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
    fetch(`data/douyin-like.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
    fetch(`data/douyin-collect.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
    fetch(`data/bilibili-collect.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
    fetch(`data/bilibili-folders.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
    fetch(`data/xhs-like.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
    fetch(`data/xhs-collect.json?${bust}`, { cache: 'no-store' }).then((r) => r.json()),
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
  const xhsLike = xhsLikeRes.status === 'fulfilled' && Array.isArray(xhsLikeRes.value) ? xhsLikeRes.value : [];
  const xhsCollect = xhsCollectRes.status === 'fulfilled' && Array.isArray(xhsCollectRes.value) ? xhsCollectRes.value : [];
  state.folders = foldersRes.status === 'fulfilled' && Array.isArray(foldersRes.value) ? foldersRes.value : [];

  /** 按 id 合并：同一条作品既点赞又收藏时，合并来源而不是重复展示 */
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
  // B站条目已自带 folderId，直接并入（id 命名空间与抖音/小红书天然不冲突）
  bili.forEach((i) => { if (i?.id) map.set(i.id, { ...i, sources: ['collect'] }); });
  // 小红书：与抖音一样按 id 合并点赞/收藏来源
  xhsLike.forEach((i) => push(i, 'like'));
  xhsCollect.forEach((i) => push(i, 'collect'));

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
    if (state.view === 'xhs' && it.platform !== 'xhs') return false;
    // 二级筛选：抖音/小红书的点赞、收藏，或 B站的收藏夹
    if ((state.view === 'douyin' || state.view === 'xhs') && state.sub !== 'all' && !it.sources.includes(state.sub)) return false;
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
 * 移动端深链跳转（平板/手机：优先唤起 B站/抖音 App，叫不醒再回退网页）
 * 浏览器隐私规则不允许网页"探测"App 是否安装，只能尽力拉起 + 失败回退：
 *   - Android Chrome：intent:// 自有协议唤起；未装 App 由系统自动改开备用网页；
 *     故意不锁定 package（B站手机/HD/概念版、抖音各版本的包名不同，
 *     只匹配各自注册的自定义协议即可通吃）；
 *   - iOS：B站的 www.bilibili.com 本身是 Universal Link，直接点击即优先
 *     拉起 App；抖音网页域没有此能力，走 snssdk1128:// scheme +
 *     兜底计时器（约 2.2s 内没切换出去就转网页版）。
 * 设备识别不能只看 UA 关键字：不少安卓平板的 Chrome 默认上报桌面式 UA
 * （"请求桌面版网站"），需叠加 userAgentData 与触控特征兜底。
 * 仅移动端生效；确认无误的桌面一律保持原行为（新标签页打开网页）。
 * ------------------------------------------------------------------------- */
const isIOSDevice = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  navigator.userAgentData?.platform === 'iOS' ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPadOS 的 UA 伪装成 Mac

const isAndroidDevice = () =>
  /Android/.test(navigator.userAgent) ||
  navigator.userAgentData?.platform === 'Android' ||
  // 桌面式 UA 的安卓平板：Linux 标记 + 多点触控（Windows 触屏笔电不带 Linux 标记）
  ((navigator.platform || '').includes('Linux') && navigator.maxTouchPoints > 1);

/** 从 item.url 提取作品 id（抖音数字 id / B站 BV 号）；提不出来返回 null，则退回网页链接 */
function extractVideoId(url) {
  const m = url.match(/(?:douyin\.com\/video\/|bilibili\.com\/video\/)([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * 计算某张卡片"点击后去哪"。
 * 返回 { href, target, needsFallbackTimer } —— needsFallbackTimer 仅 iOS 抖音为 true。
 */
function resolveOpenTarget(item) {
  const webUrl = item.url;
  if (!isIOSDevice() && !isAndroidDevice()) {
    return { href: webUrl, target: '_blank', needsFallbackTimer: false };   // 桌面：维持现状
  }

  const id = extractVideoId(webUrl);
  if (!id) return { href: webUrl, target: '_self', needsFallbackTimer: false };

  if (item.platform === 'bilibili') {
    if (isIOSDevice()) {
      // iOS：Universal Link，普通链接点击即优先进 App（未装则 Safari 正常开网页）
      return { href: webUrl, target: '_self', needsFallbackTimer: false };
    }
    // Android：经 bilibili:// 自有协议唤起客户端（手机版/HD版/概念版都注册了它）；
    // 不锁 package 以兼容任意版本；未装 App 时由 Chrome 打开备用网页
    return {
      href: `intent://video/${id}#Intent;scheme=bilibili;S.browser_fallback_url=${encodeURIComponent(webUrl)};end`,
      target: '_self',
      needsFallbackTimer: false,
    };
  }

  // 抖音
  if (isIOSDevice()) {
    return { href: `snssdk1128://aweme/detail/${id}`, target: '_self', needsFallbackTimer: true };
  }
  return {
    href: `intent://aweme/detail/${id}#Intent;scheme=snssdk1128;S.browser_fallback_url=${encodeURIComponent(webUrl)};end`,
    target: '_self',
    needsFallbackTimer: false,
  };
}

/** iOS 抖音 scheme 的兜底：点开后约 2.2s 内页面从未失焦（多半没装 App），转到网页版 */
function attachIosFallback(cardEl, webUrl) {
  cardEl.addEventListener('click', () => {
    const timer = setTimeout(() => { window.location.href = webUrl; }, 2200);
    document.addEventListener('visibilitychange', function onHide() {
      // 一旦切去了别的 App / 标签页，说明唤起成功（或用户自行处理），撤销兜底
      if (document.hidden) {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onHide);
      }
    });
    window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
  });
}

/* ---------------------------------------------------------------------------
 * 四、卡片构建
 * ------------------------------------------------------------------------- */
function buildCard(item) {
  // 整张卡片是一个 <a>：点击新标签页打开原作品
  const a = document.createElement('a');
  a.className = 'card';
  a.rel = 'noopener noreferrer';

  // 手机/平板上改为优先唤起对应 App（见上方深链说明）
  const openTarget = resolveOpenTarget(item);
  a.href = openTarget.href;
  a.target = openTarget.target;
  if (openTarget.needsFallbackTimer) attachIosFallback(a, item.url);

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
  const isXhs = item.platform === 'xhs';
  if (isBili) a.classList.add('card--wide'); // 仅B站横屏卡占 2 格
  cover.insertAdjacentHTML('beforeend', `
    <div class="card-tags">
      <span class="tag ${isBili ? 'tag-bilibili' : isXhs ? 'tag-xhs' : 'tag-platform'}">${isBili ? '哔哩' : isXhs ? '小红书' : '抖音'}</span>
      <span class="tag tag-type ${item.type === 'video' ? 'is-video' : 'is-image'}">${item.type === 'video' ? '视频' : '图文'}</span>
    </div>`);

  /* -- 文字区 ---------------------------------------------------------- */
  const body = document.createElement('div');
  body.className = 'card-body';
  // B站显示播放量；抖音/小红书显示点赞数。总览视图下抖音与小红书卡带来源徽章（赞/收藏）
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
 * 拼贴网格布局（Mosaic Grid，参考 kiseki.blog/library 的封面墙）
 * ---------------------------------------------------------------------------
 * 规则：固定的 4 行 × N 列格板；
 *   - 抖音竖卡占 1 格，B站横卡跨 2 格（面积约为竖卡两倍）；
 *   - 按顺序放置，横卡留下的单个空位由后面的竖卡回填（dense），板内无空洞；
 *   - 当前卡在整个板上找不到空位 → 本页结束，开新板 → **每页恰好 4 行**，
 *     条数随内容浮动；最后一页装不满 4 行时自然收尾。
 * 封面以 object-fit 裁切适配格子（横版图略裁上下、竖版裁左右），所有格子尺寸
 * 统一锁定，卡片在格内弹性伸缩，文字区不会被压缩。
 * ------------------------------------------------------------------------- */

const MOSAIC = {
  ROWS_PER_PAGE: 4,   // 每页恒定 4 行
  BODY_H: 66,         // 卡片文字区自然高度（单行省略标题 + meta 行 + 内边距）
};

/** B站视频为横屏封面 → 占 2 格 */
function isWideItem(item) {
  return item.platform === 'bilibili';
}

/** 格子间距（与 style.css 中 .grid.mosaic 的 gap 保持一致） */
function rowGapPx() {
  return window.matchMedia('(max-width: 640px)').matches ? 12 : 16;
}

/** 拼贴网格列数（按容器宽度自适应） */
function mosaicCols() {
  const w = grid.clientWidth;
  if (w >= 1150) return 6;
  if (w >= 900) return 5;
  if (w >= 650) return 4;
  if (w >= 430) return 3;
  return 2;
}

/**
 * 在 4×cols 的板上从 start 下标起贪心装箱一批卡片（first-fit + dense 回填）。
 * 返回 { placed:[{idx,row,col,span}], next }：next 为下一个未放置的下标。
 */
function packBoard(items, start, cols) {
  const occ = Array.from({ length: MOSAIC.ROWS_PER_PAGE }, () => new Array(cols).fill(false));
  const fits = (r, c, span) =>
    c + span <= cols && occ[r][c] === false && (span === 1 || occ[r][c + 1] === false);
  const place = (r, c, span) => {
    for (let k = 0; k < span; k++) occ[r][c + k] = true;
  };
  const findSpot = (span) => {
    for (let r = 0; r < MOSAIC.ROWS_PER_PAGE; r++)
      for (let c = 0; c + span <= cols; c++)
        if (fits(r, c, span)) return { row: r, col: c };
    return null;
  };

  const placed = [];
  let i = start;
  while (i < items.length) {
    // 横卡默认跨 2 格；若板上只剩孤立的单格（如页尾连续两张横卡），
    // 降级为占 1 格放置，封面居中裁切——保证板内绝无空缺
    let span = isWideItem(items[i]) ? 2 : 1;
    let spot = findSpot(span);
    if (!spot && span === 2) {
      span = 1;
      spot = findSpot(1);
    }
    if (!spot) break;               // 板真的满了 → 换页
    place(spot.row, spot.col, span);
    placed.push({ idx: i, row: spot.row, col: spot.col, span });
    i++;
  }
  return { placed, next: i };
}

/** 预计算所有分页边界（每页 = 一块装满的 4 行板）。结构沿用 {pages:[{start,end}]}，跳页 O(1)。 */
function computeRowPages(items) {
  const cols = mosaicCols();
  const pages = [];
  let s = 0;
  while (s < items.length) {
    const { next } = packBoard(items, s, cols);
    if (next === s) break;          // 防御：空板必然可放，一般不会触发
    pages.push({ start: s, end: next });
    s = next;
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
 * 渲染总览视图的一页：对切片重放同一装箱过程，把每张卡的格位写进
 * inline gridColumn/gridRow（dense 回填下视觉顺序 ≠ DOM 顺序属正常现象）。
 */
function renderRows(slice) {
  grid.innerHTML = '';
  if (!slice.length) return;

  const cols = mosaicCols();
  const gap = rowGapPx();
  // 单元格宽 ≈ 容器减去列间隙后平分；行高 = 竖版封面高(宽×1.5) + 文字区
  const cellW = Math.floor((grid.clientWidth - gap * (cols - 1)) / cols);

  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridAutoRows = `${cellW * 1.5 + MOSAIC.BODY_H}px`;

  const frag = document.createDocumentFragment();
  let s = 0;
  while (s < slice.length) {
    const { placed, next } = packBoard(slice, s, cols);
    if (!placed.length) break;
    for (const p of placed) {
      const card = buildCard(slice[p.idx]);
      card.style.gridColumn = `${p.col + 1} / span ${p.span}`;
      card.style.gridRow = `${p.row + 1}`;
      frag.appendChild(card);
    }
    s = next;
  }
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
  xhs: '小红书 · 点赞与收藏',
};

/** 根据当前视图动态生成二级筛选 chips（抖音/小红书：点赞、收藏；B站：各收藏夹） */
function renderSubFilters() {
  const box = $('#subFilters');
  let chips = [];
  if (state.view === 'douyin' || state.view === 'xhs') {
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
  //   总览 → 拼贴网格（4 行格板，竖卡 1 格 / 横卡 2 格，dense 回填无空缺）
  //   B站 → 宽列网格（统一 16:9 横屏）
  //   抖音 → 标准网格（统一竖屏）
  const grid = $('#grid');
  grid.classList.toggle('mosaic', state.view === 'all');
  grid.classList.toggle('wide', state.view === 'bilibili');
  if (state.view !== 'all') {
    // 清除拼贴渲染器写入的内联 grid 列/行样式，避免污染其他视图
    grid.removeAttribute('style');
  }
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
  // 默认总览视图 → 拼贴网格
  $('#grid').classList.add('mosaic');
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

/**
 * ============================================================================
 * sw.js — Workspace 收藏夹 Service Worker（PWA 离线缓存）
 * ----------------------------------------------------------------------------
 * 目标：让手机在国内网络下也能秒开站点（对齐 Blog 项目的离线缓存策略）。
 *
 * 策略：
 *   ① 预缓存核心壳（首页/样式/脚本/图标）+ 课表数据 timetable.json（最先可用）
 *   ② data/*.json → stale-while-revalidate：先返回缓存（即时渲染），
 *     后台重新拉取更新缓存；网络失败静默使用缓存。
 *     （app.js 请求带 ?t= 时间戳且 cache:no-store，这里按 pathname 匹配缓存，
 *      绕开 query 差异——这是"数据要新"与"离线可用"的平衡点）
 *   ③ 导航请求 → stale-while-revalidate（秒开 + 后台更新）
 *   ④ 同源静态资源 → cache-first（命中即用，未命中网络+缓存）
 *   ⑤ 跨域请求（播放器音频代理、Blog iframe、封面 CDN）一律不拦截
 *
 * 更新：改动本文件顶部的 VERSION 并重新部署，activate 时自动清旧缓存。
 * ============================================================================
 */
'use strict';

const VERSION = '20260923b';
const CACHE = `workspace-sw-${VERSION}`;

/** 预缓存清单（相对 sw.js 所在目录解析；缺失文件容错跳过） */
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/style.css',
  'assets/app.js',
  'assets/music-dock.js',
  'assets/vendor/chart.umd.js',
  'assets/vendor/netease-mini-player-v2.css',
  'assets/vendor/netease-mini-player-v2.js',
  'assets/vendor/nmpv3.min.js',
  'assets/img/favicon.svg',
  'assets/img/icon-192.png',
  'assets/img/icon-512.png',
  'assets/img/xiaoheihe.png',
  'data/timetable.json',
];

/* ---------------- install：预缓存核心壳（容错） ---------------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] 预缓存跳过:', url, err && err.message);
          })
        )
      );
      await self.skipWaiting();
    })()
  );
});

/* ---------------- activate：清理旧版本缓存 ---------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('workspace-sw-') && k !== CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/* ---------------- fetch：缓存策略 ---------------- */
/** 把 pathname 转成绝对 URL（作为忽略 query 的缓存键） */
const pathKey = (pathname) => new URL(pathname, self.location.origin).href;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 跨域请求（播放器音频代理 / Blog iframe / 封面 CDN）一律放行
  if (url.origin !== self.location.origin) return;

  // data/*.json 与导航请求 → stale-while-revalidate
  // data 请求带 ?t= 时间戳防缓存，按 pathname 匹配（详见文件头注释）
  if (url.pathname.startsWith('/data/') || req.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(req, pathKey(url.pathname)));
    return;
  }

  // 其余同源静态资源 → cache-first（完整 URL 命中优先，pathname 兜底离线）
  event.respondWith(cacheFirst(req));
});

/** 先返回缓存（秒开），同时后台 fetch 更新缓存；无缓存时等网络 */
async function staleWhileRevalidate(req, key) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  // 后台刷新（失败静默，保留旧缓存；响应 OK 才覆盖）
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  return network || Response.error();
}

/** 静态资源：先精确（含 ?v= 版本参数）命中；miss 则回退预缓存的无 query 条目（离线兜底）；最后网络并缓存 */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const exact = await cache.match(req);   // 版本化缓存（如 assets/app.js?v=xxx）
  if (exact) return exact;
  const base = await cache.match(pathKey(new URL(req.url).pathname)); // 预缓存兜底
  if (base) return base;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

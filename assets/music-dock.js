/**
 * ============================================================================
 * music-dock.js — 全站网易云音乐播放器（NeteaseMiniPlayer v3，v2 兼容加载器形态）
 * ----------------------------------------------------------------------------
 * 功能：
 *   ① 右下角常驻迷你播放器（Favorites/Library/Music/Theatre 全视图共用；Blog 隐藏）
 *   ② 默认缩小为 80px 圆唱片（data-default-minimized），播放时唱片自动旋转（v3 内置）
 *   ③ 播放列表 = Music 页当前列表（跟随排序/搜索），播完一首自动下一首（v3 原生）
 *   ④ 暴露 window.playSongOnDock(id)：外部点击歌曲后，让播放器播放指定歌曲
 *
 * 说明：v2 脚本只是兼容加载器，会从 jsDelivr 拉真正的 NMPv3；后端为
 * api.hypcvgm.top 的免费代理（nmp.php），免登录拿音频，浏览器端无任何 Cookie。
 * ============================================================================
 */
(function () {
  'use strict';

  const V2_CSS = 'https://api.hypcvgm.top/NeteaseMiniPlayer/netease-mini-player-v2.css';
  const V2_JS  = 'https://api.hypcvgm.top/NeteaseMiniPlayer/netease-mini-player-v2.js';

  /** 挂载宿主元素并注入 v2 资源（防重复挂载） */
  function ensureMusicDock() {
    if (document.documentElement.querySelector(':scope > .nmp-dock-host')) return;

    // 先放容器（v2 加载器初始化时会扫描全文档）
    const host = document.createElement('div');
    host.className = 'nmp-dock-host';
    host.innerHTML =
      '<div class="netease-mini-player" data-playlist-id="2348674204" ' +
      'data-position="bottom-right" data-lyric="true" data-theme="auto" ' +
      'data-autoplay="false" data-auto-pause="true" data-default-minimized="true" ' +
      // 关闭状态记忆：v3 会把「展开/缩小」存 localStorage 并在刷新后恢复，
      // 用户点开过一次后默认缩小就被永久覆盖；关闭后每次加载都按默认缩小
      'data-remember="false"></div>';
    document.documentElement.appendChild(host);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = V2_CSS;
    document.head.appendChild(link);

    const s = document.createElement('script');
    s.src = V2_JS;
    document.head.appendChild(s);
  }

  /** 播放器实例（未就绪返回 null） */
  function dockPlayer() {
    const nmp = window.NeteaseMiniPlayer || window.NMPv3;
    if (!nmp || typeof nmp.getPlayers !== 'function') return null;
    return nmp.getPlayers()[0] || null;
  }

  /**
   * 播放列表 = Music 页当前筛选/排序结果（musicFiltered 是 app.js 的全局函数）。
   * 字段按 v3 loadPlaylistData 期望：id / name / picUrl / artists / duration(毫秒)。
   */
  function dockSongs() {
    if (typeof musicFiltered === 'function' && typeof state !== 'undefined' && state.music) {
      return musicFiltered().map((m) => ({
        id: m.id,
        name: m.title,
        picUrl: m.cover || '',
        artists: m.artist || '',
        duration: (m.duration || 0) * 1000,
      }));
    }
    return [];
  }

  /**
   * 播放指定歌曲（外部联动入口）。
   * 用 loadPlaylistData 注入整个 Music 列表并定位到所点歌曲 → 播完自动下一首；
   * 轮询等待播放器实例就绪（最长约 10 秒，覆盖慢网络下播放器加载），超时静默放弃。
   */
  window.playSongOnDock = function (id) {
    let tries = 0;
    const attempt = () => {
      const p = dockPlayer();
      if (p && typeof p.loadPlaylistData === 'function') {
        const songs = dockSongs();
        const idx = songs.findIndex((s) => String(s.id) === String(id));
        if (idx === -1) {
          // 列表数据未就绪或不在列表中 → 退回单曲播放
          if (typeof p.loadSong === 'function') {
            p.loadSong(String(id)).then(() => p.play()).catch(() => {});
          }
          return;
        }
        // 同一首歌且音频已就绪 → 直接播放，不重新请求（秒开）
        const cur = p.getCurrentSong ? p.getCurrentSong() : null;
        const st = p.getState ? p.getState() : null;
        if (cur && String(cur.id) === String(id) && st && st.status === 'ready') {
          if (!st.isPlaying) p.play();
          return;
        }
        p.loadPlaylistData({ songs }, { startIndex: idx, autoplay: true }).catch(() => {});
        return;
      }
      if (tries++ < 100) setTimeout(attempt, 100);
    };
    attempt();
  };

  /** 播放器就绪后预热最新收藏的歌曲（注入列表 + 预取第一首音频，只加载不播放） */
  let warmTries = 0;
  function warmupDock() {
    const p = dockPlayer();
    const songs = dockSongs();
    if (!p || !songs.length) {
      if (warmTries++ < 60) setTimeout(warmupDock, 300); // 最长等 ~18 秒
      return;
    }
    // Music 页默认排序 = 收藏时间倒序（最新在前），第一首即最新收藏
    p.loadPlaylistData({ songs }, { startIndex: 0, autoplay: false }).catch(() => {});
  }

  ensureMusicDock();
  warmupDock();
})();

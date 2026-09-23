/**
 * [NMPv2] NeteaseMiniPlayer v2 JavaScript
 * Lightweight Player Component Based on NetEase Cloud Music API
 * 
 * Copyright 2025 BHCN STUDIO & 北海的佰川（ImBHCN[numakkiyu]）
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
(function () {
  var globalObject = window;
  var documentObject = document;
  var loaderKey = "__NMPv2CompatLoader";
  var primaryV3Url =
    "https://cdn.jsdelivr.net/npm/netease-mini-player-v3@latest/dist/nmpv3.min.js";
  var fallbackV3Url =
    "https://unpkg.com/netease-mini-player-v3@latest/dist/nmpv3.min.js";
  var currentScript = documentObject.currentScript;
  var configuredUrl =
    currentScript && currentScript.getAttribute("data-nmpv3-src");
  var v3Urls = configuredUrl
    ? [configuredUrl, primaryV3Url, fallbackV3Url]
    : [primaryV3Url, fallbackV3Url];

  if (globalObject[loaderKey]) {
    globalObject[loaderKey].load();
    return;
  }

  var queuedRoots = [];
  var isLoading = false;
  var hasWarned = false;
  var activeUrlIndex = 0;

  function getV3() {
    return globalObject.NMPv3;
  }

  function warnDeprecated() {
    if (hasWarned || !globalObject.console || !globalObject.console.warn) {
      return;
    }

    hasWarned = true;
    globalObject.console.warn(
      "[NeteaseMiniPlayer v2] 此 v2 脚本的直接 URL 已被弃用，现在将以兼容模式加载 NMPv3。请将其替换为 https://cdn.jsdelivr.net/npm/netease-mini-player-v3@latest/dist/nmpv3.min.js",
    );
  }

  function syncGlobalAlias() {
    var nmpv3 = getV3();

    if (nmpv3) {
      globalObject.NeteaseMiniPlayer = nmpv3;
    }

    return nmpv3;
  }

  function flushQueuedInit() {
    var nmpv3 = syncGlobalAlias();

    if (!nmpv3 || typeof nmpv3.init !== "function") {
      return [];
    }

    var roots = queuedRoots.length ? queuedRoots.slice() : [documentObject];
    var players = [];
    queuedRoots.length = 0;

    roots.forEach(function (root) {
      var result = nmpv3.init(root || documentObject);

      if (Array.isArray(result)) {
        players = result;
      }
    });

    return players;
  }

  function loadNextUrl() {
    var url = v3Urls[activeUrlIndex];

    if (!url) {
      isLoading = false;

      if (globalObject.console && globalObject.console.error) {
        globalObject.console.error(
          "[NeteaseMiniPlayer v2] 加载 NMPv3 兼容捆绑包失败",
        );
      }

      return;
    }

    var script = documentObject.createElement("script");
    script.src = url;
    script.async = false;
    script.setAttribute("data-nmpv2-compat-loader", "true");

    script.onload = function () {
      isLoading = false;
      flushQueuedInit();
    };

    script.onerror = function () {
      activeUrlIndex += 1;
      loadNextUrl();
    };

    (documentObject.head || documentObject.documentElement).appendChild(script);
  }

  function load() {
    warnDeprecated();

    if (getV3()) {
      return flushQueuedInit();
    }

    if (isLoading) {
      return [];
    }

    isLoading = true;
    loadNextUrl();
    return [];
  }

  function queueInit(root) {
    queuedRoots.push(root || documentObject);
    return load();
  }

  function patchWindowConfig(config) {
    globalObject.NMPv3Config = Object.assign(
      {},
      globalObject.NMPv3Config || {},
      config || {},
    );
  }

  var compatApi = {
    version: "2-compat-to-v3",
    deprecated: true,
    defaultApiBaseUrl: "https://api.hypcvgm.top/NeteaseMiniPlayer/nmp.php",
    init: queueInit,
    upgradeLegacy: queueInit,
    processShortcodes: queueInit,
    create: function (target, config) {
      patchWindowConfig(config);
      var nmpv3 = getV3();

      if (nmpv3 && typeof nmpv3.create === "function") {
        return nmpv3.create(target, config || {});
      }

      load();
      return null;
    },
    getPlayers: function () {
      var nmpv3 = getV3();
      return nmpv3 && typeof nmpv3.getPlayers === "function"
        ? nmpv3.getPlayers()
        : [];
    },
    pauseAll: function (except) {
      var nmpv3 = getV3();

      if (nmpv3 && typeof nmpv3.pauseAll === "function") {
        nmpv3.pauseAll(except);
      }
    },
    setGlobalConfig: function (config) {
      patchWindowConfig(config);
      var nmpv3 = getV3();

      if (nmpv3 && typeof nmpv3.setGlobalConfig === "function") {
        nmpv3.setGlobalConfig(config || {});
      }
    },
    setApiBaseUrl: function (apiBaseUrl) {
      patchWindowConfig({ apiBaseUrl: apiBaseUrl });
      globalObject.NMPv3ApiBaseUrl = apiBaseUrl;
      var nmpv3 = getV3();

      if (nmpv3 && typeof nmpv3.setApiBaseUrl === "function") {
        nmpv3.setApiBaseUrl(apiBaseUrl);
      }
    },
    getGlobalConfig: function () {
      var nmpv3 = getV3();

      if (nmpv3 && typeof nmpv3.getGlobalConfig === "function") {
        return nmpv3.getGlobalConfig();
      }

      return globalObject.NMPv3Config || {};
    },
  };

  globalObject[loaderKey] = {
    load: load,
    init: queueInit,
  };
  globalObject.NeteaseMiniPlayer = getV3() || compatApi;
  load();
})();

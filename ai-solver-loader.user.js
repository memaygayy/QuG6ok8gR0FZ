// ==UserScript==
// @name         AI Solver Loader (Short)
// @namespace    https://github.com/memaygayy/QuG6ok8gR0FZ
// @version      1.1
// @description  Loads AI Solver from GitHub raw
// @match        https://*.onluyen.vn/*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      pollinations.ai
// @connect      gen.pollinations.ai
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_URL = "https://raw.githubusercontent.com/memaygayy/QuG6ok8gR0FZ/main/ai-solver.user.js";
  const DELAY = 2000;

  setTimeout(function () {
    GM_xmlhttpRequest({
      method: "GET",
      url: SCRIPT_URL + "?_=" + Date.now(),
      timeout: 30000,
      onload: function (res) {
        if (res.status !== 200 || !res.responseText) {
          console.error("[Loader] HTTP " + res.status);
          return;
        }
        try {
          eval(res.responseText);          // giữ eval trực tiếp để thấy GM_xmlhttpRequest
          console.log("[Loader] Solver injected");
        } catch (e) {
          console.error("[Loader] eval error:", e);
        }
      },
      onerror:   function () { console.error("[Loader] network error"); },
      ontimeout: function () { console.error("[Loader] timeout"); }
    });
  }, DELAY);
})();

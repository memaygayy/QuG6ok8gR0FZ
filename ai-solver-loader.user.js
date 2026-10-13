// ==UserScript==
// @name         AI Solver Loader (Auto-Update)
// @namespace    https://github.com/memaygayy/QuG6ok8gR0FZ
// @version      1.0.0
// @author       Auto-Loader
// @description  Tự động tải & cập nhật ai-solver.user.js từ GitHub — cài 1 lần là xong
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=onluyen.vn
// @match        https://*.onluyen.vn/*
// @match        https://app.onluyen.vn/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      *
// ==/UserScript==

/* =====================================================================
   AI SOLVER LOADER v1.0.0
   ---------------------------------------------------------------------
   - Fetch ai-solver.user.js từ GitHub raw URL
   - Cache vào localStorage → chạy ngay không chờ mạng
   - Check update mỗi 30 phút (khi load trang, không spam)
   - Auto-eval code vào cùng sandbox để dùng được GM_xmlhttpRequest
   - Toast thông báo khi có version mới

   Debug API (mở F12 console):
     hwSolverLoader.getStatus()   → xem version hiện tại
     hwSolverLoader.refresh()     → force fetch bản mới
     hwSolverLoader.clearCache()  → xoá cache (fetch lại lần sau)
   ===================================================================== */

(function () {
  'use strict';

  const LOADER_VERSION   = '1.0.0';
  const SCRIPT_URL       = 'https://raw.githubusercontent.com/memaygayy/QuG6ok8gR0FZ/main/ai-solver.user.js';
  const CACHE_KEY        = 'AI_SOLVER_LOADER_CACHE_V1';
  const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 phút

  console.log(`[Loader v${LOADER_VERSION}] Khởi chạy ~`);

  /* ======================== CACHE ======================== */
  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || !c.code || !c.version) return null;
      return c;
    } catch (e) {
      console.warn('[Loader] Cache hỏng, xoá:', e);
      try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
      return null;
    }
  }

  function writeCache(code, version) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        code,
        version,
        fetchedAt: Date.now(),
        lastCheck: Date.now()
      }));
    } catch (e) {
      console.warn('[Loader] Không lưu được cache:', e);
    }
  }

  function touchLastCheck() {
    const c = readCache();
    if (!c) return;
    c.lastCheck = Date.now();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (_) {}
  }

  /* ==================== VERSION UTILS ==================== */
  function parseVersion(code) {
    const m = String(code).match(/\/\/\s*@version\s+([\d][\d.]*)/);
    return m ? m[1] : '0.0.0';
  }

  function cmpVersion(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  /* ===================== EXECUTE ===================== */
  function runCode(code, version) {
    // Chống eval 2 lần
    if (window.hwSolver && window.__hwSolverLoadedVersion) {
      console.log('[Loader] Script đã chạy rồi, bỏ qua eval');
      return false;
    }

    try {
      // eval trực tiếp → chạy trong cùng sandbox → có GM_xmlhttpRequest
      (0, eval)(code);
      window.__hwSolverLoadedVersion = version;
      console.log(`[Loader] ✅ Đã chạy AI Solver v${version}`);
      return true;
    } catch (e) {
      console.error('[Loader] ❌ Eval thất bại:', e);
      showToast(`❌ Lỗi tải AI Solver:\n${e.message}`, '#dc2626', null, 8000);
      return false;
    }
  }

  /* ====================== FETCH ====================== */
  function fetchLatest(callback) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: SCRIPT_URL + '?_=' + Date.now(), // cache-bust CDN
      timeout: 15000,
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      onload: (res) => {
        if (res.status !== 200) {
          console.warn('[Loader] HTTP', res.status);
          callback(null, res.status);
          return;
        }
        callback(res.responseText, 200);
      },
      onerror:   () => callback(null, 'network-error'),
      ontimeout: () => callback(null, 'timeout')
    });
  }

  /* ==================== UPDATE FLOW ==================== */
  function checkAndUpdate(firstRun) {
    fetchLatest((code, status) => {
      if (!code) {
        console.warn('[Loader] Fetch thất bại:', status);
        if (firstRun && !readCache()) {
          showToast('⚠️ Không tải được AI Solver — kiểm tra mạng', '#facc15', null, 6000);
        }
        return;
      }

      // Nếu server trả HTML GitHub (404 HTML page) → không phải JS
      if (code.trim().startsWith('<')) {
        console.warn('[Loader] Response không phải JS — check lại URL (phải là raw.githubusercontent.com)');
        if (firstRun) {
          showToast('❌ URL sai — phải dùng raw.githubusercontent.com', '#dc2626', null, 8000);
        }
        return;
      }

      const remoteVersion = parseVersion(code);
      const cache = readCache();
      const cachedVersion = cache ? cache.version : '0.0.0';

      console.log(`[Loader] Remote v${remoteVersion} | Cache v${cachedVersion} | FirstRun=${firstRun}`);

      if (cmpVersion(remoteVersion, cachedVersion) > 0) {
        // ============ CÓ VERSION MỚI ============
        writeCache(code, remoteVersion);

        if (firstRun || !cache) {
          // Lần đầu / không có cache → eval luôn
          runCode(code, remoteVersion);
        } else if (window.__hwSolverLoadedVersion !== remoteVersion) {
          // Đang chạy bản cache cũ → thông báo reload
          showToast(
            `🆕 AI Solver v${remoteVersion} sẵn sàng — Bấm để tải`,
            'linear-gradient(135deg, #7c3aed, #3b82f6)',
            () => location.reload(),
            30000
          );
        }
      } else {
        console.log('[Loader] Đã là bản mới nhất');
        touchLastCheck();
      }
    });
  }

  /* ======================== TOAST ======================== */
  function ensureToastStyle() {
    if (document.getElementById('ai-solver-loader-style')) return;
    const st = document.createElement('style');
    st.id = 'ai-solver-loader-style';
    st.textContent = `
      @keyframes ai-solver-slide-in {
        from { transform: translateX(120%); opacity: 0; }
        to   { transform: translateX(0);    opacity: 1; }
      }
      @keyframes ai-solver-pulse {
        0%, 100% { box-shadow: 0 10px 30px rgba(124, 58, 237, 0.5); }
        50%      { box-shadow: 0 10px 40px rgba(124, 58, 237, 0.9); }
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  function showToast(msg, bg, onClick, durationMs) {
    ensureToastStyle();
    document.getElementById('ai-solver-loader-toast')?.remove();

    const toast = document.createElement('div');
    toast.id = 'ai-solver-loader-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${bg};
      color: white;
      padding: 12px 20px;
      border-radius: 12px;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
      z-index: 2147483647;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      cursor: ${onClick ? 'pointer' : 'default'};
      animation: ai-solver-slide-in 0.3s ease-out;
      ${onClick ? 'animation: ai-solver-slide-in 0.3s ease-out, ai-solver-pulse 1.6s ease-in-out infinite;' : ''}
      max-width: 340px;
      white-space: pre-wrap;
      user-select: none;
      -webkit-user-select: none;
      touch-action: manipulation;
    `;
    toast.textContent = msg;

    if (onClick) toast.onclick = onClick;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), durationMs || (onClick ? 30000 : 4000));
  }

  /* ========================= MAIN ========================= */
  const cached = readCache();

  if (cached) {
    // Có cache → eval ngay, không đợi mạng
    runCode(cached.code, cached.version);

    // Background: check update nếu lần check cuối > 30 phút
    const lastCheck = cached.lastCheck || cached.fetchedAt || 0;
    const ageMs = Date.now() - lastCheck;

    if (ageMs > CHECK_INTERVAL_MS) {
      console.log(`[Loader] Cache cũ (${Math.round(ageMs / 60000)}p) → check update ngầm...`);
      setTimeout(() => checkAndUpdate(false), 1500);
    } else {
      console.log(`[Loader] Bỏ qua check (${Math.round(ageMs / 60000)}p < 30p)`);
    }
  } else {
    // Lần đầu → fetch & eval
    console.log('[Loader] Lần đầu chạy — đang tải script từ GitHub...');
    checkAndUpdate(true);
  }

  /* ==================== DEBUG API ==================== */
  const debugApi = {
    loaderVersion: LOADER_VERSION,
    scriptUrl: SCRIPT_URL,

    getStatus() {
      const c = readCache();
      return {
        loaderVersion: LOADER_VERSION,
        loadedVersion: window.__hwSolverLoadedVersion || 'none',
        cachedVersion: c ? c.version : 'none',
        cachedAt: c ? new Date(c.fetchedAt).toLocaleString('vi-VN') : '-',
        lastCheck: c ? new Date(c.lastCheck || c.fetchedAt).toLocaleString('vi-VN') : '-',
        hasSolver: !!window.hwSolver
      };
    },

    refresh() {
      console.log('[Loader] Force refresh từ GitHub...');
      localStorage.removeItem(CACHE_KEY);
      window.location.reload();
    },

    checkUpdate() {
      console.log('[Loader] Manual check...');
      checkAndUpdate(false);
    },

    clearCache() {
      localStorage.removeItem(CACHE_KEY);
      console.log('[Loader] Đã xoá cache');
    }
  };

  window.hwSolverLoader = debugApi;
  console.log('[Loader] Debug API sẵn sàng: hwSolverLoader.getStatus()');
})();

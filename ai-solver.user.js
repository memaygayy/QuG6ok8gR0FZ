// ==UserScript==
// @name         AI Solver v39.9
// @namespace    https://github.com/memaygayy/QuG6ok8gR0FZ
// @version      39.9.0
// @description  Tự động giải trắc nghiệm / điền từ / tự luận / blank-numbered / đáp án hình ảnh trên onluyen.vn (model FREE)
// @author       memaygayy
// @match        https://*.onluyen.vn/*
// @match        https://onluyen.vn/*
// @grant        GM_xmlhttpRequest
// @connect      pollinations.ai
// @connect      gen.pollinations.ai
// @connect      text.pollinations.ai
// @connect      *
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/memaygayy/QuG6ok8gR0FZ/main/ai-solver.user.js
// @downloadURL  https://raw.githubusercontent.com/memaygayy/QuG6ok8gR0FZ/main/ai-solver.user.js
// ==/UserScript==

(function () {
  "use strict";
  if (window.__AI_SOLVER_39_9__) return;
  window.__AI_SOLVER_39_9__ = true;

  /* ============================ CONFIG ============================ */
  const VERSION_STR = "39.9.0";
  const GUI_ID = "ai-solver-v38";
  const PROXY_URL = "https://gen.pollinations.ai/v1/chat/completions";
  const MODELS_URLS = [
    "https://text.pollinations.ai/models",
    "https://gen.pollinations.ai/models"
  ];
  const POLL_KEY = "sk_D8PP0K4jFUDUa0zjrx7uxq1XM1ZoVINK";

  const MODEL_KEY = "HW_SOLVER_MODEL_V3";          // bump V2 -> V3 để bỏ model trả phí cũ
  const MODEL_CUSTOM_KEY = "HW_SOLVER_MODEL_CUSTOM";
  const MODEL_WORKING = "HW_SOLVER_MODEL_WORKING_V3";
  const PAID_KEY = "HW_SOLVER_PAID_MODELS";
  const INTERVAL_KEY = "HW_SOLVER_INTERVAL";
  const VERIFY_KEY = "HW_SOLVER_VERIFY";
  const AUTOSUBMIT_KEY = "HW_SOLVER_AUTO_SUBMIT";
  const REDO_KEY = "HW_SOLVER_REDO_DONE";
  const VISION_KEY = "HW_SOLVER_VISION";

  // Model FREE + mạnh. gemini free và đọc được ảnh.
  const DEFAULT_MODEL = "gemini";
  const FALLBACK_MODELS = ["gemini", "openai-fast", "openai", "mistral", "deepseek", "qwen-coder", "nova-fast"];
  const MODEL_CHOICES = [
    "gemini", "openai-fast", "openai", "mistral",
    "deepseek", "qwen-coder", "nova-fast", "llama", "claude",
    "deepseek/deepseek-v4-flash"
  ];
  const VISION_MODELS = ["gemini", "openai", "openai-fast", "openai-large", "mistral"];

  const MAX_OPTIONS = 12;
  const API_TIMEOUT = 35000;
  const VISION_TIMEOUT = 45000;
  const ASK_BUDGET_MS = 95000;
  const VISION_BUDGET_MS = 110000;
  const WATCHDOG_MS = 60000;
  const MAX_VISION_BYTES = 4000000;

  const BAD_BTN_RE = /(bỏ qua|skip|nộp bài|nộp|xác nhận nộp|hủy|huỷ|cancel|thoát|đóng|close|báo lỗi)/i;
  const NEXT_RE = /(câu tiếp|câu sau|tiếp theo|câu kế|kế tiếp|next)/i;
  const ANSWER_BTN_RE = /(trả lời|làm bài|kiểm tra|xác nhận|gửi|lưu|answer)/i;

  /* ============================ STATE ============================ */
  let running = false;
  let genToken = 0;
  let pendingTokens = 0;
  const logBuf = [];

  /* ============================ UTILS ============================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function qsa(sel, root) {
    try { return Array.from((root || document).querySelectorAll(sel)); }
    catch (e) { return []; }
  }
  function qs(sel, root) {
    try { return (root || document).querySelector(sel); }
    catch (e) { return null; }
  }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    if (parseFloat(s.opacity || "1") === 0) return false;
    return true;
  }
  function insideGui(el) {
    if (!el || !el.closest) return false;
    if (el.closest("#" + GUI_ID)) return true;
    if (el.closest(".answer-sheet")) return true;
    if (el.closest(".mobile-bottom-bar")) return true;
    if (el.closest(".left-side")) return true;
    return false;
  }

  function log(msg) {
    const line = "[" + new Date().toLocaleTimeString("vi-VN", { hour12: false }) + "] " + msg;
    logBuf.push(line);
    if (logBuf.length > 400) logBuf.shift();
    try { console.log("[AI-SOLVER] " + msg); } catch (e) {}
    const el = document.getElementById("ais-log");
    if (el) {
      const d = document.createElement("div");
      d.textContent = line;
      el.appendChild(d);
      while (el.childNodes.length > 240) el.removeChild(el.firstChild);
      el.scrollTop = el.scrollHeight;
    }
  }
  function setStatus(t) {
    const el = document.getElementById("ais-status");
    if (el) el.textContent = t;
  }
  function showAnswer(t) {
    const el = document.getElementById("ais-answer");
    if (el) el.textContent = t || "";
  }

  /* ============================ STORAGE ============================ */
  function lsGet(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, String(v)); } catch (e) {}
  }
  function lsBool(k, d) {
    const v = lsGet(k, null);
    if (v === null) return d;
    return v === "1" || v === "true";
  }

  function getInterval() {
    const n = parseInt(lsGet(INTERVAL_KEY, "900"), 10);
    return isNaN(n) ? 900 : Math.max(300, Math.min(10000, n));
  }
  function getVerifyTimes() {
    const n = parseInt(lsGet(VERIFY_KEY, "1"), 10);
    return isNaN(n) ? 1 : Math.max(0, Math.min(3, n));
  }
  function getVisionEnabled() { return lsBool(VISION_KEY, true); }
  function getRedo() { return lsBool(REDO_KEY, true); }
  function getAutoSubmit() { return lsBool(AUTOSUBMIT_KEY, false); }

  function getModel() {
    const custom = (lsGet(MODEL_CUSTOM_KEY, "") || "").trim();
    if (custom) return custom;
    const m = (lsGet(MODEL_KEY, "") || "").trim();
    return m || DEFAULT_MODEL;
  }
  function setModel(m) {
    if (!m) return;
    lsSet(MODEL_KEY, m);
    if ((lsGet(MODEL_CUSTOM_KEY, "") || "").trim() === m) lsSet(MODEL_CUSTOM_KEY, "");
  }
  function getWorkingModel() { return (lsGet(MODEL_WORKING, "") || "").trim(); }
  function setWorkingModel(m) { if (m) lsSet(MODEL_WORKING, m); }

  function getPaidSet() {
    try {
      const arr = JSON.parse(lsGet(PAID_KEY, "[]"));
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) { return new Set(); }
  }
  function markPaid(model) {
    if (!model) return;
    const s = getPaidSet();
    s.add(String(model));
    lsSet(PAID_KEY, JSON.stringify(Array.from(s)));
  }
  function isPaid(model) { return getPaidSet().has(String(model)); }
  function clearPaid() { lsSet(PAID_KEY, "[]"); }

  /* ============================ NETWORK ============================ */
  function gmRequest(opts) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const to = opts.timeout || API_TIMEOUT;
      const guard = setTimeout(() => finish({ ok: false, status: 0, err: "timeout(outer)" }), to + 4000);
      try {
        GM_xmlhttpRequest({
          method: opts.method || "POST",
          url: opts.url,
          headers: opts.headers || {},
          data: opts.data,
          timeout: to,
          onload: (r) => {
            clearTimeout(guard);
            finish({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText || "" });
          },
          onerror: () => { clearTimeout(guard); finish({ ok: false, status: 0, err: "network error" }); },
          ontimeout: () => { clearTimeout(guard); finish({ ok: false, status: 0, err: "timeout" }); },
          onabort: () => { clearTimeout(guard); finish({ ok: false, status: 0, err: "abort" }); }
        });
      } catch (e) {
        clearTimeout(guard);
        finish({ ok: false, status: 0, err: String((e && e.message) || e) });
      }
    });
  }

  function isPaidError(status, msg) {
    const s = String(msg || "").toLowerCase();
    if (status === 402) return true;
    return /not enough credits|top up|needs paid|insufficient|balance|pollen.*(credit|paid)|paid pollen|requires? (a )?paid/i.test(s);
  }

  function extractContent(json) {
    if (!json) return "";
    const ch = json.choices && json.choices[0];
    if (!ch) return "";
    const msg = ch.message || ch.delta || {};
    let c = msg.content;
    if (Array.isArray(c)) {
      c = c.map((p) => (typeof p === "string" ? p : (p && (p.text || p.content)) || "")).join("");
    }
    if (typeof c === "string" && c.trim()) return c.trim();
    if (typeof ch.text === "string" && ch.text.trim()) return ch.text.trim();
    return "";
  }

  async function callModel(model, messages, timeout) {
    const body = {
      model: model,
      messages: messages,
      temperature: 0.2,
      private: true,
      referrer: "onluyen-solver"
    };
    const r = await gmRequest({
      url: PROXY_URL,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + POLL_KEY
      },
      data: JSON.stringify(body),
      timeout: timeout || API_TIMEOUT
    });

    if (!r.ok) {
      const msg = String(r.text || r.err || "").slice(0, 300);
      if (isPaidError(r.status, msg)) return { ok: false, paid: true, status: r.status, err: msg };
      return { ok: false, paid: false, status: r.status, err: msg };
    }
    let json = null;
    try { json = JSON.parse(r.text); }
    catch (e) { return { ok: false, paid: false, status: r.status, err: "bad JSON" }; }
    const content = extractContent(json);
    if (!content) return { ok: false, paid: false, status: r.status, err: "empty content" };
    return { ok: true, text: content };
  }

  function isVisionModel(m) {
    const s = String(m || "").toLowerCase();
    return VISION_MODELS.some((v) => s.indexOf(v) >= 0);
  }

  function buildChain(needVision) {
    const chosen = getModel();
    const out = [];
    const push = (m) => {
      if (!m) return;
      if (out.indexOf(m) >= 0) return;
      if (isPaid(m)) return;
      out.push(m);
    };
    push(chosen);
    push(getWorkingModel());
    FALLBACK_MODELS.forEach(push);

    let list = out;
    if (needVision) {
      list = out.filter(isVisionModel).concat(out.filter((m) => !isVisionModel(m)));
    }
    return list.slice(0, 5);
  }

  async function askAI(messages, opts) {
    const budget = (opts && opts.budget) || ASK_BUDGET_MS;
    const chain = buildChain(false);
    const start = Date.now();
    if (!chain.length) { log("⚠ Không còn model nào (tất cả bị đánh dấu trả phí). Bấm 🌐 Model free."); return { ok: false }; }

    for (const model of chain) {
      const left = budget - (Date.now() - start);
      if (left < 4000) break;
      const to = Math.min(API_TIMEOUT, left);
      log("… gọi " + model);
      const r = await callModel(model, messages, to);
      if (r.ok) {
        setWorkingModel(model);
        log("AI (" + model + ") OK");
        return { ok: true, text: r.text, model: model };
      }
      if (r.paid) { markPaid(model); log("💳 " + model + " cần trả phí → bỏ, thử model khác."); continue; }
      log("✗ " + model + " → " + String(r.err || ("status " + r.status)).slice(0, 120));
    }
    return { ok: false };
  }

  async function askAIVision(messages, opts) {
    const budget = (opts && opts.budget) || VISION_BUDGET_MS;
    const chain = buildChain(true);
    const start = Date.now();

    for (const model of chain) {
      const left = budget - (Date.now() - start);
      if (left < 5000) break;
      if (!isVisionModel(model)) continue;
      const to = Math.min(VISION_TIMEOUT, left);
      log("… [vision] " + model);
      const r = await callModel(model, messages, to);
      if (r.ok) {
        setWorkingModel(model);
        log("👁 Vision (" + model + ") OK");
        return { ok: true, text: r.text, model: model };
      }
      if (r.paid) { markPaid(model); log("💳 [vision] " + model + " cần trả phí → bỏ."); continue; }
      log("✗ [vision] " + model + " → " + String(r.err || ("status " + r.status)).slice(0, 120));
    }
    return { ok: false };
  }

  async function refreshModelList() {
    log("=== 🌐 LẤY DANH SÁCH MODEL ===");
    for (const url of MODELS_URLS) {
      const r = await gmRequest({ method: "GET", url: url, headers: {}, timeout: 15000 });
      if (!r.ok) { log("✗ " + url + " → " + (r.status || r.err)); continue; }
      try {
        const arr = JSON.parse(r.text);
        if (!Array.isArray(arr)) { log("✗ " + url + " không phải mảng"); continue; }
        const names = arr.map((m) => (typeof m === "string" ? m : m.name || m.id || "")).filter(Boolean);
        const free = arr.filter((m) => typeof m === "object" && !m.paid_only && !m.paidOnly && m.tier !== "paid"
          && !/paid/i.test(String(m.tier || "")));
        const freeNames = free.map((m) => (typeof m === "string" ? m : m.name || m.id || "")).filter(Boolean);
        log("📋 " + url + " → " + names.length + " model");
        log("FREE (" + freeNames.length + "): " + freeNames.slice(0, 60).join(", "));
        const paidNames = names.filter((n) => freeNames.indexOf(n) < 0);
        if (paidNames.length) log("PAID (" + paidNames.length + "): " + paidNames.slice(0, 40).join(", "));
        const vm = free.filter((m) => typeof m === "object" && (m.vision === true || m.supports_vision === true)).map((m) => m.name || m.id);
        if (vm.length) log("👁 Vision free: " + vm.join(", "));
        log("=== HẾT DANH SÁCH ===");
        return freeNames;
      } catch (e) {
        log("✗ parse " + url + " lỗi");
      }
    }
    log("=== KHÔNG LẤY ĐƯỢC DANH SÁCH ===");
    return [];
  }

  /* ============================ PARSERS ============================ */
  function normalizeLetter(v, labels) {
    const s = String(v == null ? "" : v).trim();
    const up = s.toUpperCase();
    if (/^[A-L]$/.test(up) && labels.indexOf(up) >= 0) return up;
    const m = up.match(/^(?:OPTION|ĐÁP ÁN|DAP AN|ANSWER|CHỌN|CHON)?\s*[:\-\.]?\s*([A-L])\b/);
    if (m && labels.indexOf(m[1]) >= 0) return m[1];
    return "";
  }

  function parseAnswerLetter(raw, labels) {
    if (!raw) return "";
    const text = String(raw);
    let m = text.match(/(?:ĐÁP ÁN|DAP AN|ANSWER|CHỌN|CHON)\s*(?:LÀ|LA|IS|:)?\s*[:\-\s]*([A-L])\b/i);
    if (m) { const c = m[1].toUpperCase(); if (labels.indexOf(c) >= 0) return c; }

    m = text.match(/["'`]\s*([A-L])\s*["'`]/);
    if (m && labels.indexOf(m[1]) >= 0) return m[1];

    m = text.match(/^\s*([A-L])\s*[\.\)\:\-]/m);
    if (m && labels.indexOf(m[1]) >= 0) return m[1];

    const all = text.match(/\b([A-L])\b/g) || [];
    for (const a of all) {
      const c = a.replace(/[^A-L]/g, "");
      if (labels.indexOf(c) >= 0) return c;
    }
    return "";
  }

  function parseAnswerObj(raw, labels) {
    if (!raw) return null;
    let text = String(raw).trim().replace(/```[a-zA-Z]*\n?/g, "").trim();

    const mj = text.match(/\{[\s\S]*\}/);
    if (mj) {
      try {
        const o = JSON.parse(mj[0]);
        const a = o.answer != null ? o.answer
          : o.dap_an != null ? o.dap_an
          : o.dapAn != null ? o.dapAn
          : o.choice != null ? o.choice
          : o.result != null ? o.result
          : o.key;
        if (a != null) {
          const L = normalizeLetter(a, labels);
          if (L) {
            const reason = String(o.reason || o.giai_thich || o.giaiThich || o.explain || "").trim();
            return { letter: L, reason: reason.slice(0, 400) };
          }
        }
      } catch (e) {}
    }
    const L = parseAnswerLetter(text, labels);
    return L ? { letter: L, reason: text.slice(0, 400) } : null;
  }

  function parseFillAnswers(raw, n) {
    const out = [];
    if (!raw) return out;
    const text = String(raw).replace(/```[a-zA-Z]*\n?/g, "").trim();

    const mj = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (mj) {
      try {
        const o = JSON.parse(mj[0]);
        if (Array.isArray(o)) return o.map((x) => String(x).trim()).slice(0, n);
        const arr = o.answers || o.dap_an || o.dapAn || o.blanks || o.result;
        if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).slice(0, n);
        if (arr && typeof arr === "object") {
          for (let i = 1; i <= n; i++) {
            const v = arr[String(i)] != null ? arr[String(i)]
              : arr["blank" + i] != null ? arr["blank" + i]
              : arr["(" + i + ")"] != null ? arr["(" + i + ")"] : null;
            if (v != null) out[i - 1] = String(v).trim();
          }
          if (out.filter(Boolean).length) return out;
        }
      } catch (e) {}
    }

    const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    for (const ln of lines) {
      const m = ln.match(/^\(?(\d{1,2})[\.\)\:\-]\s*(.+)$/);
      if (m) {
        const i = parseInt(m[1], 10) - 1;
        if (i >= 0 && i < n) out[i] = m[2].replace(/^[\s\-–]+/, "").trim();
      }
    }
    if (out.filter(Boolean).length) return out;

    const parts = text.split(/[\n,;]+/).map((s) => s.replace(/^\s*\(?\d+[\.\)]\s*/, "").trim()).filter(Boolean);
    return parts.slice(0, n);
  }

  /* ============================ DOM READ ============================ */
  function qRoot() {
    const direct = qs("#test-step-question");
    if (direct) return direct;
    const alt = qs("app-test-school-step-data-regular");
    if (alt) return alt;
    const alt2 = qs(".question-container");
    if (alt2) return alt2;
    return null;
  }

  function currentQuestionTitle() {
    const el = qs("#test-step-question .question-header .num") || qs(".question-header .num");
    if (!el) return "";
    return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90);
  }

  function sigNow() {
    const t = currentQuestionTitle();
    const idm = t.match(/#(\d+)/);
    if (idm) return idm[1];
    const act = qs(".answer-sheet .option.active");
    if (act) return "sheet:" + (act.textContent || "").trim();
    const root = qRoot();
    return t || (root ? (root.textContent || "").slice(0, 90) : "");
  }

  function isNoteArea(el) {
    if (!el || !el.closest) return false;
    if (el.closest(".popupNoteV2")) return true;
    if (el.closest("#test-step-questionnoteTextarea")) return true;
    if (el.id === "test-step-questiontextarea") return true;
    const ph = (el.getAttribute("placeholder") || "").toLowerCase();
    if (ph === "comment...") return true;
    return false;
  }

  function getOptions() {
    const root = qRoot() || document;
    let list = [];
    let type = "";

    list = qsa("div.question-option", root).filter(visible);
    if (list.length >= 2 && list.length <= MAX_OPTIONS) type = "div.question-option";

    if (!list.length) {
      const sel = qsa(".select-item", root).filter((el) => visible(el) || el.querySelector('input[type="radio"],input[type="checkbox"]'));
      if (sel.length >= 2 && sel.length <= MAX_OPTIONS) { list = sel; type = ".select-item"; }
    }

    if (!list.length) {
      const variants = ['[class*="question-option"]', '[class*="answer-option"]', '[class*="choice-item"]',
        '[class*="option-item"]', '[class*="answer-item"]', '[class*="choice"]'];
      for (const sel of variants) {
        const arr = qsa(sel, root).filter(visible);
        if (arr.length >= 2 && arr.length <= MAX_OPTIONS) { list = arr; type = sel; break; }
      }
    }

    if (!list.length) {
      const radios = qsa('input[type="radio"], input[type="checkbox"]', root)
        .filter((el) => !insideGui(el) && !el.closest(".answer-sheet") && !el.closest(".list-selection-hidden"));
      if (radios.length >= 2 && radios.length <= MAX_OPTIONS) {
        list = radios.map((r) =>
          r.closest(".select-item") || r.closest("label") || r.closest('[class*="option"]') ||
          r.closest('[class*="item"]') || r.parentElement
        ).filter(Boolean);
        type = "raw-radio";
      }
    }

    // Dedup + remove nested duplicates
    const uniq = [];
    for (const el of list) {
      if (!el || !el.isConnected) continue;
      if (uniq.some((u) => u === el || u.contains(el) || el.contains(u))) continue;
      uniq.push(el);
    }
    // Re-check nesting: keep innermost among duplicates
    const finalList = uniq.filter((el) => !uniq.some((o) => o !== el && el.contains(o)));

    if (finalList.length < 2) return { list: [], type: "" };
    if (type) log("[getOptions] type=" + type + " ×" + finalList.length);
    return { list: finalList.slice(0, MAX_OPTIONS), type: type };
  }

  function optionLabel(el, i) {
    const lab = qs(".question-option-label", el) || qs(".number-item", el) || qs(".option-label", el);
    if (lab) {
      const t = (lab.textContent || "").trim();
      const m = t.match(/[A-Za-z]/);
      if (m) return m[0].toUpperCase();
    }
    const inp = el.querySelector ? el.querySelector('input[type="radio"], input[type="checkbox"]') : null;
    if (inp) {
      const v = (inp.value || "").trim();
      if (/^[A-Za-z]$/.test(v)) return v.toUpperCase();
      const idm = (inp.id || "").match(/-(\d+)$/);
      if (idm) { /* fall through */ }
    }
    const txt = (el.textContent || "").trim();
    const m2 = txt.match(/^([A-Za-z])[\.\)\:\s]/);
    if (m2) return m2[1].toUpperCase();
    return String.fromCharCode(65 + i);
  }

  function optionText(el) {
    const c = qs(".question-option-content", el) || qs(".select-item-text", el) || qs("label", el);
    let t = ((c ? c.textContent : el.textContent) || "").replace(/\s+/g, " ").trim();
    t = t.replace(/^[A-Za-z][\.\)\:]\s*/, "");
    return t;
  }

  function isImageSrc(s) {
    return typeof s === "string" && /^data:image\//i.test(s);
  }

  function optionImageUrl(el) {
    const imgs = el.querySelectorAll ? el.querySelectorAll("img") : [];
    for (const img of imgs) {
      const src = img.getAttribute("src") || img.currentSrc || "";
      if (isImageSrc(src)) return src;
    }
    const bg = (el.style && el.style.backgroundImage) || "";
    const m = bg.match(/url\(["']?(data:image\/[^"')]+)["']?\)/);
    return m ? m[1] : "";
  }

  function stemImages() {
    const root = qRoot();
    if (!root) return [];
    const imgs = qsa(".question-name img, .question-text img, .fadein img", root);
    const out = [];
    for (const img of imgs) {
      const src = img.getAttribute("src") || img.currentSrc || "";
      if (isImageSrc(src)) out.push(src);
    }
    return out.slice(0, 4);
  }

  function imgBytes(src) {
    const s = String(src || "");
    const i = s.indexOf(",");
    return Math.round(Math.max(0, s.length - i - 1) * 0.75);
  }

  function getStemText() {
    const root = qRoot();
    if (!root) return "";
    const holder = qs(".question-name", root) || root;
    let text = "";
    try {
      const clone = holder.cloneNode(true);
      clone.querySelectorAll(".list-selection, .options, .question-option, .select-item, .row.text-left.options")
        .forEach((e) => e.remove());
      let n = 0;
      clone.querySelectorAll("input, textarea, [contenteditable]").forEach((el) => {
        if (isNoteArea(el)) return;
        n++;
        const span = document.createElement("span");
        span.textContent = " [___" + n + "___] ";
        if (el.parentNode) el.parentNode.replaceChild(span, el);
      });
      text = (clone.textContent || "").replace(/\s+/g, " ").trim();
    } catch (e) {
      text = (holder.textContent || "").replace(/\s+/g, " ").trim();
    }

    const extra = qs(".question-text", root);
    if (extra) {
      const t2 = (extra.textContent || "").replace(/\s+/g, " ").trim();
      if (t2) text += "\n\n" + t2;
    }
    return text.slice(0, 4500);
  }

  function stemWithBlanks() {
    const base = getStemText();
    return base;
  }

  function getTargetBlankNumber() {
    const root = qRoot();
    if (!root) return 0;
    const title = qs(".question-name .title", root);
    const t = title ? (title.textContent || "") : "";
    const m = t.match(/Blank numbered\s*\((\d+)\)/i);
    if (m) return parseInt(m[1], 10);
    return 0;
  }

  function getFillInputs() {
    const root = qRoot() || document;
    const raw = qsa('input[type="text"], input:not([type]), input[type="number"], input[type="search"], [contenteditable="true"]', root);
    const out = [];
    for (const el of raw) {
      if (insideGui(el)) continue;
      if (isNoteArea(el)) continue;
      if (el.closest(".answer-sheet")) continue;
      if (el.disabled || el.readOnly) continue;
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "hidden" || t === "radio" || t === "checkbox" || t === "file") continue;
      if (!visible(el)) continue;
      if (el.isContentEditable && el.tagName !== "DIV" && el.tagName !== "P") { /* keep */ }
      out.push(el);
    }
    return out;
  }

  function getEssayInput() {
    const root = qRoot() || document;
    const areas = qsa("textarea", root);
    for (const el of areas) {
      if (insideGui(el)) continue;
      if (isNoteArea(el)) continue;
      if (el.id === "test-step-questiontextarea") continue;
      if (el.disabled || el.readOnly) continue;
      if (!visible(el)) continue;
      return el;
    }
    return null;
  }

  function submitBarTexts() {
    const bars = qsa(".submit-bar, .question-submit, .btn-submit-answer");
    const out = [];
    for (const bar of bars) {
      if (insideGui(bar)) continue;
      const btns = qsa("button, a.btn", bar);
      for (const b of btns) {
        const t = (b.textContent || "").replace(/\s+/g, " ").trim();
        if (t) out.push(t);
      }
    }
    return out;
  }

  function logSubmitBar() {
    const t = submitBarTexts();
    log("submit-bar: " + (t.length ? "[" + t.join(" | ") + "]" : "(trống)"));
  }

  function isFinished() {
    const opts = qsa(".answer-sheet .option");
    if (opts.length && opts.every((o) => o.classList.contains("done"))) return true;
    return false;
  }

  /* ============================ ACTIONS ============================ */
  function singleClick(el) {
    if (!el) return;
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    } catch (e) {
      try { el.click(); return; } catch (e2) { return; }
    }
    try { el.click(); } catch (e) {}
  }

  function isSelected(el) {
    if (!el) return false;
    const inp = el.matches && el.matches("input") ? el : (el.querySelector ? el.querySelector('input[type="radio"], input[type="checkbox"]') : null);
    if (inp && inp.checked) return true;
    const cls = typeof el.className === "string" ? el.className : "";
    if (/\b(selected|checked|active|highlighted|chosen)\b/.test(cls)) return true;
    if (el.getAttribute && (el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true")) return true;
    return false;
  }

  async function applyAnswer(opt) {
    if (!opt) return false;
    if (isSelected(opt)) return true;

    try { opt.scrollIntoView({ block: "center" }); } catch (e) {}
    await sleep(100);

    const target = (opt.matches && opt.matches("input"))
      ? (opt.closest(".select-item") || opt.closest("label") || opt)
      : opt;

    singleClick(target);
    await sleep(220);
    if (isSelected(opt)) return true;

    const inp = (opt.matches && opt.matches("input")) ? opt : (opt.querySelector ? opt.querySelector('input[type="radio"], input[type="checkbox"]') : null);
    if (inp) {
      try { inp.checked = true; } catch (e) {}
      singleClick(inp);
      try {
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (e) {}
      await sleep(220);
      if (isSelected(opt)) return true;
    }

    const lab = opt.querySelector ? opt.querySelector("label[for]") : null;
    if (lab) {
      singleClick(lab);
      await sleep(220);
      if (isSelected(opt)) return true;
    }
    return isSelected(opt);
  }

  function nativeSet(el, val) {
    try {
      if (el.isContentEditable) {
        el.textContent = val;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: val }));
        return true;
      }
      const proto = (el.tagName === "TEXTAREA") ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, val);
      else el.value = val;
      return true;
    } catch (e) {
      try { el.value = val; return true; } catch (e2) { return false; }
    }
  }

  async function typeInto(el, value) {
    if (!el || value == null) return false;
    const val = String(value);
    try { el.focus(); } catch (e) {}
    try { el.click(); } catch (e) {}
    nativeSet(el, "");
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {}
    await sleep(60);
    nativeSet(el, val);
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: val.slice(-1) }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch (e) {}
    await sleep(120);
    const cur = String(el.value != null ? el.value : el.textContent || "");
    return cur.trim() === val.trim();
  }

  function findAnswerButton() {
    const candidates = [];

    for (const bar of qsa(".submit-bar, .question-submit, .btn-submit-answer, .submit-bar.container-fluid")) {
      if (insideGui(bar)) continue;
      for (const b of qsa("button, a.btn", bar)) candidates.push(b);
    }
    for (const b of qsa("button, a.btn, .btn")) {
      if (insideGui(b)) continue;
      if (b.closest(".answer-sheet")) continue;
      if (b.closest(".report-error")) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 40) continue;
      if (BAD_BTN_RE.test(t)) continue;
      if (!ANSWER_BTN_RE.test(t)) continue;
      candidates.push(b);
    }

    const seen = new Set();
    const scored = [];
    for (const b of candidates) {
      if (seen.has(b)) continue;
      seen.add(b);
      if (!b.isConnected) continue;
      if (b.disabled) continue;
      if (!visible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (BAD_BTN_RE.test(t)) continue;
      let score = 0;
      if (/trả lời/i.test(t)) score += 100;
      else if (ANSWER_BTN_RE.test(t)) score += 50;
      if (b.closest(".submit-bar")) score += 10;
      scored.push({ b: b, score: score });
    }
    scored.sort((a, b2) => b2.score - a.score);
    return scored.length ? scored[0].b : null;
  }

  function findNextButton() {
    for (const b of qsa("button, a.btn, .btn")) {
      if (insideGui(b)) continue;
      if (b.closest(".answer-sheet")) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 40) continue;
      if (BAD_BTN_RE.test(t)) continue;
      if (!NEXT_RE.test(t)) continue;
      if (!visible(b)) continue;
      return b;
    }
    for (const b of qsa(".mobile-bottom-bar button, .nav-btn, button")) {
      if (insideGui(b)) continue;
      if (!b.querySelector(".fa-chevron-right, .fa-angle-right, .fa-arrow-right, .fa-forward")) continue;
      if (!visible(b)) continue;
      return b;
    }
    return null;
  }

  function clickSheetNext() {
    const opts = qsa(".answer-sheet .option");
    if (!opts.length) return false;
    let idx = opts.findIndex((o) => o.classList.contains("active"));
    if (idx < 0) idx = opts.findIndex((o) => !o.classList.contains("done"));
    if (idx >= 0 && idx + 1 < opts.length) {
      singleClick(opts[idx + 1]);
      return true;
    }
    return false;
  }

  async function waitAnswerButton(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const b = findAnswerButton();
      if (b) return b;
      await sleep(250);
    }
    return null;
  }

  async function advance() {
    const sig = sigNow();

    const ans = await waitAnswerButton(2500);
    if (ans) {
      const txt = (ans.textContent || "").replace(/\s+/g, " ").trim();
      singleClick(ans);
      log('Bấm nút: "' + txt + '"');
      await sleep(900);
      if (sigNow() !== sig) { log("Trang tự chuyển câu."); return true; }
    }

    if (clickSheetNext()) {
      log("Chuyển câu bằng phiếu trả lời.");
      await sleep(800);
      if (sigNow() !== sig) return true;
    }

    const nxt = findNextButton();
    if (nxt) {
      singleClick(nxt);
      log("Bấm nút chuyển câu.");
      await sleep(800);
      if (sigNow() !== sig) return true;
    }

    return sigNow() !== sig;
  }

  /* ============================ PROMPTS ============================ */
  function buildMcqMessages(stem, items, blankN, prevLetter) {
    const opts = items.map((o) => o.label + ". " + (o.text || "(nội dung là hình ảnh, không đọc được bằng text)")).join("\n");
    let user = "";
    if (blankN) user += "Đoạn văn dưới đây có các chỗ trống (1)…(n). Chọn đáp án đúng để điền vào CHỖ TRỐNG SỐ (" + blankN + ").\n\n";
    user += "ĐỀ BÀI:\n" + stem + "\n\nCÁC LỰA CHỌN:\n" + opts + "\n\n";
    user += 'Hãy chọn đúng 1 đáp án. Trả lời DUY NHẤT bằng JSON: {"answer":"<chữ cái>","reason":"<giải thích ngắn bằng tiếng Việt>"}';
    if (prevLetter) user += '\nLần trước bạn đã chọn "' + prevLetter + '". Hãy KIỂM TRA LẠI THẬT KỸ. Nếu vẫn đúng thì giữ nguyên, nếu sai thì đổi.';

    return [
      { role: "system", content: "Bạn là giáo viên giỏi, giải đề chính xác, chỉ trả về JSON." },
      { role: "user", content: user }
    ];
  }

  function buildFillMessages(stem, count, targetBlank) {
    let user = "";
    if (targetBlank) user += "Chỉ cần trả lời cho CHỖ TRỐNG SỐ (" + targetBlank + ") trong đoạn văn.\n\n";
    user += "ĐỀ BÀI (các ô trống được đánh dấu [___n___]):\n" + stem + "\n\n";
    user += "Có tất cả " + count + " ô cần điền. Hãy điền từ/cụm từ/công thức còn thiếu.\n";
    user += 'Trả lời DUY NHẤT bằng JSON: {"answers":["đáp án 1","đáp án 2", ...]} (đúng ' + count + ' phần tử).';
    return [
      { role: "system", content: "Bạn là giáo viên giỏi, giải đề điền từ chính xác, chỉ trả về JSON." },
      { role: "user", content: user }
    ];
  }

  function buildEssayMessages(stem) {
    const user = "ĐỀ BÀI:\n" + stem + "\n\nHãy viết câu trả lời/lời giải hoàn chỉnh, ngắn gọn, đúng trọng tâm. Không dùng markdown.";
    return [
      { role: "system", content: "Bạn là giáo viên giỏi, trả lời tự luận chính xác." },
      { role: "user", content: user }
    ];
  }

  function buildVisionMcqParts(stem, items, blankN, prevLetter) {
    const content = [];
    let head = "";
    if (blankN) head += "Chọn đáp án đúng để điền vào CHỖ TRỐNG SỐ (" + blankN + ") trong đoạn văn.\n\n";
    head += "ĐỀ BÀI (phần chữ):\n" + (stem || "(không có chữ)") + "\n\n";
    const sImgs = stemImages();
    if (sImgs.length) head += "(Ảnh của đề bài được đính kèm bên dưới.)\n";
    content.push({ type: "text", text: head });

    for (const src of sImgs) content.push({ type: "image_url", image_url: { url: src } });

    for (const o of items) {
      content.push({ type: "text", text: "\n--- Đáp án " + o.label + " ---" });
      if (o.img) content.push({ type: "image_url", image_url: { url: o.img } });
      else content.push({ type: "text", text: o.text || "(trống)" });
    }

    let tail = '\nHãy quan sát THẬT KỸ các hình ảnh (đồ thị, bảng số liệu, hình vẽ) và chọn đáp án đúng. Trả lời DUY NHẤT bằng JSON: {"answer":"<chữ cái>","reason":"<giải thích ngắn>"}';
    if (prevLetter) tail += '\nLần trước bạn đã chọn "' + prevLetter + '". Kiểm tra lại thật kỹ, giữ nguyên nếu đúng, đổi nếu sai.';
    content.push({ type: "text", text: tail });

    return [
      { role: "system", content: "Bạn là giáo viên giỏi, đọc và phân tích được hình ảnh, chỉ trả về JSON." },
      { role: "user", content: content }
    ];
  }

  /* ============================ SOLVE ============================ */
  function shouldUseVision(items) {
    if (!getVisionEnabled()) return false;
    const imgCount = items.filter((o) => o.img).length;
    const sImgs = stemImages();
    let bytes = 0;
    for (const o of items) if (o.img) bytes += imgBytes(o.img);
    for (const s of sImgs) bytes += imgBytes(s);

    if (imgCount >= 2) {
      if (bytes > MAX_VISION_BYTES) { log("📷 Ảnh quá lớn (" + Math.round(bytes / 1024) + "KB) → bỏ vision."); return false; }
      return true;
    }
    if (imgCount === 0 && sImgs.length > 0) {
      if (bytes > MAX_VISION_BYTES) return false;
      return true;
    }
    return false;
  }

  async function solveMcq(stem, items, blankN, useVision, prevLetter) {
    if (useVision) {
      const parts = buildVisionMcqParts(stem, items, blankN, prevLetter);
      const r = await askAIVision(parts, { budget: VISION_BUDGET_MS });
      if (r.ok) {
        const p = parseAnswerObj(r.text, items.map((o) => o.label));
        if (p) return { letter: p.letter, reason: p.reason, model: r.model, via: "vision" };
        log("⚠ Vision trả lời không đọc được → thử text.");
      }
    }
    const msgs = buildMcqMessages(stem, items, blankN, prevLetter);
    const r2 = await askAI(msgs, { budget: ASK_BUDGET_MS });
    if (r2.ok) {
      const p = parseAnswerObj(r2.text, items.map((o) => o.label));
      if (p) return { letter: p.letter, reason: p.reason, model: r2.model, via: "text" };
      log("⚠ AI trả lời không đọc được: " + r2.text.slice(0, 160));
    }
    return null;
  }

  async function stepMcq(opts, token) {
    const sig = sigNow();
    const title = currentQuestionTitle();
    log("Tìm thấy " + opts.list.length + " đáp án | " + title);

    const stem = getStemText();
    const blankN = getTargetBlankNumber();
    if (blankN) log("→ Đích: điền chỗ trống (" + blankN + ")");

    const items = opts.list.map((el, i) => ({
      el: el,
      label: optionLabel(el, i),
      text: optionText(el),
      img: optionImageUrl(el)
    }));

    log("Đáp án: " + items.map((o) => o.label + (o.img ? "(ảnh)" : "") + ". " + (o.text || "").slice(0, 45)).join(" | "));

    const useVision = shouldUseVision(items);
    if (useVision) {
      const nImg = items.filter((o) => o.img).length;
      log("📷 Ảnh: " + nImg + "/" + items.length + " đáp án, " + stemImages().length + " trong đề → dùng vision.");
    }

    const first = await solveMcq(stem, items, blankN, useVision, "");
    if (token !== genToken) return;
    if (!first) { log("⚠ Không có đáp án — chuyển câu."); await advance(); return; }

    let chosenLabel = first.letter;
    let target = items.find((o) => o.label === chosenLabel);
    if (!target) { log("⚠ Đáp án AI trả về không khớp lựa chọn (" + chosenLabel + ") — chuyển câu."); await advance(); return; }

    log("AI chọn " + target.label + (target.text ? ". " + target.text.slice(0, 70) : ". (hình ảnh)") +
      (first.reason ? ' · "' + first.reason.slice(0, 110) + '"' : ""));
    showAnswer(target.label + ". " + (target.text || "(hình ảnh)"));

    let ok = await applyAnswer(target.el);
    if (token !== genToken) return;
    log(ok ? "Đã tick " + target.label + "." : "⚠ Không tick được " + target.label + ".");

    // ---- verify passes ----
    const times = getVerifyTimes();
    for (let i = 0; i < times; i++) {
      if (token !== genToken) return;
      const again = await solveMcq(stem, items, blankN, useVision, target.label);
      if (!again) { log("… Kiểm tra " + (i + 1) + ": không gọi được AI — bỏ qua."); continue; }
      if (again.letter === target.label) {
        log("✓ Kiểm tra " + (i + 1) + " giữ: " + target.label);
        continue;
      }
      const alt = items.find((o) => o.label === again.letter);
      if (!alt) { log("… Kiểm tra " + (i + 1) + ": AI đổi sang " + again.letter + " nhưng không khớp — bỏ qua."); continue; }
      log("↻ Kiểm tra " + (i + 1) + " đổi sang " + alt.label + " · " + (again.reason || "").slice(0, 100));
      const ok2 = await applyAnswer(alt.el);
      if (ok2) { target = alt; chosenLabel = alt.label; showAnswer(alt.label + ". " + (alt.text || "(hình ảnh)")); }
    }

    if (getRedo() && sig !== sigNow()) { /* nothing */ }

    await advance();
  }

  async function stepFill(inputs, token) {
    const sig = sigNow();
    const title = currentQuestionTitle();
    log("Tìm thấy " + inputs.length + " ô điền | " + title);

    const stem = stemWithBlanks();
    const blankN = getTargetBlankNumber();
    const msgs = buildFillMessages(stem, inputs.length, blankN);
    const r = await askAI(msgs, { budget: ASK_BUDGET_MS });
    if (token !== genToken) return;
    if (!r.ok) { log("⚠ AI lỗi — chuyển câu."); await advance(); return; }

    const answers = parseFillAnswers(r.text, inputs.length);
    log("AI điền: " + JSON.stringify(answers));

    let filled = 0;
    for (let i = 0; i < inputs.length; i++) {
      const val = answers[i];
      if (!val) continue;
      const ok = await typeInto(inputs[i], val);
      if (ok) filled++;
    }
    log("Đã điền " + filled + "/" + inputs.length + " ô.");

    if (filled === 0) { log("⚠ Không điền được ô nào — chuyển câu."); await advance(); return; }
    await sleep(250);
    if (sig === sigNow()) await advance();
    else log("Trang tự chuyển câu.");
  }

  async function stepEssay(input, token) {
    const sig = sigNow();
    log("Tìm thấy ô tự luận | " + currentQuestionTitle());
    const stem = getStemText();
    const msgs = buildEssayMessages(stem);
    const r = await askAI(msgs, { budget: ASK_BUDGET_MS });
    if (token !== genToken) return;
    if (!r.ok) { log("⚠ AI lỗi — chuyển câu."); await advance(); return; }

    let text = String(r.text || "").trim();
    text = text.replace(/^(Đáp án|Trả lời|Answer)\s*[:\-]\s*/i, "").trim();
    const ok = await typeInto(input, text);
    log(ok ? "Đã điền tự luận (" + text.length + " ký tự)." : "⚠ Không điền được tự luận.");

    if (sig === sigNow()) await advance();
    else log("Trang tự chuyển câu.");
  }

  /* ============================ LOOP ============================ */
  async function tick(token) {
    const root = qRoot();
    if (!root) { log("Chưa thấy câu hỏi… chờ trang render."); await sleep(1200); return; }

    log("———————————————");
    logSubmitBar();

    if (isFinished()) {
      log("🎉 Đã làm hết các câu.");
      if (getAutoSubmit()) {
        const btn = qs(".submit-button button") || qs(".submit-button .btn");
        if (btn && visible(btn)) { singleClick(btn); log("Đã bấm Nộp Bài."); }
      }
      stop();
      return;
    }

    const opts = getOptions();
    if (opts.list.length >= 2) { await stepMcq(opts, token); return; }

    const fills = getFillInputs();
    if (fills.length) { await stepFill(fills, token); return; }

    const essay = getEssayInput();
    if (essay) { await stepEssay(essay, token); return; }

    log("⚠ Không nhận diện được dạng câu — thử chuyển câu.");
    await advance();
  }

  async function sleepWithToken(ms, token) {
    let left = ms;
    while (left > 0 && running && token === genToken) {
      const step = Math.min(250, left);
      await sleep(step);
      left -= step;
    }
  }

  async function loop() {
    if (running) return;
    running = true;
    const token = ++genToken;
    setStatus("Đang chạy · " + getModel());
    log("=== START · chọn: " + getModel() + " · dùng: " + (getWorkingModel() || "—") + " ===");
    log("Model bị đánh dấu trả phí: " + (Array.from(getPaidSet()).join(", ") || "(không)"));
    log("Vision: " + (getVisionEnabled() ? "ON" : "OFF") + " · Kiểm tra lại: " + getVerifyTimes() + " · Chu kỳ: " + getInterval() + "ms");

    while (running && token === genToken) {
      let timedOut = false;
      const watchdog = new Promise((res) => {
        setTimeout(() => { timedOut = true; res(); }, WATCHDOG_MS);
      });

      try {
        await Promise.race([tick(token), watchdog]);
      } catch (e) {
        log("❌ Lỗi vòng lặp: " + ((e && e.message) || e));
      }

      if (!running || token !== genToken) break;

      if (timedOut) {
        log("⏱ Watchdog " + Math.round(WATCHDOG_MS / 1000) + "s — ép chuyển câu.");
        try { await advance(); } catch (e) {}
      }

      await sleepWithToken(getInterval(), token);
    }

    running = false;
    setStatus("Đã dừng");
    log("=== STOP ===");
  }

  function start() {
    if (running) { log("Đang chạy rồi."); return; }
    loop();
  }
  function stop() {
    if (!running) { setStatus("Đã dừng"); return; }
    running = false;
    genToken++;
    setStatus("Đã dừng");
  }

  /* ============================ TEST / DEBUG ============================ */
  function dumpHTML() {
    log("=== DUMP HTML ===");
    const root = qRoot();
    if (!root) { log("Không thấy #test-step-question"); return; }
    let html = root.outerHTML || "";
    html = html.replace(/src="data:image\/[^"]{60,}"/g, 'src="data:image/…(base64 bỏ)"');
    log(html.slice(0, 3000));
    log("=== HẾT DUMP (" + html.length + " ký tự) ===");
    try { console.log("[AI-SOLVER] DUMP:\n" + html); } catch (e) {}
  }

  function checkPage() {
    log("=== CHECK PAGE ===");
    log("URL: " + location.href);
    log("qRoot: " + (qRoot() ? "có container" : "KHÔNG thấy"));
    log("Tiêu đề câu: " + (currentQuestionTitle() || "(trống)"));
    logSubmitBar();

    const opts = getOptions();
    log("Options: " + opts.list.length + (opts.type ? " (type=" + opts.type + ")" : ""));
    opts.list.forEach((el, i) => {
      log("  " + optionLabel(el, i) + ". " + (optionText(el) || "(trống)").slice(0, 70) + (optionImageUrl(el) ? " [ẢNH]" : ""));
    });

    const fills = getFillInputs();
    log("Fill inputs: " + fills.length);
    fills.forEach((el, i) => log("  #" + (i + 1) + " id=" + (el.id || "?") + " type=" + (el.type || "?")));

    const essay = getEssayInput();
    log("Essay textarea: " + (essay ? "có (id=" + (essay.id || "?") + ")" : "không"));
    log("Vision bật: " + (getVisionEnabled() ? "có" : "không") + " · ảnh đề: " + stemImages().length);
    log("Blank numbered: " + (getTargetBlankNumber() || "không"));

    const sheet = qsa(".answer-sheet .option");
    if (sheet.length) {
      const done = sheet.filter((o) => o.classList.contains("done")).length;
      const act = sheet.findIndex((o) => o.classList.contains("active"));
      log("Answer-sheet: " + sheet.length + " (done: " + done + ", active: #" + (act >= 0 ? act + 1 : "?") + ")");
    }
    log("=== HẾT CHECK ===");
  }

  async function testAI() {
    log("=== TEST AI ===");
    log("Model chọn: " + getModel());
    log("Model đang dùng: " + (getWorkingModel() || "(chưa)"));
    log("Bị đánh dấu trả phí: " + (Array.from(getPaidSet()).join(", ") || "(không)"));

    const msgs = [{ role: "user", content: 'Trả lời DUY NHẤT bằng JSON: {"answer":"B","reason":"test"}' }];
    const chain = buildChain(false);
    log("Chuỗi thử: " + chain.join(" → "));

    for (const m of chain) {
      log("… " + m);
      const r = await callModel(m, msgs, 25000);
      if (r.ok) log("✅ " + m + " OK → " + r.text.slice(0, 100));
      else if (r.paid) { markPaid(m); log("💳 " + m + " CẦN TRẢ PHÍ → đã đánh dấu bỏ qua."); }
      else log("✗ " + m + " → " + String(r.err || ("status " + r.status)).slice(0, 120));
    }

    log("=== TEST VISION ===");
    const tiny = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const vmsgs = [{
      role: "user",
      content: [
        { type: "text", text: 'Ảnh này là gì? Trả lời JSON: {"answer":"A","reason":"..."}' },
        { type: "image_url", image_url: { url: tiny } }
      ]
    }];
    for (const m of chain) {
      if (!isVisionModel(m)) continue;
      log("… [vision] " + m);
      const r = await callModel(m, vmsgs, 30000);
      if (r.ok) log("✅ vision " + m + " OK → " + r.text.slice(0, 100));
      else if (r.paid) { markPaid(m); log("💳 vision " + m + " CẦN TRẢ PHÍ."); }
      else log("✗ vision " + m + " → " + String(r.err || ("status " + r.status)).slice(0, 120));
    }
    log("=== HẾT TEST ===");
  }

  /* ============================ GUI ============================ */
  function buildGui() {
    if (document.getElementById(GUI_ID)) return;

    const wrap = document.createElement("div");
    wrap.id = GUI_ID;
    wrap.style.cssText = [
      "position:fixed", "top:10px", "right:10px", "width:338px", "max-width:95vw",
      "z-index:2147483647", "background:#0f1216", "color:#e8eaed",
      "font:12px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
      "border:1px solid #263238", "border-radius:10px",
      "box-shadow:0 10px 30px rgba(0,0,0,.6)", "overflow:hidden"
    ].join(";");

    wrap.innerHTML =
      '<div id="ais-head" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:linear-gradient(90deg,#134e2a,#1b7a3e);font-weight:700;cursor:move;user-select:none;">' +
        '<span>⚡ ai slover v39.9</span><span style="flex:1"></span>' +
        '<button id="ais-collapse" style="background:#0b2b17;color:#cfe8d5;border:1px solid #2e7d32;border-radius:5px;padding:0 7px;cursor:pointer;">–</button>' +
      '</div>' +
      '<div id="ais-body" style="padding:8px 10px 10px;">' +

        '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">' +
          '<span style="width:78px;color:#9fb3c8;">Model</span>' +
          '<select id="ais-model" style="flex:1;background:#151b22;color:#e8eaed;border:1px solid #2b3a47;border-radius:5px;padding:3px;"></select>' +
        '</div>' +

        '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">' +
          '<span style="width:78px;color:#9fb3c8;">Model khác</span>' +
          '<input id="ais-custom" placeholder="vd: openai-fast" style="flex:1;background:#151b22;color:#e8eaed;border:1px solid #2b3a47;border-radius:5px;padding:3px 5px;">' +
        '</div>' +

        '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">' +
          '<span style="width:78px;color:#9fb3c8;">Chu kỳ ms</span>' +
          '<input id="ais-interval" type="number" min="300" max="10000" step="100" style="width:80px;background:#151b22;color:#e8eaed;border:1px solid #2b3a47;border-radius:5px;padding:3px 5px;">' +
          '<span style="color:#9fb3c8;">Kiểm tra</span>' +
          '<input id="ais-verify" type="number" min="0" max="3" style="width:52px;background:#151b22;color:#e8eaed;border:1px solid #2b3a47;border-radius:5px;padding:3px 5px;">' +
        '</div>' +

        '<label style="display:flex;gap:6px;align-items:center;margin-bottom:4px;cursor:pointer;"><input id="ais-vision" type="checkbox"> 📷 Dùng AI đọc hình (vision)</label>' +
        '<label style="display:flex;gap:6px;align-items:center;margin-bottom:4px;cursor:pointer;"><input id="ais-redo" type="checkbox"> Làm lại câu đã đúng</label>' +
        '<label style="display:flex;gap:6px;align-items:center;margin-bottom:8px;cursor:pointer;"><input id="ais-autosubmit" type="checkbox"> Tự nộp bài khi hết câu (nguy hiểm)</label>' +

        '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
          '<button id="ais-start" style="flex:1;background:#1b7a3e;color:#fff;border:0;border-radius:6px;padding:7px;font-weight:700;cursor:pointer;">▶ Start</button>' +
          '<button id="ais-stop" style="flex:1;background:#7a1b1b;color:#fff;border:0;border-radius:6px;padding:7px;font-weight:700;cursor:pointer;">■ Stop</button>' +
        '</div>' +

        '<div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;">' +
          '<button id="ais-check" style="flex:1;background:#1b4d7a;color:#fff;border:0;border-radius:6px;padding:5px;cursor:pointer;">🔍 Check page</button>' +
          '<button id="ais-test" style="flex:1;background:#5a1b7a;color:#fff;border:0;border-radius:6px;padding:5px;cursor:pointer;">🧪 Test AI</button>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;">' +
          '<button id="ais-models" style="flex:1;background:#0d6b6b;color:#fff;border:0;border-radius:6px;padding:5px;cursor:pointer;">🌐 Model free</button>' +
          '<button id="ais-dump" style="flex:1;background:#444;color:#fff;border:0;border-radius:6px;padding:5px;cursor:pointer;">🔬 Dump HTML</button>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
          '<button id="ais-clearpaid" style="flex:1;background:#3a3a3a;color:#ddd;border:0;border-radius:6px;padding:4px;cursor:pointer;">♻ Xoá danh sách trả phí</button>' +
        '</div>' +

        '<div id="ais-status" style="color:#9fb3c8;margin-bottom:4px;">Sẵn sàng</div>' +
        '<div id="ais-answer" style="background:#0b2b17;border:1px solid #2e7d32;border-radius:6px;padding:5px 7px;color:#8bf0a8;font-weight:700;margin-bottom:6px;min-height:16px;"></div>' +
        '<div id="ais-log" style="height:172px;overflow:auto;background:#080b0e;border:1px solid #1e2a33;border-radius:6px;padding:5px;font:11px/1.35 ui-monospace,Consolas,monospace;color:#b8c7d1;"></div>' +
        '<div style="margin-top:6px;color:#5f7284;font-size:10.5px;">v39.9 · model FREE (gemini) · vision · blank-numbered · chống treo 60s</div>' +
      '</div>';

    document.body.appendChild(wrap);

    // flush buffered logs
    const logEl = document.getElementById("ais-log");
    for (const line of logBuf.slice(-200)) {
      const d = document.createElement("div");
      d.textContent = line;
      logEl.appendChild(d);
    }
    logEl.scrollTop = logEl.scrollHeight;

    // ---- fill values ----
    const sel = document.getElementById("ais-model");
    const cur = getModel();
    const choices = MODEL_CHOICES.slice();
    if (choices.indexOf(cur) < 0) choices.unshift(cur);
    sel.innerHTML = choices.map((m) => '<option value="' + m + '">' + m + "</option>").join("");
    sel.value = cur;

    document.getElementById("ais-custom").value = lsGet(MODEL_CUSTOM_KEY, "") || "";
    document.getElementById("ais-interval").value = getInterval();
    document.getElementById("ais-verify").value = getVerifyTimes();
    document.getElementById("ais-vision").checked = getVisionEnabled();
    document.getElementById("ais-redo").checked = getRedo();
    document.getElementById("ais-autosubmit").checked = getAutoSubmit();

    // ---- events ----
    sel.addEventListener("change", () => {
      lsSet(MODEL_KEY, sel.value);
      lsSet(MODEL_CUSTOM_KEY, "");
      document.getElementById("ais-custom").value = "";
      log("Đổi model → " + sel.value);
    });

    document.getElementById("ais-custom").addEventListener("change", (e) => {
      const v = (e.target.value || "").trim();
      lsSet(MODEL_CUSTOM_KEY, v);
      log(v ? "Model khác → " + v : "Bỏ model khác.");
    });

    document.getElementById("ais-interval").addEventListener("change", (e) => {
      const n = parseInt(e.target.value, 10);
      lsSet(INTERVAL_KEY, isNaN(n) ? 900 : Math.max(300, Math.min(10000, n)));
    });

    document.getElementById("ais-verify").addEventListener("change", (e) => {
      const n = parseInt(e.target.value, 10);
      lsSet(VERIFY_KEY, isNaN(n) ? 1 : Math.max(0, Math.min(3, n)));
    });

    document.getElementById("ais-vision").addEventListener("change", (e) => lsSet(VISION_KEY, e.target.checked ? "1" : "0"));
    document.getElementById("ais-redo").addEventListener("change", (e) => lsSet(REDO_KEY, e.target.checked ? "1" : "0"));
    document.getElementById("ais-autosubmit").addEventListener("change", (e) => lsSet(AUTOSUBMIT_KEY, e.target.checked ? "1" : "0"));

    document.getElementById("ais-start").addEventListener("click", start);
    document.getElementById("ais-stop").addEventListener("click", stop);
    document.getElementById("ais-check").addEventListener("click", checkPage);
    document.getElementById("ais-test").addEventListener("click", testAI);
    document.getElementById("ais-models").addEventListener("click", refreshModelList);
    document.getElementById("ais-dump").addEventListener("click", dumpHTML);
    document.getElementById("ais-clearpaid").addEventListener("click", () => {
      clearPaid();
      log("♻ Đã xoá danh sách model trả phí.");
    });

    // ---- collapse ----
    document.getElementById("ais-collapse").addEventListener("click", () => {
      const body = document.getElementById("ais-body");
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      document.getElementById("ais-collapse").textContent = hidden ? "–" : "+";
    });

    // ---- drag ----
    const head = document.getElementById("ais-head");
    let drag = false, dx = 0, dy = 0;
    head.addEventListener("pointerdown", (e) => {
      if (e.target && e.target.id === "ais-collapse") return;
      drag = true;
      const r = wrap.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      wrap.style.right = "auto";
      wrap.style.left = r.left + "px";
      wrap.style.top = r.top + "px";
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
    });
    head.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const w = wrap.offsetWidth;
      const x = Math.max(0, Math.min(window.innerWidth - w - 4, e.clientX - dx));
      const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy));
      wrap.style.left = x + "px";
      wrap.style.top = y + "px";
    });
    head.addEventListener("pointerup", () => { drag = false; });
    head.addEventListener("pointercancel", () => { drag = false; });
  }

  /* ============================ BOOT ============================ */
  function boot() {
    buildGui();
    log("VERSION " + VERSION_STR + " booted at " + new Date().toISOString());
    log("URL: " + location.href);
    log("qRoot: " + (qRoot() ? "có container" : "chưa thấy (trang đang tải)"));
    log("Model mặc định: " + DEFAULT_MODEL + " · đang chọn: " + getModel());
    if (getPaidSet().size) log("⚠ Model bị đánh dấu trả phí: " + Array.from(getPaidSet()).join(", ") + " (bấm ♻ để xoá)");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  // expose for debugging
  window.__AI_SOLVER__ = {
    start: start,
    stop: stop,
    check: checkPage,
    test: testAI,
    models: refreshModelList,
    paid: () => Array.from(getPaidSet()),
    clearPaid: clearPaid
  };
})();

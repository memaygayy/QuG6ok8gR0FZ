// ==UserScript==
// @name         AI Solver v38.7
// @namespace    https://github.com/memaygayy/QuG6ok8gR0FZ
// @version      38.7.0
// @description  Auto solve onluyen.vn — .question-option, không bấm "Bỏ qua"/"Nộp Bài"
// @author       memaygayy
// @match        https://*.onluyen.vn/*
// @grant        GM_xmlhttpRequest
// @connect      pollinations.ai
// @connect      gen.pollinations.ai
// @connect      *
// @updateURL    https://raw.githubusercontent.com/memaygayy/QuG6ok8gR0FZ/main/ai-solver.user.js
// @downloadURL  https://raw.githubusercontent.com/memaygayy/QuG6ok8gR0FZ/main/ai-solver.user.js
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";
  if (window.__AI_SOLVER_V38__) return;
  window.__AI_SOLVER_V38__ = true;

  /* ================= CONFIG ================= */
  const GUI_ID    = "ai-solver-v38";
  const PROXY_URL = "https://gen.pollinations.ai/v1/chat/completions";
  const POLL_KEY  = "sk_D8PP0K4jFUDUa0zjrx7uxq1XM1ZoVINK";

  const MODEL_KEY        = "HW_SOLVER_MODEL_V2";
  const MODEL_CUSTOM_KEY = "HW_SOLVER_MODEL_CUSTOM";
  const MODEL_WORKING    = "HW_SOLVER_MODEL_WORKING";
  const INTERVAL_KEY     = "HW_SOLVER_INTERVAL";
  const RESOLVE_KEY      = "HW_SOLVER_RE_SOLVE_DONE";
  const AUTOSUBMIT_KEY   = "HW_SOLVER_AUTO_SUBMIT";

  const DEFAULT_MODEL    = "deepseek/deepseek-v4-flash";
  const FALLBACK_MODELS  = ["deepseek", "gemini", "openai"];
  const MODEL_CHOICES    = ["deepseek/deepseek-v4-flash", "deepseek", "gemini", "openai", "claude"];

  const MAX_OPTIONS      = 12;
  const RE_CHECK_ROUNDS  = 3;
  const MAX_ANSWER_RETRY = 2;
  const API_TIMEOUT      = 35000;
  const NEXT_WAIT        = 8000;
  const QUESTION_WAIT_MS = 20000;

  /* ================= STATE ================= */
  const state = {
    running: false, busy: false,
    lastSig: "", sameSigCount: 0,
    cache: new Map(), solvedSigs: new Set(),
    timers: [], advanceFail: 0, answered: 0, idleTicks: 0
  };
  let TRANSPORT = null;

  /* ================= GETTERS ================= */
  function getInterval()    { const v = parseInt(localStorage.getItem(INTERVAL_KEY), 10); return (isNaN(v) || v < 1200) ? 3500 : v; }
  function getReSolveDone() { return localStorage.getItem(RESOLVE_KEY) !== "false"; }
  function getAutoSubmit()  { return localStorage.getItem(AUTOSUBMIT_KEY) === "true"; }
  function getModel() {
    const custom = (localStorage.getItem(MODEL_CUSTOM_KEY) || "").trim();
    if (custom) return custom;
    return localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
  }

  /* ================= UTILS ================= */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    return true;
  }

  function insideGui(el) { const g = document.getElementById(GUI_ID); return !!(g && el && g.contains(el)); }

  function insideChrome(el) {
    if (!el || !el.closest) return false;
    if (el.closest("#" + GUI_ID))       return true;
    if (el.closest(".answer-sheet"))    return true;
    if (el.closest(".mobile-bottom-bar")) return true;
    if (el.closest(".left-side"))       return true;
    if (el.closest(".submit-bar"))      return true;
    return false;
  }

  function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function cleanText(el) { return (el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim(); }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
    const cls = typeof el.className === "string" ? el.className : "";
    if (/\b(disabled|is-disabled|btn-disabled)\b/i.test(cls)) return true;
    return false;
  }

  function clickEl(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    try { el.click(); return true; } catch (e) {}
    try {
      const o = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new MouseEvent("mouseup", o));
      el.dispatchEvent(new MouseEvent("click", o));
      return true;
    } catch (e) { return false; }
  }

  function setNativeChecked(input, val) {
    try {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      if (d && d.set) d.set.call(input, val); else input.checked = val;
    } catch (e) { try { input.checked = val; } catch (e2) {} }
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, "value");
    if (d && d.set) d.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ================= TRANSPORT ================= */
  async function fetchJSON(opts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, opts.timeout || API_TIMEOUT);
    try {
      const res = await fetch(opts.url, {
        method: opts.method || "GET",
        headers: opts.headers || {},
        body: opts.data,
        signal: ctrl.signal, mode: "cors", credentials: "omit", cache: "no-store"
      });
      return { status: res.status, responseText: await res.text() };
    } finally { clearTimeout(t); }
  }

  function gmJSON(opts) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") { reject(new Error("GM_xmlhttpRequest undefined")); return; }
      try {
        GM_xmlhttpRequest({
          method: opts.method || "GET", url: opts.url,
          headers: opts.headers || {}, data: opts.data,
          timeout: opts.timeout || API_TIMEOUT,
          onload: r => resolve({ status: r.status, responseText: r.responseText }),
          onerror: () => reject(new Error("GM network error")),
          ontimeout: () => reject(new Error("GM timeout")),
          onabort: () => reject(new Error("GM aborted"))
        });
      } catch (e) { reject(e); }
    });
  }

  async function request(opts) {
    if (TRANSPORT === "gm") return await gmJSON(opts);
    try {
      const r = await fetchJSON(opts);
      if (TRANSPORT !== "fetch") { TRANSPORT = "fetch"; log("Transport = fetch (OK)", "ok"); }
      return r;
    } catch (e) {
      if (TRANSPORT === "fetch") throw e;
      const r = await gmJSON(opts);
      TRANSPORT = "gm";
      log("Transport = GM_xmlhttpRequest (OK)", "warn");
      return r;
    }
  }

  /* ================= API ================= */
  async function askAIOnce(messages, model) {
    const body = { model: model, messages: messages, temperature: 0.2, max_tokens: 900, private: true };
    const res = await request({
      method: "POST", url: PROXY_URL,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + POLL_KEY },
      data: JSON.stringify(body), timeout: API_TIMEOUT
    });
    if (res.status !== 200) throw new Error("HTTP " + res.status + " " + (res.responseText || "").slice(0, 140).replace(/\s+/g, " "));
    let json;
    try { json = JSON.parse(res.responseText); }
    catch (e) { throw new Error("bad json: " + (res.responseText || "").slice(0, 120)); }
    if (json && json.error) throw new Error("API: " + String(json.error).slice(0, 120));
    const c = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!c || !String(c).trim()) throw new Error("empty response");
    return String(c);
  }

  async function askAI(messages, model) {
    try { return await askAIOnce(messages, model); }
    catch (e) {
      if (/empty response/.test(e.message)) { await sleep(700); return await askAIOnce(messages, model); }
      throw e;
    }
  }

  async function askWithFallback(messages, model) {
    const working = (localStorage.getItem(MODEL_WORKING) || "").trim();
    const queue = [];
    if (working) queue.push(working);
    [model].concat(FALLBACK_MODELS).forEach(m => { if (m && queue.indexOf(m) < 0) queue.push(m); });

    let lastErr = null;
    for (let i = 0; i < queue.length; i++) {
      const m = queue[i];
      try {
        const text = await askAI(messages, m);
        if (m !== working) { localStorage.setItem(MODEL_WORKING, m); log("Model dùng được: " + m, "ok"); }
        return text;
      } catch (e) {
        lastErr = e;
        log("Model " + m + " lỗi: " + e.message, "warn");
        if (working && m === working) localStorage.removeItem(MODEL_WORKING);
        if (!/not found|404|unsupported|invalid model|empty|bad json|400|401|403|429/i.test(e.message)) break;
      }
    }
    throw lastErr || new Error("API failed");
  }

  /* ================= PROMPT + PARSE ================= */
  function buildMessages(stem, optTexts, prevWrong) {
    const letters = optTexts.map((_, i) => String.fromCharCode(65 + i));
    const list = optTexts.map((t, i) => letters[i] + ". " + t).join("\n");
    const sys = [
      "Bạn là trợ lý giải bài tập trắc nghiệm.",
      "Đọc kỹ câu hỏi và chọn đáp án đúng nhất.",
      "Nếu câu có nhiều đáp án đúng, liệt kê tất cả.",
      "Trả lời ĐÚNG định dạng, không thêm gì khác:",
      "ĐÁP ÁN: <chữ cái, nhiều đáp án cách nhau dấu phẩy>",
      "GIẢI THÍCH: <1-2 câu ngắn gọn>"
    ].join("\n");
    let user = "Câu hỏi:\n" + stem + "\n\nCác lựa chọn:\n" + list + "\n\nChọn đáp án đúng.";
    if (prevWrong && prevWrong.length) user += "\n\nLƯU Ý: đáp án " + prevWrong.join(", ") + " đã bị SAI. Bắt buộc chọn đáp án KHÁC.";
    return [{ role: "system", content: sys }, { role: "user", content: user }];
  }

  function parseAnswer(text, count) {
    const out = new Set();
    const s = String(text);
    let seg = "";
    const m = s.match(/ĐÁP\s*ÁN\s*[:：]/i);
    if (m) seg = s.slice(m.index + m[0].length).split("\n")[0];
    else seg = s.split("\n").find(l => /[A-F]/.test(l)) || s;

    (seg.toUpperCase().match(/\b[A-F]\b/g) || []).forEach(ch => {
      const i = ch.charCodeAt(0) - 65;
      if (i >= 0 && i < count) out.add(i);
    });
    if (!out.size) {
      (s.toUpperCase().match(/(?:^|[\s:.,(])([A-F])(?=[\s.,)\n]|$)/g) || []).forEach(tok => {
        const ch = tok.trim().replace(/[^A-F]/g, "");
        if (ch.length === 1) { const i = ch.charCodeAt(0) - 65; if (i >= 0 && i < count) out.add(i); }
      });
    }
    if (!out.size && m) {
      (seg.match(/\b(\d{1,2})\b/g) || []).forEach(n => {
        const i = parseInt(n, 10) - 1;
        if (i >= 0 && i < count) out.add(i);
      });
    }
    return Array.from(out).sort((a, b) => a - b);
  }

  /* ================= DOM: ĐÁP ÁN ================= */
  const OPTION_SELECTORS = [
    "#test-step-question .question-option",
    ".question-option",
    ".answer-item",
    ".answers .item", ".list-answer .item", ".answer-list .item",
    ".option-item", ".choices .item", ".choice-item",
    ".question-item .answer", ".question .answer", ".answer"
  ];

  const BAD_BTN_RE = /(bỏ qua|skip|nộp bài|nộp|xác nhận nộp|hủy|huỷ|cancel|thoát|đóng|close|báo lỗi)/i;

  function isButtonLike(n) {
    const t = cleanText(n).toLowerCase();
    return /^(nộp bài|nộp|kiểm tra|bỏ qua|tiếp|câu tiếp|next|submit|start|stop|gửi|skip)$/.test(t);
  }

  function optionText(el) {
    if (!el) return "";
    const c = el.querySelector && el.querySelector(".question-option-content");
    if (c) { const t = cleanText(c); if (t) return t; }
    let t = cleanText(el);
    t = t.replace(/^[A-F]\s*[.)]?\s+/i, "");
    return t;
  }

  function getOptionNodes() {
    for (let s = 0; s < OPTION_SELECTORS.length; s++) {
      let nodes;
      try { nodes = Array.from(document.querySelectorAll(OPTION_SELECTORS[s])); } catch (e) { continue; }
      nodes = nodes.filter(n => n.isConnected && !insideChrome(n) && !isButtonLike(n) && isVisible(n));
      if (nodes.length < 2 || nodes.length > MAX_OPTIONS) continue;
      const inner = nodes.filter(n => !nodes.some(m => m !== n && n.contains(m)));
      if (inner.length < 2) continue;
      const texts = inner.map(optionText).filter(t => t.length > 0);
      if (texts.length < 2) continue;
      const numeric = texts.filter(t => /^\d{1,3}$/.test(t)).length;
      if (numeric >= texts.length) continue;
      return inner;
    }
    return [];
  }

  function isOptionSelected(el) {
    if (!el) return false;
    const cls = typeof el.className === "string" ? el.className : "";
    if (/(^|\s)(selected|checked|active|highlighted|chosen|is-selected|is-checked|is-active)(\s|$)/i.test(cls)) return true;
    if (el.getAttribute("aria-checked") === "true") return true;
    if (el.getAttribute("aria-selected") === "true") return true;
    const input = el.querySelector('input[type="radio"], input[type="checkbox"]');
    if (input && input.checked) return true;
    return false;
  }

  function selectOption(el) {
    if (!el) return false;
    if (isOptionSelected(el)) return true;

    // click thẳng vào khối đáp án (site bind event ở đây)
    clickEl(el);
    if (isOptionSelected(el)) return true;

    const input = el.querySelector('input[type="radio"], input[type="checkbox"]');
    if (input) {
      try { input.click(); } catch (e) {}
      if (!input.checked) {
        setNativeChecked(input, true);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    return isOptionSelected(el);
  }

  /* ================= DOM: ĐỀ BÀI ================= */
  function getQuestionNo() {
    const n = document.querySelector("#test-step-question .question-header .num") ||
              document.querySelector(".question-header .num");
    if (!n) return "";
    const t = cleanText(n);
    const m = t.match(/(?:câu|question)\s*[:.]?\s*(\d+)/i) || t.match(/(\d+)/);
    return m ? m[1] : "";
  }

  function extractLeafStem(root, options) {
    const parts = [];
    function walk(node) {
      if (!node || node.nodeType !== 1) return;
      if (insideChrome(node)) return;
      for (let i = 0; i < options.length; i++) if (options[i] === node || options[i].contains(node)) return;
      const kids = Array.from(node.children);
      if (!kids.length) {
        const t = cleanText(node);
        if (t && t.length >= 4 && !/^[\d\s.,/:\-]+$/.test(t)) parts.push(t);
        return;
      }
      kids.forEach(walk);
    }
    walk(root);
    let out = "";
    for (let i = 0; i < parts.length && out.length < 1500; i++) out += (out ? " " : "") + parts[i];
    return out.trim();
  }

  function getStem(options) {
    // 1) onluyen school-test: .question-name (+ đoạn văn .question-text)
    const qn = document.querySelector("#test-step-question .question-name") || document.querySelector(".question-name");
    if (qn) {
      const parts = [];
      const qt = document.querySelector("#test-step-question .question-text");
      if (qt) { const t = cleanText(qt); if (t && t.length > 10) parts.push(t); }
      const t2 = cleanText(qn);
      if (t2) parts.push(t2);
      const out = parts.join("\n").trim();
      if (out.length >= 5) return out.slice(0, 2500);
    }

    // 2) generic
    if (!options || !options.length) return "";
    const optTexts = options.map(optionText).filter(t => t.length);

    let anc = options[0], guard = 0;
    while (anc && !options.every(o => anc.contains(o)) && guard++ < 40) anc = anc.parentElement;
    if (!anc) return "";

    let cur = anc;
    for (let i = 0; i < 6; i++) {
      if (!cur.parentElement || cur.parentElement === document.body) break;
      if (cleanText(cur.parentElement).length > cleanText(cur).length + 15) cur = cur.parentElement;
      else break;
    }

    let full = cleanText(cur);
    const longOpts = optTexts.filter(t => t.length >= 4);
    for (let i = 0; i < longOpts.length; i++) {
      const idx = full.indexOf(longOpts[i]);
      if (idx > 5) { full = full.slice(0, idx); break; }
    }
    full = full.replace(/(^|\s)(\d{1,3}\s+){3,}/g, " ").replace(/\s+/g, " ").trim();
    if (full.length >= 20) return full.slice(0, 2500);

    const leaf = extractLeafStem(cur, options);
    if (leaf.length >= 10) return leaf.slice(0, 2500);
    return (full || cleanText(cur)).slice(0, 2500);
  }

  /* ================= DOM: TIẾN ĐỘ / ĐIỀU HƯỚNG ================= */
  function getAnsweredCount() {
    const report = document.querySelector(".left-side .report");
    if (!report) return null;
    const fields = Array.from(report.querySelectorAll(".field"));
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const name = cleanText(f.querySelector(".field-name") || f);
      if (/đã làm/i.test(name)) {
        const v = parseInt(cleanText(f.querySelector(".field-value") || f), 10);
        if (!isNaN(v)) return v;
      }
    }
    return null;
  }

  function getProgress() {
    const sheet = document.querySelector(".answer-sheet");
    if (!sheet) return null;
    const opts = Array.from(sheet.querySelectorAll(".option"));
    if (!opts.length) return null;
    let done = 0, active = -1;
    for (let i = 0; i < opts.length; i++) {
      const c = typeof opts[i].className === "string" ? opts[i].className : "";
      if (/(^|\s)(done|answered)(\s|$)/i.test(c)) done++;
      if (/(^|\s)active(\s|$)/i.test(c)) active = i;
    }
    return { total: opts.length, done: done, active: active, list: opts };
  }

  const NEXT_RE = /(câu tiếp|tiếp theo|câu sau|câu kế|kế tiếp|next)/i;

  function findNextNav() {
    // 1) chevron phải ở thanh mobile
    const bar = document.querySelector(".mobile-bottom-bar");
    if (bar) {
      const btns = Array.from(bar.querySelectorAll("button.nav-btn"));
      for (let i = 0; i < btns.length; i++) {
        const b = btns[i];
        const isRight = b.querySelector(".fa-chevron-right, .fa-angle-right") || i === btns.length - 1;
        if (isRight && !b.querySelector(".fa-chevron-left") && !isDisabled(b) && isVisible(b)) return b;
      }
    }
    // 2) ô số kế tiếp trong phiếu trả lời
    const p = getProgress();
    if (p && p.active >= 0 && p.active + 1 < p.list.length) return p.list[p.active + 1];
    // 3) chevron bất kỳ
    const all = document.querySelectorAll(".nav-btn");
    for (let i = 0; i < all.length; i++) {
      const b = all[i];
      if (b.querySelector(".fa-chevron-right, .fa-angle-right") && !isDisabled(b)) return b;
    }
    // 4) nút chữ "Tiếp"
    const nodes = document.querySelectorAll('button, a, [role="button"]');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.isConnected || insideChrome(n) || !isVisible(n)) continue;
      const t = cleanText(n);
      if (!t || t.length > 30) continue;
      if (BAD_BTN_RE.test(t)) continue;
      if (NEXT_RE.test(t)) return n;
    }
    return null;
  }

  function findCheckButton() {
    const nodes = document.querySelectorAll('button, a, [role="button"]');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.isConnected || insideChrome(n) || !isVisible(n)) continue;
      const t = cleanText(n);
      if (!t || t.length > 30) continue;
      if (BAD_BTN_RE.test(t)) continue;
      if (/^(kiểm tra|check|kiểm tra đáp án|trả lời)$/i.test(t)) return n;
    }
    return null;
  }

  /* ================= APPLY + VERIFY ================= */
  async function applySelection(indices) {
    const before = getAnsweredCount();

    let opts = getOptionNodes();
    if (!opts.length) return false;
    for (let k = 0; k < indices.length; k++) {
      const el = opts[indices[k]];
      if (el && !isOptionSelected(el)) selectOption(el);
    }
    await sleep(450);

    for (let round = 1; round <= RE_CHECK_ROUNDS; round++) {
      opts = getOptionNodes();
      let ok = 0;
      for (let k = 0; k < indices.length; k++) {
        const el = opts[indices[k]];
        if (el && isOptionSelected(el)) ok++;
      }
      if (ok === indices.length) return true;

      const now = getAnsweredCount();
      if (before !== null && now !== null && now > before) {
        log("Site ghi nhận đáp án (bộ đếm " + before + " → " + now + ")", "ok");
        return true;
      }
      if (round >= RE_CHECK_ROUNDS) break;

      // chỉ click lại những cái CHƯA chọn
      for (let k = 0; k < indices.length; k++) {
        const el = opts[indices[k]];
        if (el && !isOptionSelected(el)) selectOption(el);
      }
      await sleep(300 * round);
      log("Kiểm tra lại " + round + "/" + RE_CHECK_ROUNDS + " (" + ok + "/" + indices.length + " đã chọn)", "warn");
    }
    return false;
  }

  async function clickSubmitBtn() {
    const before = getAnsweredCount();
    const opts = getOptionNodes();
    const anySelected = opts.some(isOptionSelected) || (before !== null && before > 0);
    if (!anySelected) { log("Chưa chọn được đáp án nào — KHÔNG bấm nộp.", "warn"); return false; }

    const btn = findCheckButton();
    if (!btn) return false;   // trang này không có nút kiểm tra từng câu
    clickEl(btn);
    log("Đã bấm nút kiểm tra", "ok");
    return true;
  }

  function currentSig() {
    const opts = getOptionNodes();
    if (!opts.length) return "";
    return hashStr(getQuestionNo() + "||" + getStem(opts) + "||" + opts.map(optionText).join("|"));
  }

  async function waitForChange(oldSig, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || NEXT_WAIT)) {
      await sleep(250);
      const s = currentSig();
      if (s && s !== oldSig) return true;
    }
    return false;
  }

  async function waitForOptions(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || QUESTION_WAIT_MS)) {
      const opts = getOptionNodes();
      if (opts.length) return opts;
      await sleep(500);
    }
    return [];
  }

  /* ================= CHUYỂN CÂU ================= */
  async function advance(prevSig) {
    await sleep(300);

    const nav = findNextNav();
    if (nav && !isDisabled(nav)) {
      clickEl(nav);
      if (await waitForChange(prevSig, NEXT_WAIT)) return true;

      const again = findNextNav();
      if (again && !isDisabled(again) && again !== nav) {
        clickEl(again);
        if (await waitForChange(prevSig, 6000)) return true;
      }
      return false;
    }

    const p = getProgress();
    const allDone = p && p.total > 0 && p.done >= p.total;

    if (allDone && getAutoSubmit()) {
      const headerBtn = Array.from(document.querySelectorAll(".submit-button button, button"))
        .find(b => !insideChrome(b) && isVisible(b) && /nộp bài/i.test(cleanText(b)));
      if (headerBtn && !isDisabled(headerBtn)) {
        clickEl(headerBtn);
        log("Đã bấm 'Nộp Bài' (do bật Tự nộp bài).", "warn");
        setStatus("Hoàn tất");
        await sleep(1200);
        const confirm = Array.from(document.querySelectorAll("button"))
          .find(b => isVisible(b) && !insideChrome(b) && /^(đồng ý|xác nhận|nộp bài|ok)$/i.test(cleanText(b)));
        if (confirm) clickEl(confirm);
        stop();
        return true;
      }
    }

    log("Không tìm thấy nút chuyển câu. KHÔNG tự nộp bài.", "warn");
    setStatus("Chờ nút chuyển câu...");
    return false;
  }

  async function safeAdvance(sig) {
    const ok = await advance(sig);
    if (ok) { state.advanceFail = 0; return true; }
    state.advanceFail++;
    if (state.advanceFail >= 10) {
      log("Kẹt 10 lần không chuyển được câu — tự dừng.", "err");
      setStatus("Bị kẹt — đã dừng");
      stop();
    }
    return false;
  }

  /* ================= SOLVE ================= */
  async function reAsk(stem, optTexts, prevWrong) {
    try {
      const text = await askWithFallback(buildMessages(stem, optTexts, prevWrong), getModel());
      return parseAnswer(text, optTexts.length);
    } catch (e) { log("Hỏi lại AI thất bại: " + e.message, "err"); return []; }
  }

  async function solveCurrent() {
    let options = getOptionNodes();

    if (!options.length) {
      const ta = Array.from(document.querySelectorAll("textarea"))
        .find(t => !insideChrome(t) && isVisible(t) && !insideGui(t));
      if (ta) { await handleEssay(ta); return; }

      state.idleTicks++;
      if (state.idleTicks === 1 || state.idleTicks % 5 === 0) {
        log("Chưa thấy đáp án... chờ trang render.", "warn");
        setStatus("Đang chờ câu hỏi...");
      }
      options = await waitForOptions(QUESTION_WAIT_MS);
      if (!options.length) return;
    }
    state.idleTicks = 0;

    const stem     = getStem(options);
    const optTexts = options.map(optionText);
    const qno      = getQuestionNo();
    const sig      = hashStr(qno + "||" + stem + "||" + optTexts.join("|"));

    log("Câu " + (qno || "?") + " · " + options.length + " đáp án · " + stem.slice(0, 80).replace(/\n/g, " "));

    if (state.solvedSigs.has(sig)) {
      log("Câu này đã giải trong phiên — chuyển tiếp.");
      await safeAdvance(sig);
      return;
    }

    if (sig === state.lastSig) state.sameSigCount++;
    else { state.lastSig = sig; state.sameSigCount = 0; setStatus("Câu mới"); }

    if (state.sameSigCount > 4) {
      log("Câu lặp quá nhiều — chuyển câu.", "warn");
      await safeAdvance(sig);
      state.sameSigCount = 0;
      return;
    }

    if (!getReSolveDone()) {
      const cnt = getAnsweredCount();
      const p = getProgress();
      const already = (p && p.active >= 0 && /(^|\s)(done|answered)(\s|$)/i.test(p.list[p.active].className)) ||
                      options.some(isOptionSelected);
      if (already) {
        log("Câu đã làm — bỏ qua (bật 'Làm lại câu đã đúng' để giải lại).");
        state.solvedSigs.add(sig);
        await safeAdvance(sig);
        return;
      }
    }

    let indices = null;
    const cached = state.cache.get(sig);
    if (cached) {
      indices = cached.slice();
      log("Cache: " + indices.map(i => String.fromCharCode(65 + i)).join(", "));
    } else {
      setStatus("Đang hỏi AI...");
      let text;
      try { text = await askWithFallback(buildMessages(stem, optTexts), getModel()); }
      catch (e) { log("API lỗi: " + e.message, "err"); setStatus("Lỗi API — thử lại"); return; }

      indices = parseAnswer(text, optTexts.length);
      if (!indices.length) {
        log("AI không trả về đáp án đọc được — chờ, KHÔNG nộp.", "err");
        setStatus("AI trả lời không đọc được");
        return;
      }
      state.cache.set(sig, indices.slice());
      if (state.cache.size > 200) state.cache.delete(state.cache.keys().next().value);
      log("AI chọn: " + indices.map(i => String.fromCharCode(65 + i)).join(", "), "ok");
    }

    let prevWrong = [];
    let attempt = 0;
    let solvedOk = false;

    while (attempt <= MAX_ANSWER_RETRY) {
      setStatus("Đang chọn đáp án...");
      const applied = await applySelection(indices);
      if (!applied) log("Chưa xác nhận được đáp án.", "warn");

      let fb = detectFeedback(getOptionNodes());

      if (fb.wrong.size && indices.some(i => fb.wrong.has(i))) {
        prevWrong = prevWrong.concat(indices.map(i => String.fromCharCode(65 + i)));
        attempt++;
        if (attempt > MAX_ANSWER_RETRY) break;
        setStatus("Sai — xin đáp án khác...");
        const nxt = await reAsk(stem, optTexts, prevWrong);
        if (!nxt.length) break;
        indices = nxt.filter(i => prevWrong.indexOf(String.fromCharCode(65 + i)) < 0);
        if (!indices.length) indices = nxt;
        state.cache.set(sig, indices.slice());
        continue;
      }
      if (fb.correct.size) { log("Đã đúng.", "ok"); solvedOk = true; break; }

      const clicked = await clickSubmitBtn();
      if (!clicked) { solvedOk = applied; break; }

      await sleep(800);
      fb = detectFeedback(getOptionNodes());
      if (fb.wrong.size && indices.some(i => fb.wrong.has(i))) {
        prevWrong = prevWrong.concat(indices.map(i => String.fromCharCode(65 + i)));
        attempt++;
        if (attempt > MAX_ANSWER_RETRY) break;
        setStatus("Sai — chọn lại...");
        const nxt = await reAsk(stem, optTexts, prevWrong);
        if (!nxt.length) break;
        indices = nxt.filter(i => prevWrong.indexOf(String.fromCharCode(65 + i)) < 0);
        if (!indices.length) indices = nxt;
        state.cache.set(sig, indices.slice());
        continue;
      }
      solvedOk = true;
      break;
    }

    if (solvedOk) { state.answered++; state.solvedSigs.add(sig); }

    setStatus("Đang chuyển câu...");
    await safeAdvance(sig);
  }

  function detectFeedback(options) {
    const correct = new Set(), wrong = new Set();
    const OK  = ["correct", "true", "right", "success", "dung", "đúng", "answer-correct", "is-correct"];
    const BAD = ["incorrect", "wrong", "false", "error", "sai", "answer-wrong", "is-wrong", "is-incorrect"];
    options.forEach((o, i) => {
      const cls = (typeof o.className === "string" ? o.className : "").toLowerCase();
      const parts = cls.split(/\s+/).filter(Boolean);
      if (parts.some(p => OK.indexOf(p) >= 0))  correct.add(i);
      if (parts.some(p => BAD.indexOf(p) >= 0)) wrong.add(i);
    });
    return { correct: correct, wrong: wrong };
  }

  async function handleEssay(ta) {
    if ((ta.value || "").trim().length > 3) {
      log("Ô trả lời đã có nội dung — chuyển câu.");
      const s = hashStr(cleanText(ta) + "||essay");
      state.solvedSigs.add(s);
      await safeAdvance(s);
      return;
    }
    let box = ta.parentElement;
    for (let i = 0; i < 4 && box; i++) { if (cleanText(box).length > 40) break; box = box.parentElement; }
    const stem = cleanText(box || ta).slice(0, 1500);
    if (!stem) return;

    setStatus("Đang giải tự luận...");
    const msgs = [
      { role: "system", content: "Bạn giải bài tập. Trả lời ngắn gọn, chính xác, không giải thích dài dòng." },
      { role: "user", content: stem }
    ];
    try {
      const text = await askWithFallback(msgs, getModel());
      setNativeValue(ta, text.trim());
      log("Đã điền câu trả lời tự luận.", "ok");
      await sleep(400);
      const btn = findCheckButton();
      if (btn && !isDisabled(btn)) { clickEl(btn); await sleep(700); }
      state.answered++;
      const s = hashStr(stem + "||essay");
      state.solvedSigs.add(s);
      await safeAdvance(s);
    } catch (e) { log("Lỗi tự luận: " + e.message, "err"); }
  }

  /* ================= LOOP ================= */
  async function tick() {
    if (!state.running || state.busy) return;
    state.busy = true;
    const started = Date.now();
    try { await solveCurrent(); }
    catch (e) { log("Lỗi vòng lặp: " + (e && e.message ? e.message : e), "err"); }
    finally {
      if (Date.now() - started > 120000) log("Vòng lặp quá lâu — reset.", "warn");
      state.busy = false;
    }
    if (state.running) state.timers.push(setTimeout(tick, getInterval()));
  }

  function start() {
    if (state.running) return;
    state.running = true; state.busy = false;
    state.sameSigCount = 0; state.advanceFail = 0; state.idleTicks = 0;
    state.solvedSigs = new Set();
    setStatus("Đang chạy...");
    log("▶ Bắt đầu", "ok");
    tick();
  }

  function stop() {
    state.running = false; state.busy = false;
    for (let i = 0; i < state.timers.length; i++) clearTimeout(state.timers[i]);
    state.timers = [];
    setStatus("Đã dừng");
    log("■ Dừng", "warn");
  }

  /* ================= GUI ================= */
  function log(msg, type) {
    const box = document.getElementById("ais-log");
    const line = document.createElement("div");
    line.className = "ais-line" + (type ? " ais-" + type : "");
    const t = new Date();
    const st = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0") + ":" + String(t.getSeconds()).padStart(2, "0");
    line.textContent = "[" + st + "] " + msg;
    if (box) {
      box.appendChild(line);
      while (box.childNodes.length > 60) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    }
    try { console.log("[AI-SOLVER]", msg); } catch (e) {}
  }
  function setStatus(txt) { const el = document.getElementById("ais-status"); if (el) el.textContent = txt; }

  function buildUI() {
    if (document.getElementById(GUI_ID)) return;

    const style = document.createElement("style");
    style.textContent = [
      "#" + GUI_ID + " { position:fixed; right:12px; bottom:12px; z-index:2147483600;",
      "  width:min(94vw,320px); max-height:70vh; background:#0f172a; color:#e2e8f0;",
      "  border:1px solid #334155; border-radius:12px;",
      "  font:12px/1.4 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;",
      "  box-shadow:0 10px 30px rgba(0,0,0,.45); display:flex; flex-direction:column;",
      "  overflow:hidden; touch-action:manipulation; }",
      "#" + GUI_ID + " .ais-head { display:flex; align-items:center; justify-content:space-between;",
      "  padding:8px 10px; background:#1e293b; cursor:move; font-weight:700;",
      "  color:#38bdf8; user-select:none; }",
      "#" + GUI_ID + " .ais-head .ais-min { cursor:pointer; padding:0 6px; color:#94a3b8; }",
      "#" + GUI_ID + " .ais-body { padding:10px; overflow-y:auto; }",
      "#" + GUI_ID + " .ais-body.ais-hidden { display:none; }",
      "#" + GUI_ID + " .ais-row { display:flex; align-items:center; gap:6px; margin-bottom:7px; }",
      "#" + GUI_ID + " .ais-row > label { flex:0 0 74px; color:#94a3b8; }",
      "#" + GUI_ID + " .ais-row select,#" + GUI_ID + " .ais-row input[type=text],",
      "#" + GUI_ID + " .ais-row input[type=number],#" + GUI_ID + " .ais-row input:not([type]) {",
      "  flex:1; min-width:0; background:#1e293b; color:#e2e8f0; border:1px solid #334155;",
      "  border-radius:7px; padding:5px 7px; font-size:12px; }",
      "#" + GUI_ID + " .ais-check label { display:flex; align-items:center; gap:6px; color:#cbd5e1; }",
      "#" + GUI_ID + " .ais-btns { display:flex; gap:6px; margin:9px 0 6px; }",
      "#" + GUI_ID + " .ais-btns button { flex:1; padding:8px; border-radius:8px; border:0;",
      "  font-weight:700; font-size:12px; cursor:pointer; color:#fff; }",
      "#" + GUI_ID + " #ais-start { background:#16a34a; }",
      "#" + GUI_ID + " #ais-stop  { background:#dc2626; }",
      "#" + GUI_ID + " .ais-status { padding:5px 8px; background:#1e293b; border-radius:7px;",
      "  color:#38bdf8; font-weight:600; margin-bottom:6px; white-space:nowrap;",
      "  overflow:hidden; text-overflow:ellipsis; }",
      "#" + GUI_ID + " .ais-log { height:110px; overflow-y:auto; background:#020617;",
      "  border-radius:7px; padding:6px; font-family:ui-monospace,Consolas,monospace;",
      "  font-size:10.5px; border:1px solid #1e293b; }",
      "#" + GUI_ID + " .ais-line { color:#94a3b8; margin-bottom:2px; word-break:break-word; }",
      "#" + GUI_ID + " .ais-ok   { color:#4ade80; }",
      "#" + GUI_ID + " .ais-warn { color:#fbbf24; }",
      "#" + GUI_ID + " .ais-err  { color:#f87171; }",
      "#" + GUI_ID + " .ais-foot { margin-top:6px; text-align:center; color:#475569; font-size:10px; }"
    ].join("\n");
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = GUI_ID;

    let optHtml = "";
    for (let i = 0; i < MODEL_CHOICES.length; i++) {
      const m = MODEL_CHOICES[i];
      optHtml += '<option value="' + m + '">' + m + (m === DEFAULT_MODEL ? " (Mặc định)" : "") + "</option>";
    }

    root.innerHTML =
      '<div class="ais-head" id="ais-head">' +
        '<span>⚡ ai slover v38.7</span>' +
        '<span class="ais-min" id="ais-min">–</span>' +
      '</div>' +
      '<div class="ais-body" id="ais-body">' +
        '<div class="ais-row"><label>Model</label><select id="ais-model">' + optHtml + '</select></div>' +
        '<div class="ais-row"><label>Model khác</label><input id="ais-model-custom" type="text" placeholder="vd: gemini-2.5-flash"></div>' +
        '<div class="ais-row"><label>Chu kỳ (ms)</label><input id="ais-interval" type="number" min="1200" step="500"></div>' +
        '<div class="ais-row ais-check"><label><input id="ais-resolve" type="checkbox"> Làm lại câu đã đúng</label></div>' +
        '<div class="ais-row ais-check"><label><input id="ais-autosubmit" type="checkbox"> Tự nộp bài khi hết câu (nguy hiểm)</label></div>' +
        '<div class="ais-btns">' +
          '<button id="ais-start">▶ Start</button>' +
          '<button id="ais-stop">■ Stop</button>' +
        '</div>' +
        '<div class="ais-status" id="ais-status">Sẵn sàng</div>' +
        '<div class="ais-log" id="ais-log"></div>' +
        '<div class="ais-foot">v38.7 · đọc .question-option · không bấm Bỏ qua</div>' +
      '</div>';
    document.body.appendChild(root);

    const selModel  = document.getElementById("ais-model");
    const inpCustom = document.getElementById("ais-model-custom");
    const inpInt    = document.getElementById("ais-interval");
    const chkRes    = document.getElementById("ais-resolve");
    const chkAuto   = document.getElementById("ais-autosubmit");

    const savedModel = localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
    if (MODEL_CHOICES.indexOf(savedModel) >= 0) selModel.value = savedModel;
    else { selModel.value = DEFAULT_MODEL; inpCustom.value = savedModel; }
    inpCustom.value = localStorage.getItem(MODEL_CUSTOM_KEY) || inpCustom.value || "";
    inpInt.value    = String(getInterval());
    chkRes.checked  = getReSolveDone();
    chkAuto.checked = getAutoSubmit();

    selModel.addEventListener("change", function () {
      localStorage.setItem(MODEL_KEY, selModel.value);
      localStorage.removeItem(MODEL_WORKING);
      log("Model = " + selModel.value, "ok");
    });
    inpCustom.addEventListener("change", function () {
      const v = inpCustom.value.trim();
      if (v) localStorage.setItem(MODEL_CUSTOM_KEY, v);
      else localStorage.removeItem(MODEL_CUSTOM_KEY);
      localStorage.removeItem(MODEL_WORKING);
      log("Model custom = " + (v || "(trống)"), "ok");
    });
    inpInt.addEventListener("change", function () {
      const v = parseInt(inpInt.value, 10);
      if (!isNaN(v) && v >= 1200) localStorage.setItem(INTERVAL_KEY, String(v));
    });
    chkRes.addEventListener("change", function () {
      localStorage.setItem(RESOLVE_KEY, chkRes.checked ? "true" : "false");
    });
    chkAuto.addEventListener("change", function () {
      localStorage.setItem(AUTOSUBMIT_KEY, chkAuto.checked ? "true" : "false");
      if (chkAuto.checked) log("⚠ Đã bật tự nộp bài!", "warn");
    });

    document.getElementById("ais-start").addEventListener("click", e => { e.preventDefault(); start(); });
    document.getElementById("ais-stop").addEventListener("click",  e => { e.preventDefault(); stop();  });

    const bodyEl = document.getElementById("ais-body");
    const minEl  = document.getElementById("ais-min");
    minEl.addEventListener("click", function (e) {
      e.stopPropagation();
      bodyEl.classList.toggle("ais-hidden");
      minEl.textContent = bodyEl.classList.contains("ais-hidden") ? "+" : "–";
    });

    const head = document.getElementById("ais-head");
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    function startDrag(cx, cy) {
      dragging = true; sx = cx; sy = cy;
      const r = root.getBoundingClientRect(); ox = r.left; oy = r.top;
      root.style.right = "auto"; root.style.bottom = "auto";
      root.style.left = ox + "px"; root.style.top = oy + "px";
    }
    function moveDrag(cx, cy) {
      if (!dragging) return;
      root.style.left = Math.max(0, Math.min(window.innerWidth  - 60, ox + (cx - sx))) + "px";
      root.style.top  = Math.max(0, Math.min(window.innerHeight - 40, oy + (cy - sy))) + "px";
    }
    head.addEventListener("mousedown", e => startDrag(e.clientX, e.clientY));
    head.addEventListener("touchstart", e => { const p = e.touches[0]; startDrag(p.clientX, p.clientY); }, { passive: true });
    document.addEventListener("mousemove", e => moveDrag(e.clientX, e.clientY));
    document.addEventListener("touchmove", e => { const p = e.touches[0]; moveDrag(p.clientX, p.clientY); if (dragging) e.preventDefault(); }, { passive: false });
    document.addEventListener("mouseup", () => dragging = false);
    document.addEventListener("touchend", () => dragging = false);

    log("GUI sẵn sàng · default: " + DEFAULT_MODEL, "ok");
  }

  function boot() {
    if (document.body) buildUI();
    else setTimeout(boot, 200);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

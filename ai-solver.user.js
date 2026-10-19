// ==UserScript==
// @name         AI Solver v38.4 (DeepSeek V4 Flash)
// @namespace    https://github.com/memaygayy/QuG6ok8gR0FZ
// @version      38.4.0
// @description  Auto solve onluyen.vn — DeepSeek V4 Flash default, re-check + re-select on wrong
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

  /* ============================== CONFIG ============================== */
  const VERSION          = "38.4.0";
  const GUI_ID           = "ai-solver-v38";
  const PROXY_URL        = "https://gen.pollinations.ai/v1/chat/completions";
  const POLL_KEY         = "sk_D8PP0K4jFUDUa0zjrx7uxq1XM1ZoVINK";

  const MODEL_KEY        = "HW_SOLVER_MODEL_V2";
  const MODEL_CUSTOM_KEY = "HW_SOLVER_MODEL_CUSTOM";
  const INTERVAL_KEY     = "HW_SOLVER_INTERVAL";
  const RESOLVE_KEY      = "HW_SOLVER_RE_SOLVE_DONE";

  const DEFAULT_MODEL    = "deepseek/deepseek-v4-flash";
  const FALLBACK_MODELS  = ["deepseek", "gemini"];
  const MODEL_CHOICES = [
    "deepseek/deepseek-v4-flash",
    "deepseek",
    "gemini",
    "openai",
    "claude"
  ];

  const RE_CHECK_ROUNDS  = 3;    // số vòng kiểm tra lại việc chọn đáp án
  const MAX_ANSWER_RETRY = 2;    // số lần chọn lại khi bị sai
  const API_TIMEOUT      = 35000;
  const NEXT_WAIT        = 7000;

  /* =============================== STATE ============================== */
  const state = {
    running: false,
    busy: false,
    lastSig: "",
    sameSigCount: 0,
    cache: new Map(),
    timers: []
  };

  function getInterval() {
    const v = parseInt(localStorage.getItem(INTERVAL_KEY), 10);
    return (isNaN(v) || v < 1200) ? 3500 : v;
  }
  function getReSolveDone() {
    return localStorage.getItem(RESOLVE_KEY) !== "false";
  }
  function getModel() {
    const custom = (localStorage.getItem(MODEL_CUSTOM_KEY) || "").trim();
    if (custom) return custom;
    return localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
  }

  /* =============================== UTILS ============================== */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    if (parseFloat(st.opacity) < 0.05) return false;
    return true;
  }

  function insideGui(el) {
    const gui = document.getElementById(GUI_ID);
    return !!(gui && el && gui.contains(el));
  }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function cleanText(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
    const cls = typeof el.className === "string" ? el.className : "";
    if (/\b(disabled|is-disabled|btn-disabled|btn--disabled)\b/i.test(cls)) return true;
    try { if (getComputedStyle(el).pointerEvents === "none") return true; } catch (e) {}
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
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      if (desc && desc.set) desc.set.call(input, val);
      else input.checked = val;
    } catch (e) {
      try { input.checked = val; } catch (e2) {}
    }
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ============================ API LAYER ============================ */
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method:  opts.method || "GET",
          url:     opts.url,
          headers: opts.headers || {},
          data:    opts.data,
          timeout: opts.timeout || API_TIMEOUT,
          onload:  r => resolve(r),
          onerror: () => reject(new Error("network error")),
          ontimeout: () => reject(new Error("timeout")),
          onabort: () => reject(new Error("aborted"))
        });
      } catch (e) { reject(e); }
    });
  }

  async function askAI(messages, model) {
    const body = {
      model: model,
      messages: messages,
      temperature: 0.2,
      max_tokens: 900,
      private: true
    };
    const res = await gmRequest({
      method: "POST",
      url: PROXY_URL,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + POLL_KEY
      },
      data: JSON.stringify(body),
      timeout: API_TIMEOUT
    });
    if (res.status !== 200) {
      throw new Error("HTTP " + res.status + " " + (res.responseText || "").slice(0, 120));
    }
    let json;
    try { json = JSON.parse(res.responseText); }
    catch (e) { throw new Error("bad json"); }
    const content = json && json.choices && json.choices[0] &&
                    json.choices[0].message && json.choices[0].message.content;
    if (!content) throw new Error("empty response");
    return content;
  }

  async function askWithFallback(messages, model) {
    const queue = [model].concat(FALLBACK_MODELS.filter(m => m !== model));
    let lastErr = null;
    for (let i = 0; i < queue.length; i++) {
      const m = queue[i];
      try {
        const text = await askAI(messages, m);
        if (i > 0) log("Fallback → " + m, "warn");
        return text;
      } catch (e) {
        lastErr = e;
        log("Model " + m + " lỗi: " + e.message, "warn");
        const fatal = !/not found|404|unsupported|invalid model|empty|bad json/i.test(e.message);
        if (fatal) break;
      }
    }
    throw lastErr || new Error("API failed");
  }

  /* ============================ AI PROMPT ============================ */
  function buildMessages(stem, optTexts, prevWrong) {
    const letters = optTexts.map((_, i) => String.fromCharCode(65 + i));
    const list = optTexts.map((t, i) => letters[i] + ". " + t).join("\n");
    const sys = [
      "Bạn là trợ lý giải bài tập trắc nghiệm.",
      "Chọn đáp án đúng nhất cho câu hỏi.",
      "Trả lời ĐÚNG định dạng, không thêm gì khác:",
      "ĐÁP ÁN: <chữ cái, nhiều đáp án cách nhau dấu phẩy>",
      "GIẢI THÍCH: <1-2 câu ngắn gọn>"
    ].join("\n");

    let user = "Câu hỏi:\n" + stem + "\n\nCác lựa chọn:\n" + list + "\n\nChọn đáp án đúng.";
    if (prevWrong && prevWrong.length) {
      user += "\n\nLƯU Ý: đáp án " + prevWrong.join(", ") + " đã bị SAI. Bắt buộc chọn đáp án KHÁC.";
    }
    return [
      { role: "system", content: sys },
      { role: "user",   content: user }
    ];
  }

  function parseAnswer(text, count) {
    const out = new Set();
    let seg = "";
    const m = String(text).match(/ĐÁP\s*ÁN\s*[:：]/i);
    if (m) {
      const rest = text.slice(m.index + m[0].length);
      seg = rest.split("\n")[0];
    } else {
      const lines = String(text).split("\n");
      seg = lines.find(l => /[A-F]/.test(l)) || String(text);
    }
    const found = (seg.toUpperCase().match(/\b[A-F]\b/g) || []);
    found.forEach(ch => {
      const i = ch.charCodeAt(0) - 65;
      if (i >= 0 && i < count) out.add(i);
    });
    if (!out.size) {
      const fb = (String(text).toUpperCase().match(/(?:^|[\s:.,(])([A-F])(?=[\s.,)\n]|$)/g) || []);
      fb.forEach(tok => {
        const ch = tok.trim().replace(/[^A-F]/g, "");
        if (ch.length === 1) {
          const i = ch.charCodeAt(0) - 65;
          if (i >= 0 && i < count) out.add(i);
        }
      });
    }
    return Array.from(out).sort((a, b) => a - b);
  }

  /* ========================= DOM DETECTION =========================== */
  const OPTION_SELECTORS = [
    ".answer-item",
    ".answers .item",
    ".list-answer .item",
    ".answer-list .item",
    ".option-item",
    ".choices .item",
    ".choice-item",
    ".question-item .answer",
    ".question .answer",
    ".answer",
    ".option"
  ];

  const SUBMIT_RE = /(nộp|kiểm tra|submit|check|hoàn thành|xác nhận)/i;
  const NEXT_RE   = /(câu tiếp|tiếp theo|câu sau|next|tiếp|sau)/i;

  function isButtonLike(n) {
    const t = cleanText(n).toLowerCase();
    return /^(nộp bài|nộp|kiểm tra|tiếp|câu tiếp|câu tiếp theo|next|submit|start|stop|gửi)$/.test(t);
  }

  function getOptionNodes() {
    let best = [];
    for (let s = 0; s < OPTION_SELECTORS.length; s++) {
      const sel = OPTION_SELECTORS[s];
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
      nodes = nodes.filter(n => !insideGui(n) && isVisible(n) && !isButtonLike(n));
      if (!nodes.length) continue;
      // bỏ node cha nếu nó chứa node khác trong danh sách
      const innermost = nodes.filter(n => !nodes.some(m => m !== n && n.contains(m)));
      if (innermost.length >= 2) { best = innermost; break; }
    }
    return best;
  }

  function getStem(options) {
    if (!options || !options.length) return "";
    let anc = options[0];
    let guard = 0;
    while (anc && !options.every(o => anc.contains(o)) && guard++ < 30) {
      anc = anc.parentElement;
    }
    if (!anc) return "";
    let cur = anc;
    for (let i = 0; i < 4; i++) {
      if (cleanText(cur).length > 60) break;
      if (!cur.parentElement || cur.parentElement === document.body) break;
      cur = cur.parentElement;
    }
    const full = cleanText(cur);
    const optTexts = options.map(cleanText).filter(Boolean);
    let stem = full;
    for (let i = 0; i < optTexts.length; i++) {
      const idx = stem.indexOf(optTexts[i]);
      if (idx > 0) { stem = stem.slice(0, idx); break; }
    }
    stem = stem.trim();
    return stem.length >= 8 ? stem : full.slice(0, 1500);
  }

  function findButton(re) {
    const nodes = document.querySelectorAll(
      'button, a, div[role="button"], [class*="btn"], [class*="button"]'
    );
    const list = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.isConnected || insideGui(n) || !isVisible(n)) continue;
      const t = cleanText(n);
      if (!t || t.length > 40) continue;
      if (re.test(t)) list.push(n);
    }
    // chỉ giữ node trong cùng (không chứa node khác trong list)
    const inner = list.filter(n => !list.some(m => m !== n && n.contains(m)));
    if (!inner.length) return null;
    // ưu tiên nút có text ngắn nhất
    inner.sort((a, b) => cleanText(a).length - cleanText(b).length);
    return inner[0];
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
    if (isOptionSelected(el)) return true;   // đã chọn rồi → KHÔNG click lại (tránh bỏ chọn)

    const input = el.querySelector('input[type="radio"], input[type="checkbox"]');
    if (input) {
      try { input.click(); } catch (e) {}
      if (!input.checked) {
        setNativeChecked(input, true);
        input.dispatchEvent(new Event("input",  { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    if (!isOptionSelected(el)) clickEl(el);
    return isOptionSelected(el);
  }

  function detectFeedback(options) {
    const correct = new Set();
    const wrong   = new Set();
    const OK  = ["correct", "true", "right", "success", "dung", "đúng", "answer-correct", "is-correct"];
    const BAD = ["incorrect", "wrong", "false", "error", "sai", "answer-wrong", "is-wrong", "is-incorrect"];
    options.forEach((o, i) => {
      const cls = (typeof o.className === "string" ? o.className : "").toLowerCase();
      const parts = cls.split(/\s+/).filter(Boolean);
      if (parts.some(p => OK.indexOf(p) >= 0))  correct.add(i);
      if (parts.some(p => BAD.indexOf(p) >= 0)) wrong.add(i);
    });
    return { correct, wrong };
  }

  /* ============================ APPLY / VERIFY ======================= */
  async function applySelection(indices) {
    for (let round = 1; round <= RE_CHECK_ROUNDS; round++) {
      const opts = getOptionNodes();
      if (!opts.length) return false;

      for (let k = 0; k < indices.length; k++) {
        const el = opts[indices[k]];
        if (el && !isOptionSelected(el)) selectOption(el);
      }
      await sleep(180 * round);

      const after = getOptionNodes();
      let okCount = 0;
      for (let k = 0; k < indices.length; k++) {
        const el = after[indices[k]];
        if (el && isOptionSelected(el)) okCount++;
      }
      if (okCount === indices.length) return true;
      log("Kiểm tra lại " + round + "/" + RE_CHECK_ROUNDS + ": " + okCount + "/" + indices.length + " đã chọn", "warn");
    }
    return false;
  }

  async function clickSubmitBtn() {
    const btn = findButton(SUBMIT_RE);
    if (!btn || isDisabled(btn)) return false;
    clickEl(btn);
    log("Đã bấm nút nộp/kiểm tra", "ok");
    return true;
  }

  async function waitForChange(oldSig, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || NEXT_WAIT)) {
      await sleep(250);
      const opts = getOptionNodes();
      if (!opts.length) continue;
      const sig = hashStr(getStem(opts) + "||" + opts.map(cleanText).join("|"));
      if (sig && sig !== oldSig) return true;
    }
    return false;
  }

  async function advance(prevSig) {
    await sleep(350);

    const next = findButton(NEXT_RE);
    if (next && !isDisabled(next) && next.textContent.toLowerCase().indexOf("tiếp") >= 0) {
      clickEl(next);
      if (await waitForChange(prevSig, NEXT_WAIT)) return true;
      // thử lần 2
      const again = findButton(NEXT_RE);
      if (again && !isDisabled(again)) {
        clickEl(again);
        if (await waitForChange(prevSig, 5000)) return true;
      }
      return false;
    }

    const submit = findButton(SUBMIT_RE);
    if (submit && !isDisabled(submit)) {
      clickEl(submit);
      log("Đã nộp bài — hoàn tất.", "ok");
      setStatus("Hoàn tất");
      stop();
      return true;
    }
    return false;
  }

  /* ============================ SOLVE FLOW =========================== */
  async function reAsk(stem, optTexts, prevWrong) {
    const model = getModel();
    try {
      const text = await askWithFallback(buildMessages(stem, optTexts, prevWrong), model);
      return parseAnswer(text, optTexts.length);
    } catch (e) {
      log("Hỏi lại AI thất bại: " + e.message, "err");
      return [];
    }
  }

  async function solveCurrent() {
    const options = getOptionNodes();

    if (!options.length) {
      await handleEssay();
      return;
    }

    const stem     = getStem(options);
    const optTexts = options.map(cleanText);
    const sig      = hashStr(stem + "||" + optTexts.join("|"));

    if (sig === state.lastSig) {
      state.sameSigCount++;
    } else {
      state.lastSig = sig;
      state.sameSigCount = 0;
      setStatus("Câu mới");
    }
    if (state.sameSigCount > 4) {
      log("Câu này lặp quá nhiều lần — chuyển câu.", "warn");
      await advance(sig);
      state.sameSigCount = 0;
      return;
    }

    const fb0 = detectFeedback(options);
    const alreadyAnswered = fb0.correct.size > 0 || fb0.wrong.size > 0;

    // KHÔNG skip mặc định. Chỉ skip nếu người dùng tắt "làm lại câu đã đúng"
    if (alreadyAnswered && !getReSolveDone()) {
      log("Câu đã có đáp án — bỏ qua (bật 'Làm lại câu đã đúng' để giải lại).");
      await advance(sig);
      return;
    }

    log("Câu: " + stem.slice(0, 90).replace(/\n/g, " "));

    // ---- lấy đáp án AI (cache theo signature) ----
    let cached = state.cache.get(sig);
    let indices;
    if (cached) {
      indices = cached.slice();
      log("Dùng cache: " + indices.map(i => String.fromCharCode(65 + i)).join(", "));
    } else {
      setStatus("Đang hỏi AI...");
      const model = getModel();
      let text;
      try {
        text = await askWithFallback(buildMessages(stem, optTexts), model);
      } catch (e) {
        log("API lỗi: " + e.message, "err");
        setStatus("Lỗi API — thử lại sau");
        return;
      }
      indices = parseAnswer(text, optTexts.length);
      if (!indices.length) {
        log("Không đọc được đáp án từ AI — bỏ qua câu này.", "err");
        await advance(sig);
        return;
      }
      state.cache.set(sig, indices.slice());
      if (state.cache.size > 200) {
        const firstKey = state.cache.keys().next().value;
        state.cache.delete(firstKey);
      }
      log("AI chọn: " + indices.map(i => String.fromCharCode(65 + i)).join(", "), "ok");
    }

    // ---- vòng chọn + kiểm tra + chọn lại nếu sai ----
    let prevWrong = [];
    let attempt = 0;

    while (attempt <= MAX_ANSWER_RETRY) {
      setStatus("Đang chọn đáp án...");
      const applied = await applySelection(indices);
      if (!applied) {
        log("Không xác nhận được đáp án đã chọn.", "warn");
      }

      // kiểm tra feedback có sẵn trên DOM (câu đã từng nộp)
      let fb = detectFeedback(getOptionNodes());

      if (fb.wrong.size && indices.some(i => fb.wrong.has(i))) {
        prevWrong = prevWrong.concat(indices.map(i => String.fromCharCode(65 + i)));
        attempt++;
        if (attempt > MAX_ANSWER_RETRY) break;
        setStatus("Sai — xin đáp án khác...");
        log("Đáp án sai (" + prevWrong.join(", ") + ") → chọn lại", "warn");
        const next = await reAsk(stem, optTexts, prevWrong);
        if (!next.length) break;
        indices = next.filter(i => prevWrong.indexOf(String.fromCharCode(65 + i)) < 0);
        if (!indices.length) indices = next;
        state.cache.set(sig, indices.slice());
        continue;
      }

      if (fb.correct.size) {
        log("Đã đúng.", "ok");
        break;
      }

      // chưa có feedback → bấm nộp/kiểm tra
      const clicked = await clickSubmitBtn();
      if (!clicked) break;

      await sleep(750);
      fb = detectFeedback(getOptionNodes());

      if (fb.wrong.size && indices.some(i => fb.wrong.has(i))) {
        prevWrong = prevWrong.concat(indices.map(i => String.fromCharCode(65 + i)));
        attempt++;
        if (attempt > MAX_ANSWER_RETRY) break;
        setStatus("Sai — chọn lại...");
        log("Nộp xong bị sai → chọn đáp án khác", "warn");
        const next = await reAsk(stem, optTexts, prevWrong);
        if (!next.length) break;
        indices = next.filter(i => prevWrong.indexOf(String.fromCharCode(65 + i)) < 0);
        if (!indices.length) indices = next;
        state.cache.set(sig, indices.slice());
        continue;
      }
      break;
    }

    setStatus("Đang chuyển câu...");
    await advance(sig);
  }

  async function handleEssay() {
    const ta = Array.from(document.querySelectorAll("textarea"))
      .find(t => !insideGui(t) && isVisible(t));
    if (!ta) {
      log("Không thấy câu hỏi trắc nghiệm hoặc ô trả lời.", "warn");
      return;
    }
    if ((ta.value || "").trim().length > 3) {
      log("Ô trả lời đã có nội dung — chuyển câu.");
      const sig = hashStr(cleanText(ta) + "||essay");
      await advance(sig);
      return;
    }

    let box = ta.parentElement;
    for (let i = 0; i < 4 && box; i++) {
      if (cleanText(box).length > 40) break;
      box = box.parentElement;
    }
    const stem = cleanText(box || ta).slice(0, 1500);
    if (!stem) return;

    setStatus("Đang giải câu tự luận...");
    const model = getModel();
    const msgs = [
      { role: "system", content: "Bạn giải bài tập. Trả lời ngắn gọn, chính xác, không giải thích dài." },
      { role: "user", content: stem }
    ];

    try {
      const text = await askWithFallback(msgs, model);
      setNativeValue(ta, text.trim());
      log("Đã điền câu trả lời tự luận.", "ok");
      await sleep(300);
      const btn = findButton(SUBMIT_RE);
      if (btn && !isDisabled(btn)) {
        clickEl(btn);
        await sleep(700);
      }
      await advance(hashStr(stem + "||essay"));
    } catch (e) {
      log("Lỗi tự luận: " + e.message, "err");
    }
  }

  /* ============================== MAIN LOOP ========================== */
  async function tick() {
    if (!state.running || state.busy) return;
    state.busy = true;
    const started = Date.now();
    try {
      await solveCurrent();
    } catch (e) {
      log("Lỗi vòng lặp: " + (e && e.message ? e.message : e), "err");
    } finally {
      if (Date.now() - started > 90000) log("Vòng lặp chạy quá lâu — đã reset.", "warn");
      state.busy = false;
    }
    if (state.running) {
      state.timers.push(setTimeout(tick, getInterval()));
    }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.busy = false;
    state.sameSigCount = 0;
    setStatus("Đang chạy...");
    log("▶ Bắt đầu", "ok");
    tick();
  }

  function stop() {
    state.running = false;
    state.busy = false;
    state.timers.forEach(t => clearTimeout(t));
    state.timers = [];
    setStatus("Đã dừng");
    log("■ Dừng", "warn");
  }

  /* ================================ GUI ============================== */
  function log(msg, type) {
    const box = document.getElementById("ais-log");
    const line = document.createElement("div");
    line.className = "ais-line" + (type ? " ais-" + type : "");
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    const ss = String(t.getSeconds()).padStart(2, "0");
    line.textContent = "[" + hh + ":" + mm + ":" + ss + "] " + msg;
    if (box) {
      box.appendChild(line);
      while (box.childNodes.length > 60) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    }
    try { console.log("[AI-SOLVER]", msg); } catch (e) {}
  }

  function setStatus(txt) {
    const el = document.getElementById("ais-status");
    if (el) el.textContent = txt;
  }

  function buildUI() {
    if (document.getElementById(GUI_ID)) return;

    const style = document.createElement("style");
    style.textContent = `
      #${GUI_ID} {
        position: fixed; right: 12px; bottom: 12px; z-index: 2147483600;
        width: min(94vw, 320px); max-height: 70vh;
        background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 12px;
        font: 12px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        box-shadow: 0 10px 30px rgba(0,0,0,.45);
        display: flex; flex-direction: column; overflow: hidden;
        touch-action: manipulation;
      }
      #${GUI_ID} .ais-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 10px; background: #1e293b; cursor: move;
        font-weight: 700; color: #38bdf8; user-select: none;
      }
      #${GUI_ID} .ais-head .ais-min { cursor: pointer; padding: 0 6px; color: #94a3b8; }
      #${GUI_ID} .ais-body { padding: 10px; overflow-y: auto; }
      #${GUI_ID} .ais-body.ais-hidden { display: none; }
      #${GUI_ID} .ais-row { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; }
      #${GUI_ID} .ais-row > label { flex: 0 0 74px; color: #94a3b8; }
      #${GUI_ID} .ais-row select,
      #${GUI_ID} .ais-row input[type="text"],
      #${GUI_ID} .ais-row input[type="number"],
      #${GUI_ID} .ais-row input:not([type]) {
        flex: 1; min-width: 0; background: #1e293b; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 7px; padding: 5px 7px; font-size: 12px;
      }
      #${GUI_ID} .ais-check label { display: flex; align-items: center; gap: 6px; color: #cbd5e1; }
      #${GUI_ID} .ais-btns { display: flex; gap: 6px; margin: 9px 0 6px; }
      #${GUI_ID} .ais-btns button {
        flex: 1; padding: 8px; border-radius: 8px; border: 0; font-weight: 700;
        font-size: 12px; cursor: pointer; color: #fff;
      }
      #${GUI_ID} #ais-start { background: #16a34a; }
      #${GUI_ID} #ais-stop  { background: #dc2626; }
      #${GUI_ID} #ais-start:active, #${GUI_ID} #ais-stop:active { transform: scale(.97); }
      #${GUI_ID} .ais-status {
        padding: 5px 8px; background: #1e293b; border-radius: 7px;
        color: #38bdf8; font-weight: 600; margin-bottom: 6px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #${GUI_ID} .ais-log {
        height: 110px; overflow-y: auto; background: #020617; border-radius: 7px;
        padding: 6px; font-family: ui-monospace, Consolas, monospace; font-size: 10.5px;
        border: 1px solid #1e293b;
      }
      #${GUI_ID} .ais-line { color: #94a3b8; margin-bottom: 2px; word-break: break-word; }
      #${GUI_ID} .ais-ok   { color: #4ade80; }
      #${GUI_ID} .ais-warn { color: #fbbf24; }
      #${GUI_ID} .ais-err  { color: #f87171; }
      #${GUI_ID} .ais-foot {
        margin-top: 6px; text-align: center; color: #475569; font-size: 10px;
      }
    `;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = GUI_ID;

    const optHtml = MODEL_CHOICES.map(m =>
      '<option value="' + m + '">' + m + (m === DEFAULT_MODEL ? " (Mặc định)" : "") + "</option>"
    ).join("");

    root.innerHTML =
      '<div class="ais-head" id="ais-head">' +
        '<span class="ais-title">⚡ ai slover v38.4</span>' +
        '<span class="ais-min" id="ais-min">–</span>' +
      '</div>' +
      '<div class="ais-body" id="ais-body">' +
        '<div class="ais-row"><label>Model</label><select id="ais-model">' + optHtml + '</select></div>' +
        '<div class="ais-row"><label>Model khác</label><input id="ais-model-custom" type="text" placeholder="vd: gemini-2.5-flash"></div>' +
        '<div class="ais-row"><label>Chu kỳ (ms)</label><input id="ais-interval" type="number" min="1200" step="500"></div>' +
        '<div class="ais-row ais-check"><label><input id="ais-resolve" type="checkbox"> Làm lại câu đã đúng</label></div>' +
        '<div class="ais-btns">' +
          '<button id="ais-start">▶ Start</button>' +
          '<button id="ais-stop">■ Stop</button>' +
        '</div>' +
        '<div class="ais-status" id="ais-status">Sẵn sàng</div>' +
        '<div class="ais-log" id="ais-log"></div>' +
        '<div class="ais-foot">v38.4 · DeepSeek V4 Flash · Mobile Ready</div>' +
      '</div>';

    document.body.appendChild(root);

    // --- nạp giá trị đã lưu ---
    const selModel  = document.getElementById("ais-model");
    const inpCustom = document.getElementById("ais-model-custom");
    const inpInt    = document.getElementById("ais-interval");
    const chkRes    = document.getElementById("ais-resolve");

    const savedModel = localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
    if (MODEL_CHOICES.indexOf(savedModel) >= 0) selModel.value = savedModel;
    else { selModel.value = DEFAULT_MODEL; inpCustom.value = savedModel; }
    inpCustom.value = localStorage.getItem(MODEL_CUSTOM_KEY) || inpCustom.value || "";
    inpInt.value    = String(getInterval());
    chkRes.checked  = getReSolveDone();

    // --- sự kiện ---
    selModel.addEventListener("change", function () {
      localStorage.setItem(MODEL_KEY, selModel.value);
      log("Model = " + selModel.value, "ok");
    });
    inpCustom.addEventListener("change", function () {
      const v = inpCustom.value.trim();
      if (v) localStorage.setItem(MODEL_CUSTOM_KEY, v);
      else localStorage.removeItem(MODEL_CUSTOM_KEY);
      log("Model custom = " + (v || "(trống)"), "ok");
    });
    inpInt.addEventListener("change", function () {
      const v = parseInt(inpInt.value, 10);
      if (!isNaN(v) && v >= 1200) localStorage.setItem(INTERVAL_KEY, String(v));
    });
    chkRes.addEventListener("change", function () {
      localStorage.setItem(RESOLVE_KEY, chkRes.checked ? "true" : "false");
    });

    document.getElementById("ais-start").addEventListener("click", function (e) {
      e.preventDefault(); start();
    });
    document.getElementById("ais-stop").addEventListener("click", function (e) {
      e.preventDefault(); stop();
    });

    // --- thu nhỏ ---
    const bodyEl = document.getElementById("ais-body");
    const minEl  = document.getElementById("ais-min");
    minEl.addEventListener("click", function (e) {
      e.stopPropagation();
      bodyEl.classList.toggle("ais-hidden");
      minEl.textContent = bodyEl.classList.contains("ais-hidden") ? "+" : "–";
    });

    // --- kéo panel ---
    const head = document.getElementById("ais-head");
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    function down(e) {
      const p = e.touches ? e.touches[0] : e;
      dragging = true;
      sx = p.clientX; sy = p.clientY;
      const r = root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      root.style.right = "auto"; root.style.bottom = "auto";
      root.style.left = ox + "px"; root.style.top = oy + "px";
    }
    function move(e) {
      if (!dragging) return;
      const p = e.touches ? e.touches[0] : e;
      const nx = Math.max(0, Math.min(window.innerWidth  - 60, ox + (p.clientX - sx)));
      const ny = Math.max(0, Math.min(window.innerHeight - 40, oy + (p.clientY - sy)));
      root.style.left = nx + "px"; root.style.top = ny + "px";
      if (e.touches) e.preventDefault();
    }
    function up() { dragging = false; }

    head.addEventListener("mousedown", down);
    head.addEventListener("touchstart", down, { passive: true });
    document.addEventListener("mousemove", move);
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("mouseup", up);
    document.addEventListener("touchend", up);

    log("GUI sẵn sàng · model mặc định: " + DEFAULT_MODEL, "ok");
  }

  /* =============================== INIT ============================== */
  function boot() {
    if (document.body) buildUI();
    else setTimeout(boot, 200);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

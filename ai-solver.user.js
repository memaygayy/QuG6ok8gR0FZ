// ==UserScript==
// @name         AI Solver v39.0
// @namespace    https://onluyen.vn/
// @version      39.0.0
// @description  Tự động giải trắc nghiệm + tự luận onluyen.vn / app.onluyen.vn
// @match        https://*.onluyen.vn/*
// @match        https://onluyen.vn/*
// @grant        GM_xmlhttpRequest
// @connect      pollinations.ai
// @connect      gen.pollinations.ai
// @connect      *
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/memaygayy/QuG6ok8gR0FZ/main/ai-solver.user.js
// @downloadURL  https://raw.githubusercontent.com/memaygayy/QuG6ok8gR0FZ/main/ai-solver.user.js
// ==/UserScript==

(function () {
  "use strict";

  /* ============================ CONFIG ============================ */
  const VERSION_STR      = "39.0.0";
  const GUI_ID           = "ai-solver-v38";
  const PROXY_URL        = "https://gen.pollinations.ai/v1/chat/completions";
  const POLL_KEY         = "sk_D8PP0K4jFUDUa0zjrx7uxq1XM1ZoVINK";

  const MODEL_KEY        = "HW_SOLVER_MODEL_V2";
  const MODEL_CUSTOM_KEY = "HW_SOLVER_MODEL_CUSTOM";
  const MODEL_WORKING    = "HW_SOLVER_MODEL_WORKING";
  const INTERVAL_KEY     = "HW_SOLVER_INTERVAL";
  const RESOLVE_KEY      = "HW_SOLVER_RE_SOLVE_DONE";
  const AUTOSUBMIT_KEY   = "HW_SOLVER_AUTO_SUBMIT";
  const VERIFY_KEY       = "HW_SOLVER_VERIFY";

  const DEFAULT_MODEL    = "deepseek/deepseek-v4-flash";
  const FALLBACK_MODELS  = ["deepseek", "gemini", "openai"];
  const MODEL_CHOICES    = ["deepseek/deepseek-v4-flash", "deepseek", "gemini", "openai", "claude"];

  const MAX_OPTIONS      = 12;
  const API_TIMEOUT      = 35000;
  const MAX_APPLY_TRIES  = 3;
  const STUCK_LIMIT      = 6;

  const OPTION_SELECTORS = [
    "#test-step-question .question-option",
    ".question-option",
    ".answer-item",
    ".answers .item", ".list-answer .item", ".answer-list .item",
    ".option-item", ".choices .item", ".choice-item",
    ".question-item .answer", ".question .answer", ".answer"
  ];

  const BAD_BTN_RE  = /(bỏ qua|skip|nộp bài|nộp|xác nhận nộp|hủy|huỷ|cancel|thoát|đóng|close|báo lỗi)/i;
  const NEXT_RE     = /(câu tiếp|tiếp theo|câu sau|câu kế|kế tiếp|next)/i;
  const CHROME_SEL  = ".answer-sheet,.left-side,.submit-bar,.submit-button,.mobile-bottom-bar";

  /* ============================ STATE ============================ */
  const state = {
    running: false,
    busy: false,
    timer: null,
    interval: parseInt(load(INTERVAL_KEY, "1200"), 10) || 1200,
    model: load(MODEL_KEY, DEFAULT_MODEL) || DEFAULT_MODEL,
    customModel: load(MODEL_CUSTOM_KEY, "") || "",
    workingModel: load(MODEL_WORKING, "") || "",
    redoDone: load(RESOLVE_KEY, "1") !== "0",
    autoSubmit: load(AUTOSUBMIT_KEY, "0") === "1",
    verifyPasses: Math.min(3, Math.max(0, parseInt(load(VERIFY_KEY, "1"), 10) || 0)),
    lastSig: "",
    doneSig: "",
    stuck: 0,
    tries: 0,
    answered: 0
  };

  /* ============================ HELPERS ============================ */
  function load(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function qs(s, r) { try { return (r || document).querySelector(s); } catch (e) { return null; } }
  function qsa(s) { try { return Array.from(document.querySelectorAll(s)); } catch (e) { return []; } }
  function clean(s) {
    return String(s || "").replace(/\u00a0/g, " ").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }
  function insideGui(el) { return !!(el && el.closest && el.closest("#" + GUI_ID)); }
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    try { if (getComputedStyle(el).visibility === "hidden") return false; } catch (e) {}
    return true;
  }
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + "-" + s.length;
  }
  function stripFences(s) {
    return String(s || "").replace(/^\s*```[a-z]*\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  }
  function shortModel(m) { return String(m || "").split("/").pop(); }

  /* ============================ GUI ============================ */
  const CSS = `
#${GUI_ID}{position:fixed;top:10px;right:10px;width:332px;max-height:88vh;display:flex;flex-direction:column;
background:#0b1220;color:#e6edf7;border:1px solid #1e293b;border-radius:12px;z-index:2147483000;
font:12px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.5);overflow:hidden}
#${GUI_ID} .ais-head{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:#111c33;cursor:move;user-select:none}
#${GUI_ID} .ais-title{font-weight:700;font-size:12px;color:#7dd3fc}
#${GUI_ID} .ais-head button{background:#1e293b;color:#cbd5e1;border:0;border-radius:6px;width:22px;height:20px;cursor:pointer;font-size:12px;margin-left:4px}
#${GUI_ID} .ais-body{padding:8px 10px;overflow:auto}
#${GUI_ID} .ais-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
#${GUI_ID} .ais-row label{flex:0 0 86px;color:#94a3b8;font-size:11px}
#${GUI_ID} select,#${GUI_ID} input[type=text],#${GUI_ID} input[type=number]{flex:1;min-width:0;background:#111c33;
border:1px solid #24344d;color:#e6edf7;border-radius:6px;padding:4px 6px;font-size:11px}
#${GUI_ID} .ais-chk{display:flex;gap:6px;align-items:center;margin:4px 0;color:#cbd5e1;font-size:11px;cursor:pointer}
#${GUI_ID} .ais-actions{gap:6px;margin-top:8px}
#${GUI_ID} .ais-actions button{flex:1;border:0;border-radius:7px;padding:7px 0;font-weight:700;cursor:pointer;font-size:12px}
#${GUI_ID} #ais-start{background:#16a34a;color:#fff}
#${GUI_ID} #ais-stop{background:#334155;color:#e2e8f0}
#${GUI_ID} #ais-diag{background:#1d4ed8;color:#fff}
#${GUI_ID} .ais-status{margin:8px 0 5px;padding:6px 8px;background:#111c33;border-radius:7px;color:#93c5fd;font-size:11px}
#${GUI_ID} .ais-answer{padding:6px 8px;background:#0f2a1d;border:1px solid #14532d;border-radius:7px;
color:#86efac;font-size:11px;margin-bottom:6px;display:none;white-space:pre-wrap;word-break:break-word}
#${GUI_ID} .ais-log{height:150px;overflow:auto;background:#050a14;border:1px solid #16233a;border-radius:7px;
padding:5px 7px;font:11px/1.35 ui-monospace,Consolas,monospace;color:#9fb3c8;white-space:pre-wrap;word-break:break-word}
#${GUI_ID} .ais-foot{padding:5px 10px;background:#111c33;color:#64748b;font-size:10px;text-align:center}
#${GUI_ID}.ais-min .ais-body,#${GUI_ID}.ais-min .ais-foot{display:none}`;

  function buildGui() {
    if (document.getElementById(GUI_ID)) return;
    const st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);

    const root = document.createElement("div");
    root.id = GUI_ID;
    root.innerHTML = `
<div class="ais-head">
  <span class="ais-title">⚡ ai slover v39.0</span>
  <span><button data-act="min">–</button><button data-act="max">+</button></span>
</div>
<div class="ais-body">
  <div class="ais-row"><label>Model</label><select id="ais-model"></select></div>
  <div class="ais-row"><label>Model khác</label><input id="ais-custom" type="text" placeholder="vd: mistral"></div>
  <div class="ais-row"><label>Chu kỳ (ms)</label><input id="ais-interval" type="number" min="300" step="100"></div>
  <div class="ais-row"><label>Kiểm tra lại</label><input id="ais-verify" type="number" min="0" max="3" step="1"></div>
  <label class="ais-chk"><input type="checkbox" id="ais-redo"> Làm lại câu đã đúng</label>
  <label class="ais-chk"><input type="checkbox" id="ais-autosubmit"> Tự nộp bài khi hết câu (nguy hiểm)</label>
  <div class="ais-row ais-actions"><button id="ais-start">▶ Start</button><button id="ais-stop">■ Stop</button><button id="ais-diag">🔍 Chẩn đoán</button></div>
  <div class="ais-status" id="ais-status">Sẵn sàng.</div>
  <div class="ais-answer" id="ais-answer"></div>
  <div class="ais-log" id="ais-log"></div>
</div>
<div class="ais-foot">v39.0 · chống kẹt · tự luận chỉ khi thấy ô nhập · có chẩn đoán</div>`;
    document.body.appendChild(root);

    const sel = root.querySelector("#ais-model");
    MODEL_CHOICES.forEach(m => {
      const o = document.createElement("option");
      o.value = m; o.textContent = m; sel.appendChild(o);
    });
    if (!MODEL_CHOICES.includes(state.model)) {
      const o = document.createElement("option");
      o.value = state.model; o.textContent = state.model; sel.appendChild(o);
    }
    sel.value = state.model;
    sel.addEventListener("change", () => { state.model = sel.value; save(MODEL_KEY, state.model); });

    const custom = root.querySelector("#ais-custom");
    custom.value = state.customModel;
    custom.addEventListener("input", () => { state.customModel = custom.value.trim(); save(MODEL_CUSTOM_KEY, state.customModel); });

    const inter = root.querySelector("#ais-interval");
    inter.value = state.interval;
    inter.addEventListener("change", () => {
      state.interval = Math.max(300, parseInt(inter.value, 10) || 1200);
      inter.value = state.interval; save(INTERVAL_KEY, String(state.interval));
    });

    const ver = root.querySelector("#ais-verify");
    ver.value = state.verifyPasses;
    ver.addEventListener("change", () => {
      state.verifyPasses = Math.min(3, Math.max(0, parseInt(ver.value, 10) || 0));
      ver.value = state.verifyPasses; save(VERIFY_KEY, String(state.verifyPasses));
    });

    const redo = root.querySelector("#ais-redo");
    redo.checked = state.redoDone;
    redo.addEventListener("change", () => { state.redoDone = redo.checked; save(RESOLVE_KEY, redo.checked ? "1" : "0"); });

    const asub = root.querySelector("#ais-autosubmit");
    asub.checked = state.autoSubmit;
    asub.addEventListener("change", () => { state.autoSubmit = asub.checked; save(AUTOSUBMIT_KEY, asub.checked ? "1" : "0"); });

    root.querySelector("#ais-start").addEventListener("click", start);
    root.querySelector("#ais-stop").addEventListener("click", stop);
    root.querySelector("#ais-diag").addEventListener("click", diagnose);
    root.querySelector('[data-act="min"]').addEventListener("click", () => root.classList.add("ais-min"));
    root.querySelector('[data-act="max"]').addEventListener("click", () => root.classList.remove("ais-min"));

    const head = root.querySelector(".ais-head");
    let drag = null;
    head.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      const r = root.getBoundingClientRect();
      drag = { x: e.clientX - r.left, y: e.clientY - r.top };
      root.style.left = r.left + "px"; root.style.top = r.top + "px";
      root.style.right = "auto"; root.style.bottom = "auto";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      root.style.left = Math.max(0, e.clientX - drag.x) + "px";
      root.style.top = Math.max(0, e.clientY - drag.y) + "px";
    });
    window.addEventListener("mouseup", () => { drag = null; });
  }

  function log(msg) {
    const el = document.getElementById("ais-log");
    const line = "[" + new Date().toLocaleTimeString("vi-VN") + "] " + msg;
    if (el) {
      const d = document.createElement("div");
      d.textContent = line;
      el.appendChild(d);
      while (el.childElementCount > 80) el.removeChild(el.firstChild);
      el.scrollTop = el.scrollHeight;
    }
    console.log("[AI-SOLVER] " + msg);
  }
  function setStatus(s) { const el = document.getElementById("ais-status"); if (el) el.textContent = s; }
  function setAnswer(s) {
    const el = document.getElementById("ais-answer");
    if (!el) return;
    el.style.display = "block";
    el.textContent = s;
  }

  /* ============================ DOM ĐỌC ĐỀ ============================ */
  function getQuestionNumber() {
    const el = qs("#test-step-question .question-header .num") || qs(".question-header .num");
    return el ? clean(el.innerText) : "";
  }
  function getPassage() {
    const el = qs("#test-step-question .question-text") || qs(".question-text");
    return el ? clean(el.innerText) : "";
  }
  function getStem() {
    const el = qs("#test-step-question .question-name") || qs(".question-name") || qs(".question-stem");
    return el ? clean(el.innerText) : "";
  }
  function optionText(el) {
    const c = el.querySelector(".question-option-content,.option-content,.content,p");
    return clean(c ? c.innerText : el.innerText);
  }
  function isUsableOption(el) {
    if (!el || insideGui(el)) return false;
    if (el.closest(".answer-sheet")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    return optionText(el).length > 0 || !!el.querySelector("input");
  }
  function getOptionEls() {
    for (const sel of OPTION_SELECTORS) {
      const list = qsa(sel).filter(isUsableOption);
      if (list.length >= 2) return list.slice(0, MAX_OPTIONS);
    }
    return [];
  }
  function isSelected(el) {
    if (!el) return false;
    const inp = el.querySelector('input[type="checkbox"],input[type="radio"]');
    if (inp && inp.checked) return true;
    if (el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true") return true;
    const cls = String(el.className || "");
    if (/(^|\s)(selected|checked|active|highlighted|chosen)(\s|$)/.test(cls)) return true;
    if (/is-(selected|checked|active|correct)/.test(cls)) return true;
    return false;
  }
  function snapshot(el) {
    const inp = el.querySelector('input[type="checkbox"],input[type="radio"]');
    return String(el.className || "") + "|" + (inp ? inp.checked : "") + "|" +
      el.getAttribute("aria-checked") + "|" + el.getAttribute("aria-selected");
  }
  // CHỈ nhận ô tự luận khi nó đang hiển thị — tránh nhầm với textarea ẩn (báo lỗi...) làm bỏ qua trắc nghiệm
  function getEssayTextarea() {
    const a = qs("#test-step-questiontextarea");
    if (a && !insideGui(a) && isVisible(a) && !a.disabled && !a.readOnly) return a;
    const scope = qs("#test-step-question") || document;
    const list = Array.from(scope.querySelectorAll("textarea")).filter(t =>
      !insideGui(t) && isVisible(t) && !t.disabled && !t.readOnly && !t.closest(CHROME_SEL));
    return list[0] || null;
  }
  function counterValue(keyword) {
    const fields = qsa(".left-side .report .field,.report .field");
    for (const f of fields) {
      const n = clean((f.querySelector(".field-name") || {}).innerText || "").toLowerCase();
      if (n.indexOf(keyword) >= 0) {
        const v = clean((f.querySelector(".field-value") || {}).innerText || "");
        const m = v.match(/\d+/);
        if (m) return parseInt(m[0], 10);
      }
    }
    return -1;
  }
  function answeredCount() { return counterValue("đã làm"); }
  function isFinished() {
    const opts = qsa(".answer-sheet .option");
    if (opts.length && opts.filter(o => o.classList.contains("done")).length >= opts.length) return true;
    return counterValue("chưa làm") === 0;
  }
  function questionSignature(opts) {
    return hash(
      getQuestionNumber() + "|" +
      getStem().slice(0, 200) + "|" +
      (opts || []).map(el => optionText(el).slice(0, 50)).join("§")
    );
  }
  function currentSig() {
    const opts = getOptionEls();
    if (opts.length) return questionSignature(opts);
    if (getEssayTextarea()) return questionSignature([]);
    return "";
  }

  /* ============================ API ============================ */
  function postJSON(url, body) {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": "Bearer " + POLL_KEY
    };
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let settled = false, lastErr = "";
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };

      const tryGM = () => {
        if (typeof GM_xmlhttpRequest !== "function") {
          return done(reject, new Error(lastErr || "fetch failed"));
        }
        try {
          GM_xmlhttpRequest({
            method: "POST", url, headers, data, timeout: API_TIMEOUT,
            onload: (r) => {
              if (r.status >= 200 && r.status < 300) done(resolve, r.responseText);
              else done(reject, new Error("HTTP " + r.status + " " + trunc(r.responseText || "", 100)));
            },
            onerror: () => done(reject, new Error("GM network error")),
            ontimeout: () => done(reject, new Error("GM timeout"))
          });
        } catch (e) { done(reject, new Error("GM error: " + e.message)); }
      };

      let ctl = null;
      try { ctl = new AbortController(); } catch (e) {}
      const to = setTimeout(() => { try { ctl && ctl.abort(); } catch (e) {} }, API_TIMEOUT);

      fetch(url, { method: "POST", headers, body: data, signal: ctl ? ctl.signal : undefined })
        .then(async (r) => {
          clearTimeout(to);
          const t = await r.text();
          if (r.ok) return done(resolve, t);
          lastErr = "HTTP " + r.status;
          tryGM();
        })
        .catch((e) => {
          clearTimeout(to);
          lastErr = (e && e.name === "AbortError") ? "fetch timeout" : "fetch failed";
          tryGM();
        });
    });
  }

  async function callModel(model, messages) {
    const text = await postJSON(PROXY_URL, { model, messages, temperature: 0.15, max_tokens: 800 });
    let json;
    try { json = JSON.parse(text); }
    catch (e) { throw new Error("JSON hỏng: " + trunc(text, 80)); }
    if (json && json.error) throw new Error(json.error.message || "API error");
    const content = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : "";
    if (!content || !String(content).trim()) throw new Error("empty response");
    return String(content).trim();
  }

  function currentModel() {
    const c = (state.customModel || "").trim();
    return c || state.model || DEFAULT_MODEL;
  }
  function modelChain() {
    const out = [];
    const push = (m) => { m = String(m || "").trim(); if (m && out.indexOf(m) < 0) out.push(m); };
    push(currentModel());
    push(state.workingModel);
    FALLBACK_MODELS.forEach(push);
    return out;
  }
  function rememberWorking(m) {
    if (!m || m === state.workingModel) return;
    state.workingModel = m;
    save(MODEL_WORKING, m);
  }

  /* ============================ PARSE ĐÁP ÁN ============================ */
  function parseAnswerObj(raw, count) {
    const text = String(raw || "");
    let json = null;
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try { json = JSON.parse(text.slice(a, b + 1)); } catch (e) { json = null; }
    }
    let tokens = null, explain = "";
    if (json && json.answer != null) {
      tokens = Array.isArray(json.answer) ? json.answer : [json.answer];
      explain = String(json.explain || json.explanation || json.reason || json.why || "");
    } else {
      const m = text.match(/(?:đáp án|dap an|answer|chọn|chon)\s*[:\-–]?\s*([A-La-l0-9][A-La-l0-9,\s\/\-]*)/i);
      if (m) tokens = m[1].split(/[,\s\/\-]+/).filter(Boolean);
    }
    if (!tokens) return null;

    const idxs = [];
    for (const tk of tokens) {
      const t = String(tk).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!t) continue;
      let i = -1;
      if (t.length === 1 && /[A-Z]/.test(t)) i = t.charCodeAt(0) - 65;
      else if (/^\d+$/.test(t)) i = parseInt(t, 10) - 1;
      if (i >= 0 && i < count && idxs.indexOf(i) < 0) idxs.push(i);
    }
    if (!idxs.length) return null;
    idxs.sort((x, y) => x - y);
    return { idxs, explain, raw: idxs.map(i => String.fromCharCode(65 + i)).join(",") };
  }

  function buildMcqMessages(ctx) {
    const lines = ctx.items.map((it, i) => String.fromCharCode(65 + i) + ". " + it.text).join("\n");
    let user = "";
    if (ctx.passage && ctx.passage !== ctx.stem) user += "Ngữ liệu:\n" + trunc(ctx.passage, 2200) + "\n\n";
    user += "Câu hỏi" + (ctx.number ? " (" + ctx.number + ")" : "") + ":\n" + trunc(ctx.stem, 2200) + "\n\n";
    user += "Các đáp án:\n" + lines + "\n\n";
    user += "Hãy chọn đáp án đúng nhất. Trả về DUY NHẤT JSON dạng:\n";
    user += '{"answer":"B","explain":"giải thích ngắn gọn bằng tiếng Việt"}\n';
    user += 'Nếu có nhiều đáp án đúng: {"answer":["A","C"],"explain":"..."}';
    return [
      { role: "system", content: "Bạn là giáo viên giỏi, giải bài tập chính xác. Chỉ trả về JSON, không thêm chữ nào khác." },
      { role: "user", content: user }
    ];
  }

  function buildVerifyMessages(ctx, proposal) {
    const lines = ctx.items.map((it, i) => String.fromCharCode(65 + i) + ". " + it.text).join("\n");
    let user = "";
    if (ctx.passage && ctx.passage !== ctx.stem) user += "Ngữ liệu:\n" + trunc(ctx.passage, 2000) + "\n\n";
    user += "Câu hỏi:\n" + trunc(ctx.stem, 2000) + "\n\nCác đáp án:\n" + lines + "\n\n";
    user += "Một ý kiến cho rằng đáp án là: " + proposal + ".\n";
    user += "Hãy kiểm tra thật kỹ. Nếu đúng thì giữ nguyên, nếu sai thì sửa.\n";
    user += 'Trả về DUY NHẤT JSON: {"answer":"X","explain":"lý do ngắn"}';
    return [
      { role: "system", content: "Bạn là người kiểm tra bài. Chỉ trả về JSON." },
      { role: "user", content: user }
    ];
  }

  function buildEssayMessages(ctx) {
    let user = "";
    if (ctx.passage && ctx.passage !== ctx.stem) user += "Ngữ liệu:\n" + trunc(ctx.passage, 2500) + "\n\n";
    user += "Đề bài:\n" + trunc(ctx.stem, 2500) + "\n\n";
    user += "Hãy trả lời/giải bài tự luận này bằng tiếng Việt, ngắn gọn nhưng đủ ý. ";
    user += "Viết thẳng nội dung câu trả lời, không thêm lời dẫn, không dùng markdown.";
    return [
      { role: "system", content: "Bạn là giáo viên, giải bài tự luận chính xác và súc tích bằng tiếng Việt." },
      { role: "user", content: user }
    ];
  }

  /* ============================ CHỌN ĐÁP ÁN ============================ */
  function fireMouse(el) {
    if (!el) return;
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(type => {
      try {
        const Ctor = type.indexOf("pointer") === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {}
    });
  }

  async function applyAnswer(opts, idxs) {
    const before = answeredCount();
    let changedAll = true;

    for (const i of idxs) {
      const el = opts[i];
      if (!el) { changedAll = false; continue; }
      if (isSelected(el)) continue;
      const snap = snapshot(el);
      try { el.scrollIntoView({ block: "center" }); } catch (e) {}
      try { el.click(); } catch (e) {}
      await sleep(400);
      if (isSelected(el) || snapshot(el) !== snap) continue;

      // click thường không có tác dụng → thử chuỗi sự kiện đầy đủ trên phần nội dung
      fireMouse(el.querySelector(".question-option-content") || el);
      await sleep(400);
      if (isSelected(el) || snapshot(el) !== snap) continue;

      const inp = el.querySelector('input[type="checkbox"],input[type="radio"]');
      if (inp) { try { inp.click(); } catch (e) {} await sleep(300); }
      if (!(isSelected(el) || snapshot(el) !== snap)) changedAll = false;
    }

    // câu 1 đáp án: bỏ các đáp án khác đang bị chọn nhầm
    if (idxs.length === 1 && isSelected(opts[idxs[0]])) {
      for (let i = 0; i < opts.length; i++) {
        if (i === idxs[0]) continue;
        if (isSelected(opts[i])) {
          log("Bỏ chọn đáp án thừa " + String.fromCharCode(65 + i));
          try { opts[i].click(); } catch (e) {}
          await sleep(350);
        }
      }
    }

    const after = answeredCount();
    const sel = idxs.every(i => opts[i] && isSelected(opts[i]));
    if (sel) return true;
    if (after >= 0 && before >= 0 && after > before) return true;
    return changedAll;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    try { el.focus(); } catch (e) {}
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  /* ============================ ĐIỀU HƯỚNG ============================ */
  function findNextButton() {
    const bar = qsa(".mobile-bottom-bar .nav-btn,.mobile-bottom-bar button");
    for (const b of bar) {
      if (b.querySelector(".fa-chevron-right") || /chevron-right/.test(String(b.className))) return b;
    }
    if (bar.length >= 2) return bar[bar.length - 1];

    for (const b of qsa("button,a.btn,.btn")) {
      if (insideGui(b) || b.closest(".answer-sheet") || b.closest(".submit-button")) continue;
      const t = clean(b.innerText || b.getAttribute("aria-label") || b.title || "");
      if (BAD_BTN_RE.test(t)) continue;
      if (b.querySelector(".fa-chevron-right")) return b;
      if (NEXT_RE.test(t)) return b;
    }
    return null;
  }

  function findSubmitButton() {
    return qs(".submit-button button") ||
      qsa("button").find(x => !insideGui(x) && /nộp bài/i.test(clean(x.innerText))) || null;
  }

  // Bấm "câu tiếp" đúng 1 lần rồi đợi tới khi câu thật sự đổi (không bấm dồn → không nhảy cóc)
  async function advance() {
    const oldSig = currentSig();
    const btn = findNextButton();
    if (!btn) { setStatus("Không thấy nút câu tiếp."); return false; }
    if (btn.disabled || btn.classList.contains("disabled")) { setStatus("Nút câu tiếp bị khoá (câu cuối?)."); return false; }
    btn.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      await sleep(250);
      const s = currentSig();
      if (s && s !== oldSig) { await sleep(300); return true; }
    }
    return false;
  }

  function finish(msg) {
    state.running = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    setStatus(msg);
    log(msg);
    if (state.autoSubmit && state.answered > 0) {
      const sb = findSubmitButton();
      if (sb) { log("Tự nộp bài (đã bật trong cài đặt)."); sb.click(); }
    }
  }

  /* ============================ VÒNG LẶP ============================ */
  async function step() {
    if (!state.redoDone && isFinished()) { finish("Đã hết câu (không còn câu chưa làm)."); return; }

    const opts = getOptionEls();
    if (opts.length >= 2) return stepMcq(opts);

    const ta = getEssayTextarea();
    if (ta) return stepEssay(ta);

    setStatus("Chưa thấy đáp án / ô tự luận… chờ trang render.");
  }

  function onNewQuestion(sig, info) {
    if (sig !== state.lastSig) {
      state.lastSig = sig;
      state.stuck = 0;
      state.tries = 0;
      log("▶ " + (getQuestionNumber() || "câu mới") + " · " + info);
    }
  }

  async function handleDone(sig) {
    state.stuck++;
    if (state.stuck >= STUCK_LIMIT) { finish("Đã làm hết — không sang được câu mới."); return; }
    await advance();
  }

  async function stepMcq(opts) {
    const sig = questionSignature(opts);
    onNewQuestion(sig, opts.length + " đáp án");
    if (sig === state.doneSig) return handleDone(sig);

    const already = opts.map((el, i) => isSelected(el) ? i : -1).filter(i => i >= 0);
    if (already.length && !state.redoDone) {
      log("Câu đã có đáp án — bỏ qua theo cài đặt.");
      state.doneSig = sig;
      await advance();
      return;
    }

    const ctx = {
      number: getQuestionNumber(),
      passage: getPassage(),
      stem: getStem(),
      items: opts.map((el, i) => ({ letter: String.fromCharCode(65 + i), text: optionText(el) }))
    };
    if (!ctx.stem && !ctx.passage) { setStatus("Chưa đọc được đề… chờ."); return; }

    setStatus("Đang hỏi AI…");
    let ans = null, usedModel = "";
    for (const model of modelChain()) {
      try {
        const raw = await callModel(model, buildMcqMessages(ctx));
        const parsed = parseAnswerObj(raw, ctx.items.length);
        if (!parsed) { log("⚠ " + shortModel(model) + " trả lời nhưng KHÔNG ra đáp án hợp lệ → thử model khác."); continue; }
        ans = parsed; usedModel = model; break;
      } catch (e) {
        log("✖ " + shortModel(model) + ": " + e.message);
      }
    }
    if (!ans) {
      setStatus("AI chưa trả lời được — sẽ thử lại.");
      log("Không model nào cho đáp án hợp lệ. Chưa bấm gì.");
      return;
    }
    rememberWorking(usedModel);
    log("AI (" + shortModel(usedModel) + ") → " + ans.raw + (ans.explain ? " · " + trunc(ans.explain, 90) : ""));
    setAnswer("Đáp án: " + ans.raw + (ans.explain ? " — " + trunc(ans.explain, 130) : ""));

    let finalAns = ans;
    for (let p = 0; p < state.verifyPasses; p++) {
      try {
        const raw = await callModel(usedModel, buildVerifyMessages(ctx, finalAns.raw));
        const parsed = parseAnswerObj(raw, ctx.items.length);
        if (!parsed) continue;
        if (parsed.raw !== finalAns.raw) log("↻ Kiểm tra lại đổi: " + finalAns.raw + " → " + parsed.raw);
        else log("✓ Kiểm tra lại đồng ý: " + parsed.raw);
        finalAns = parsed;
      } catch (e) {
        log("! Kiểm tra lại lỗi: " + e.message);
      }
    }

    // nếu DOM đã bị render lại trong lúc chờ AI → lấy lại danh sách đáp án
    let liveOpts = getOptionEls();
    if (liveOpts.length < 2 || questionSignature(liveOpts) !== sig) {
      log("Trang đã đổi câu trong lúc chờ AI — bỏ kết quả, làm lại.");
      return;
    }

    const ok = await applyAnswer(liveOpts, finalAns.idxs);
    state.tries++;
    if (ok) {
      log("✔ Đã chọn " + finalAns.raw);
      setAnswer("Đã chọn: " + finalAns.raw + (finalAns.explain ? " — " + trunc(finalAns.explain, 130) : ""));
      state.doneSig = sig;
      state.answered++;
      await sleep(300);
      await advance();
    } else if (state.tries >= MAX_APPLY_TRIES) {
      log("⚠ Bấm " + state.tries + " lần mà trang không phản hồi — coi như đã bấm, sang câu sau.");
      state.doneSig = sig;
      await advance();
    } else {
      log("⚠ Chưa xác nhận được " + finalAns.raw + " (lần " + state.tries + "/" + MAX_APPLY_TRIES + ") — thử lại.");
      setStatus("Trang chưa ghi nhận đáp án… thử lại.");
    }
  }

  async function stepEssay(ta) {
    const sig = questionSignature([]);
    onNewQuestion(sig, "tự luận");
    if (sig === state.doneSig) return handleDone(sig);

    if (clean(ta.value).length > 3 && !state.redoDone) {
      log("Tự luận đã có bài — bỏ qua theo cài đặt.");
      state.doneSig = sig;
      await advance();
      return;
    }

    const ctx = { passage: getPassage(), stem: getStem() || getPassage() };
    if (!ctx.stem) { setStatus("Chưa thấy đề tự luận… chờ."); return; }

    setStatus("Đang hỏi AI (tự luận)…");
    let text = "", usedModel = "";
    for (const model of modelChain()) {
      try {
        const raw = await callModel(model, buildEssayMessages(ctx));
        const t = stripFences(raw);
        if (t.length < 3) { log("⚠ " + shortModel(model) + " trả lời rỗng (tự luận) → thử model khác."); continue; }
        text = t; usedModel = model; break;
      } catch (e) {
        log("✖ " + shortModel(model) + ": " + e.message);
      }
    }
    if (!text) { setStatus("AI không trả lời được (tự luận)."); return; }

    rememberWorking(usedModel);
    log("AI (" + shortModel(usedModel) + ") tự luận: " + trunc(text, 120));
    setAnswer(trunc(text, 180));

    const liveTa = getEssayTextarea() || ta;
    setNativeValue(liveTa, text);
    await sleep(450);

    if (clean(liveTa.value).length > 3) {
      log("✔ Đã điền tự luận (" + liveTa.value.length + " ký tự).");
      state.doneSig = sig;
      state.answered++;
      await advance();
    } else {
      state.tries++;
      log("⚠ Chưa điền được vào ô tự luận (lần " + state.tries + ").");
      if (state.tries >= MAX_APPLY_TRIES) { state.doneSig = sig; await advance(); }
    }
  }

  async function tick() {
    if (!state.running || state.busy) return;
    state.busy = true;
    try {
      await step();
    } catch (e) {
      log("Lỗi vòng lặp: " + e.message);
    } finally {
      state.busy = false;
      if (state.running) state.timer = setTimeout(tick, state.interval);
    }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.busy = false;
    state.doneSig = "";
    state.lastSig = "";
    state.stuck = 0;
    state.tries = 0;
    state.answered = 0;
    setStatus("Đang chạy…");
    log("Start · model=" + currentModel() + " · chu kỳ=" + state.interval + "ms · kiểm tra lại=" + state.verifyPasses + " · làm lại câu đúng=" + state.redoDone);
    if (state.timer) clearTimeout(state.timer);
    tick();
  }

  function stop() {
    state.running = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    setStatus("Đã dừng.");
    log("Stop.");
  }

  /* ============================ CHẨN ĐOÁN ============================ */
  async function diagnose() {
    log("──── CHẨN ĐOÁN v" + VERSION_STR + " ────");
    log("URL: " + location.pathname);
    const opts = getOptionEls();
    log("Đáp án thấy: " + opts.length + (opts.length ? " (đang chọn: " + opts.map((e, i) => isSelected(e) ? String.fromCharCode(65 + i) : "").join("") + ")" : ""));
    const ta = getEssayTextarea();
    log("Ô tự luận hiển thị: " + (ta ? "CÓ" : "không"));
    log("Số câu: " + (getQuestionNumber() || "(không đọc được)") + " · đề dài " + getStem().length + " ký tự");
    log("Đã làm=" + answeredCount() + " · chưa làm=" + counterValue("chưa làm") + " · isFinished=" + isFinished());
    const nb = findNextButton();
    log("Nút câu tiếp: " + (nb ? "có" + (nb.disabled ? " (bị khoá)" : "") : "KHÔNG THẤY"));
    log("Cài đặt: redo=" + state.redoDone + " · verify=" + state.verifyPasses + " · running=" + state.running);
    log("Thử gọi AI…");
    for (const m of modelChain()) {
      try {
        const t0 = Date.now();
        const r = await callModel(m, [{ role: "user", content: "Trả lời đúng 1 từ: OK" }]);
        log("✔ " + shortModel(m) + " (" + (Date.now() - t0) + "ms): " + trunc(r, 40));
      } catch (e) {
        log("✖ " + shortModel(m) + ": " + e.message);
      }
    }
    log("──── HẾT CHẨN ĐOÁN ────");
  }

  /* ============================ BOOT ============================ */
  console.log("[AI-SOLVER] VERSION " + VERSION_STR + " booted at " + new Date().toISOString());
  function boot() {
    if (!document.body) return setTimeout(boot, 400);
    buildGui();
    log("v" + VERSION_STR + " sẵn sàng · model=" + currentModel());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

})();

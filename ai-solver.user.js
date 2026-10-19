// ==UserScript==
// @name         AI Solver v39.5
// @namespace    https://onluyen.vn/
// @version      39.5.0
// @description  Auto solve onluyen.vn - robust AI + page diagnostics
// @match        https://*.onluyen.vn/*
// @match        https://onluyen.vn/*
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

  /* ================= CONFIG ================= */
  const VERSION_STR = "39.5.0";
  const GUI_ID      = "ai-solver-v38";
  const PROXY_URL   = "https://gen.pollinations.ai/v1/chat/completions";
  const POLL_KEY    = "sk_D8PP0K4jFUDUa0zjrx7uxq1XM1ZoVINK";

  const MODEL_KEY        = "HW_SOLVER_MODEL_V2";
  const MODEL_CUSTOM_KEY = "HW_SOLVER_MODEL_CUSTOM";
  const MODEL_WORKING    = "HW_SOLVER_MODEL_WORKING";
  const INTERVAL_KEY     = "HW_SOLVER_INTERVAL";
  const VERIFY_KEY       = "HW_SOLVER_VERIFY";
  const AUTOSUBMIT_KEY   = "HW_SOLVER_AUTO_SUBMIT";
  const REDO_KEY         = "HW_SOLVER_REDO_DONE";

  const DEFAULT_MODEL  = "deepseek/deepseek-v4-flash";
  const FALLBACK_MODELS = ["deepseek", "openai", "openai-fast", "gemini"];
  const MODEL_CHOICES  = ["deepseek/deepseek-v4-flash", "deepseek", "gemini", "openai", "claude"];

  const MAX_OPTIONS   = 12;
  const API_TIMEOUT   = 35000;
  const WATCHDOG_MS   = 60000;
  const ASK_BUDGET_MS = 110000;

  const BAD_BTN_RE    = /(bỏ qua|skip|nộp bài|nộp|xác nhận nộp|hủy|huỷ|cancel|thoát|đóng|close|báo lỗi)/i;
  const NEXT_RE       = /(câu tiếp|câu sau|tiếp theo|câu kế|kế tiếp|next)/i;
  const ANSWER_BTN_RE = /(trả lời|làm bài|kiểm tra|xác nhận|gửi|lưu|answer)/i;

  /* ================= STATE ================= */
  const state = {
    running:  false,
    gen:      0,
    lastBeat: Date.now(),
    lastSig:  "",
    sameCount: 0,
    answered: 0,
  };

  const beat = () => { state.lastBeat = Date.now(); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
  const alive = (myGen) => state.running && myGen === state.gen;

  /* ================= LOG ================= */
  let logEl = null, statusEl = null, answerEl = null;

  function log(msg) {
    beat();
    const line = "[" + new Date().toLocaleTimeString("vi-VN") + "] " + msg;
    try { console.log("[AI-SOLVER]", msg); } catch (e) {}
    if (!logEl) return;
    const d = document.createElement("div");
    d.textContent = line;
    logEl.appendChild(d);
    while (logEl.childNodes.length > 150) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(s) { if (statusEl) statusEl.textContent = s; }
  function showAnswer(s) { if (answerEl) answerEl.textContent = s || "—"; }

  /* ================= DOM HELPERS ================= */
  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function insideGui(el) { return !!(el && el.closest && el.closest("#" + GUI_ID)); }

  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    if (!el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  }

  function isNoteArea(el) {
    if (!el || !el.closest) return false;
    return !!(el.closest(".popupNoteV2") || el.closest("#test-step-questionnoteTextarea"));
  }

  // CRITICAL: NEVER return `document`. Only return the real question container or null.
  function qRoot() {
    return $("#test-step-question")
        || $(".test-step-question")
        || $("app-test-school-step-data-regular .question-container")
        || $("app-test-school-step-data-regular")
        || null;
  }

  function qRootDiag() {
    const tries = ["#test-step-question", ".test-step-question",
                   ".question-container", "app-test-school-step-data-regular"];
    return tries.map((s) => s + "=" + ($(s) ? "✓" : "✗")).join(" ");
  }

  function getOptions() {
    const root = qRoot();
    if (!root) return [];
    return $$("#test-step-question div.question-option, .question-container div.question-option", root)
      .filter((el) => !insideGui(el));
  }

  function getFillInputs() {
    const root = qRoot();
    if (!root) return [];
    return $$('input[type="text"], input:not([type])', root).filter((el) =>
      !insideGui(el) && !isNoteArea(el) && !el.disabled && !el.readOnly &&
      !el.closest(".answer-sheet") && isVisible(el)
    );
  }

  function getEssayTextareas() {
    const root = qRoot();
    if (!root) return [];
    return $$("textarea", root).filter((el) =>
      !insideGui(el) && !el.disabled && !el.readOnly && !isNoteArea(el) &&
      el.id !== "test-step-questiontextarea" && isVisible(el)
    );
  }

  function getStemText() {
    const host = $("#test-step-question .question-name") || $(".question-name");
    const ctx  = $("#test-step-question .question-text") || $(".question-text");
    const a = host ? (host.innerText || host.textContent || "") : "";
    const b = ctx  ? (ctx.innerText  || ctx.textContent  || "") : "";
    return (a + "\n" + b).replace(/\n{3,}/g, "\n\n").trim().slice(0, 3000);
  }

  function stemWithBlanks(inputs) {
    const host = $("#test-step-question .question-name") || $(".question-name");
    if (!host) return getStemText();
    const clone = host.cloneNode(true);
    const cloneInputs = $$('input[type="text"], input:not([type])', clone)
      .filter((el) => !isNoteArea(el) && !el.disabled && !el.readOnly);
    cloneInputs.forEach((inp, i) => {
      const sp = document.createElement("span");
      sp.textContent = " [___" + (i + 1) + "___] ";
      if (inp.parentNode) inp.parentNode.replaceChild(sp, inp);
    });
    return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim().slice(0, 3000);
  }

  function optionLabel(opt) {
    const l = $(".question-option-label", opt);
    return l ? (l.textContent || "").trim() : "";
  }
  function optionText(opt) {
    const c = $(".question-option-content", opt);
    return c ? (c.innerText || c.textContent || "").trim() : (opt.innerText || "").trim();
  }

  function currentSignature() {
    const num = $("#test-step-question .question-header .num") || $(".question-header .num");
    const id  = num ? (num.textContent || "").trim().replace(/\s+/g, " ") : "";
    const st  = getStemText().slice(0, 80);
    return id + "|" + st;
  }

  function isSelected(opt) {
    const cls = (opt.className || "").toLowerCase();
    if (/(selected|checked|active|highlighted|chosen)/.test(cls)) return true;
    if (opt.getAttribute("aria-checked") === "true") return true;
    if (opt.getAttribute("aria-selected") === "true") return true;
    const inp = opt.querySelector('input[type="checkbox"], input[type="radio"]');
    if (inp && (inp.checked || inp.getAttribute("aria-checked") === "true")) return true;
    return false;
  }

  /* ================= TRANSPORT ================= */
  function extractContent(text) {
    let j = null;
    try { j = JSON.parse(text); } catch (e) {}
    if (j && typeof j === "object") {
      if (j.error) return "";
      const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof c === "string" && c.trim()) return c.trim();
      return "";
    }
    if (typeof text === "string" && text.trim() && text.trim()[0] !== "{") return text.trim();
    return "";
  }

  function extractError(text) {
    try {
      const j = JSON.parse(text);
      if (j && j.error) return String(j.error).slice(0, 140);
    } catch (e) {}
    return "";
  }

  async function fetchJSON(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, ms);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      const text = await res.text();
      return { ok: res.ok, status: res.status, text: text };
    } catch (e) {
      return { ok: false, error: "fetch:" + (e && e.message ? e.message : e) };
    } finally {
      clearTimeout(t);
    }
  }

  function gmRequest(url, body, ms) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== "function") return resolve({ ok: false, error: "no-gm" });
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; clearTimeout(guard); resolve(v); } };
      const guard = setTimeout(() => done({ ok: false, error: "gm-guard-timeout" }), ms + 6000);
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: url,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + POLL_KEY,
            "Accept": "application/json"
          },
          data: body,
          timeout: ms,
          onload:    (r) => done({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText }),
          onerror:   () => done({ ok: false, error: "gm-net" }),
          ontimeout: () => done({ ok: false, error: "gm-timeout" }),
          onabort:   () => done({ ok: false, error: "gm-abort" }),
        });
      } catch (e) { done({ ok: false, error: "gm-throw:" + e }); }
    });
  }

  function modelChain() {
    const chosen = (localStorage.getItem(MODEL_CUSTOM_KEY) || "").trim()
                || (localStorage.getItem(MODEL_KEY) || "").trim()
                || DEFAULT_MODEL;
    const working = (localStorage.getItem(MODEL_WORKING) || "").trim();
    const out = [];
    [chosen, working].concat(FALLBACK_MODELS).forEach((m) => {
      if (m && out.indexOf(m) === -1) out.push(m);
    });
    return out;
  }

  function setWorkingModel(m) {
    try { if (localStorage.getItem(MODEL_WORKING) !== m) localStorage.setItem(MODEL_WORKING, m); } catch (e) {}
  }

  let rawLogCount = 0;

  async function askAI(messages) {
    const models = modelChain();
    const deadline = Date.now() + ASK_BUDGET_MS;
    let lastErr = "unknown";

    for (let mi = 0; mi < models.length; mi++) {
      if (Date.now() > deadline) { lastErr = "budget-exceeded"; break; }
      const model = models[mi];

      for (let attempt = 0; attempt < 3; attempt++) {
        if (Date.now() > deadline) { lastErr = "budget-exceeded"; break; }
        beat();

        const payload = {
          model: model,
          messages: messages,
          temperature: 0.2,
          max_tokens: 800,
          stream: false,
        };
        if (attempt === 0) { payload.private = true; payload.referrer = "onluyen-solver"; }

        const body = JSON.stringify(payload);
        const headers = {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + POLL_KEY,
          "Accept": "application/json",
        };

        let r = await fetchJSON(PROXY_URL, { method: "POST", headers: headers, body: body }, API_TIMEOUT);

        if (!r || !r.ok || !r.text) {
          beat();
          const g = await gmRequest(PROXY_URL, body, API_TIMEOUT);
          if (g && g.ok && g.text) r = g;
          else if (g && g.error) lastErr = g.error;
        }

        if (r && r.ok && r.text) {
          const errMsg = extractError(r.text);
          if (errMsg) {
            lastErr = "API: " + errMsg;
          } else {
            const txt = extractContent(r.text);
            if (txt) {
              setWorkingModel(model);
              log("AI (" + model + ") OK");
              return { ok: true, text: txt, model: model };
            }
            lastErr = "empty";
            if (rawLogCount < 3) {
              rawLogCount++;
              log("RAW (rỗng) [" + model + "]: " + (r.text || "").slice(0, 220));
            }
          }
        } else if (r && r.error) {
          lastErr = r.error;
        } else if (r && r.status) {
          lastErr = "HTTP " + r.status;
        }

        log("↻ " + model + " lần " + (attempt + 1) + "/3 (lỗi: " + lastErr + ")");
        await sleep(600);
      }
    }
    return { ok: false, error: lastErr };
  }

  /* ================= PROMPTS ================= */
  function buildMcqMessages(opts) {
    const stem = getStemText();
    const lines = opts.slice(0, MAX_OPTIONS).map((o, i) => {
      const lb = optionLabel(o) || String.fromCharCode(65 + i);
      return lb + ". " + optionText(o);
    });
    return [
      { role: "system", content: "Bạn là giáo viên giải bài tập. Chỉ trả về JSON ngắn gọn, không giải thích ngoài JSON." },
      { role: "user", content:
        "Câu hỏi:\n" + stem + "\n\nCác đáp án:\n" + lines.join("\n") +
        "\n\nHãy chọn đúng 1 đáp án đúng nhất. Trả về đúng định dạng:\n" +
        '{"answer":"<chữ cái A/B/C/D>","explain":"<giải thích ngắn dưới 20 từ>"}'
      },
    ];
  }

  function buildFillMessages(stem, n) {
    return [
      { role: "system", content: "Bạn là giáo viên tiếng Anh. Chỉ trả về JSON, không giải thích ngoài JSON." },
      { role: "user", content:
        "Điền vào chỗ trống. Mỗi [___k___] là 1 ô cần điền. Có tất cả " + n + " ô.\n\n" + stem +
        "\n\nTrả về đúng định dạng:\n" +
        '{"answers":["<ô 1>","<ô 2>"]}\n' +
        "Chỉ điền đúng dạng từ cần thiết (chia thì/dạng từ), không thêm giải thích."
      },
    ];
  }

  function buildEssayMessages(stem) {
    return [
      { role: "system", content: "Bạn là giáo viên. Trả lời NGẮN GỌN, chỉ đưa đáp án, không lan man." },
      { role: "user", content:
        "Câu hỏi:\n" + stem +
        "\n\nTrả lời trực tiếp bằng nội dung cần điền/viết. Không mở đầu bằng 'Đáp án:', không thêm giải thích, không thêm bản dịch."
      },
    ];
  }

  function buildVerifyMessages(stem, chosenText) {
    return [
      { role: "system", content: "Bạn là người kiểm tra bài. Chỉ trả về JSON." },
      { role: "user", content:
        "Câu hỏi:\n" + stem + "\n\nĐáp án đang chọn: " + chosenText +
        "\n\nĐáp án này đúng hay sai? Trả về đúng định dạng:\n" +
        '{"ok":true|false,"answer":"<nếu sai thì đưa đáp án đúng, nếu đúng thì lặp lại đáp án>"}'
      },
    ];
  }

  /* ================= PARSING ================= */
  function parseAnswerObj(raw, opts) {
    const s = String(raw || "").trim();
    let obj = null;
    try {
      const m = s.match(/\{[\s\S]*\}/);
      if (m) obj = JSON.parse(m[0]);
    } catch (e) {}

    let key = "";
    if (obj && typeof obj === "object") {
      key = String(obj.answer || obj.correct || obj.letter || obj.choice || "").trim();
    }
    if (!key) {
      const mm = s.match(/\b([A-L])\b/);
      if (mm) key = mm[1];
    }
    key = key.toUpperCase().replace(/[^A-L]/g, "");
    if (!key) return null;

    let idx = -1;
    for (let i = 0; i < opts.length; i++) {
      if (optionLabel(opts[i]).toUpperCase().indexOf(key[0]) === 0) { idx = i; break; }
    }
    if (idx < 0) idx = key.charCodeAt(0) - 65;
    if (idx < 0 || idx >= opts.length) return null;

    return {
      index: idx,
      letter: optionLabel(opts[idx]) || String.fromCharCode(65 + idx),
      explain: (obj && (obj.explain || obj.explanation)) || "",
    };
  }

  function parseFillAnswers(raw, n) {
    const s = String(raw || "").trim();
    let arr = null;
    try {
      const m = s.match(/\{[\s\S]*\}/);
      if (m) {
        const o = JSON.parse(m[0]);
        if (Array.isArray(o.answers)) arr = o.answers;
        else if (Array.isArray(o.answer)) arr = o.answer;
        else if (typeof o.answer === "string") arr = [o.answer];
      }
    } catch (e) {}
    if (!arr) {
      const m2 = s.match(/\[[\s\S]*\]/);
      if (m2) { try { arr = JSON.parse(m2[0]); } catch (e) {} }
    }
    if (!arr) arr = s.split(/\s*\|\s*|\n+/);
    arr = arr.map((x) => String(x == null ? "" : x).trim().replace(/^["'“”]|["'“”]$/g, ""));
    while (arr.length < n) arr.push("");
    return arr.slice(0, Math.max(n, 1));
  }

  function extractBareAnswer(raw) {
    let s = String(raw || "").trim();
    s = s.split(/\n(?:Câu đúng|Giải thích|Dịch|Correct answer|Explanation)\s*[:：]/i)[0];
    s = s.replace(/^\s*(?:Đáp án|Answer|Trả lời)\s*[:：]\s*/i, "");
    s = s.replace(/\s*\([^()]*[\u00C0-\u1EF9][^()]*\)\s*$/u, "");
    s = s.replace(/^["'“”`]+|["'“”`]+$/g, "");
    return s.trim();
  }

  /* ================= DOM ACTIONS ================= */
  function typeInto(el, value) {
    if (!el) return false;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    try { el.focus(); } catch (e) {}
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    try { el.blur(); } catch (e) {}
    return String(el.value) === String(value);
  }

  async function applyAnswer(idx) {
    const opts = getOptions();
    const opt = opts[idx];
    if (!opt) return false;
    if (isSelected(opt)) return true;
    try { opt.scrollIntoView({ block: "center" }); } catch (e) {}
    await sleep(80);
    try { opt.click(); } catch (e) {}
    const inp = opt.querySelector('input[type="checkbox"], input[type="radio"]');
    if (inp && !inp.checked) { try { inp.click(); } catch (e) {} }
    await sleep(250);
    if (isSelected(opt)) return true;
    await sleep(200);
    try { opt.click(); } catch (e) {}
    await sleep(250);
    return isSelected(opt);
  }

  function submitBarButtons() {
    const bar = $(".submit-bar");
    if (!bar) return [];
    return $$("button", bar).filter((b) => !insideGui(b));
  }
  function submitBarTexts() {
    return submitBarButtons().map((b) => (b.textContent || "").trim().toUpperCase());
  }
  function logSubmitBar() {
    const t = submitBarTexts();
    log("submit-bar: " + (t.length ? "[" + t.join("] [") + "]" : "(trống)"));
  }

  async function findNewAnswerButton(before) {
    for (let i = 0; i < 10; i++) {
      const btns = submitBarButtons();
      for (let j = 0; j < btns.length; j++) {
        const b = btns[j];
        const t = (b.textContent || "").trim();
        if (!t) continue;
        if (BAD_BTN_RE.test(t)) continue;
        if (ANSWER_BTN_RE.test(t)) return b;
        if (before.indexOf(t.toUpperCase()) === -1) return b;
      }
      await sleep(250);
    }
    return null;
  }

  function clickSheetNext() {
    const opts = $$(".answer-sheet .option").filter((o) => !insideGui(o));
    if (!opts.length) return false;
    let idx = opts.findIndex((o) => o.classList.contains("active"));
    if (idx < 0) {
      idx = opts.findIndex((o) => !o.classList.contains("done"));
      if (idx < 0) return false;
      opts[idx].click();
      return true;
    }
    const next = opts[idx + 1];
    if (next) { next.click(); return true; }
    return false;
  }

  async function advance() {
    beat();
    if (clickSheetNext()) { await sleep(1000); beat(); return true; }

    const bar = $(".mobile-bottom-bar");
    if (bar) {
      const btns = $$("button.nav-btn", bar);
      for (let i = 0; i < btns.length; i++) {
        if (btns[i].querySelector(".fa-chevron-right")) {
          btns[i].click(); await sleep(1000); beat(); return true;
        }
      }
    }

    const cands = $$("button, a.btn").filter((b) =>
      !insideGui(b) && !b.closest(".submit-bar") && !b.closest(".submit-button") &&
      !b.closest(".left-side") && !b.closest(".mobile-bottom-bar") && isVisible(b)
    );
    for (let i = 0; i < cands.length; i++) {
      const t = (cands[i].textContent || "").trim();
      if (!t || BAD_BTN_RE.test(t)) continue;
      if (NEXT_RE.test(t)) { cands[i].click(); await sleep(1000); beat(); return true; }
    }
    return false;
  }

  function hasQuestion() {
    if (!qRoot()) return false;
    if (getOptions().length) return true;
    if (getFillInputs().length) return true;
    if (getEssayTextareas().length) return true;
    return false;
  }

  /* ================= STEPS ================= */
  async function stepMcq(opts, myGen) {
    if (!alive(myGen)) return;
    const sig = currentSignature();
    logSubmitBar();
    log("Tìm thấy " + opts.length + " đáp án | " + sig.slice(0, 60));

    const before = submitBarTexts();
    const stem = getStemText();

    const res = await askAI(buildMcqMessages(opts));
    if (!alive(myGen)) return;
    if (!res.ok) { log("❌ AI lỗi: " + res.error + " — thử lại sau 5s."); await sleep(5000); return; }

    const pick = parseAnswerObj(res.text, opts);
    if (!pick) { log("❌ Không đọc được đáp án: " + res.text.slice(0, 100)); await sleep(3000); return; }

    log("AI chọn " + pick.letter + " · " + (pick.explain || "").slice(0, 90));
    showAnswer(pick.letter + ". " + optionText(opts[pick.index]).slice(0, 120));

    let ok = await applyAnswer(pick.index);
    if (!alive(myGen)) return;
    log(ok ? ("Đã tick " + pick.letter + ".") : ("⚠ Không tick được " + pick.letter + " — thử lại."));
    if (!ok) ok = await applyAnswer(pick.index);

    const verifyN = getVerifyCount();
    for (let v = 0; v < verifyN; v++) {
      if (!alive(myGen)) return;
      beat();
      const chosen = optionLabel(opts[pick.index]) + ". " + optionText(opts[pick.index]);
      const vr = await askAI(buildVerifyMessages(stem, chosen));
      if (!alive(myGen)) return;
      if (!vr.ok) { log("… kiểm tra " + (v + 1) + " bỏ qua (" + vr.error + ")"); continue; }
      let needFix = false;
      try {
        const m = vr.text.match(/\{[\s\S]*\}/);
        if (m) { const o = JSON.parse(m[0]); if (o && o.ok === false) needFix = true; }
      } catch (e) {}
      if (needFix) {
        const np = parseAnswerObj(vr.text, opts);
        if (np && np.index !== pick.index) {
          log("↻ Kiểm tra sai — đổi sang " + np.letter);
          pick.index = np.index; pick.letter = np.letter;
          await applyAnswer(pick.index);
          continue;
        }
      }
      log("✓ Kiểm tra " + (v + 1) + " giữ: " + pick.letter);
    }

    const btn = await findNewAnswerButton(before);
    if (!alive(myGen)) return;
    if (btn) {
      const t = (btn.textContent || "").trim();
      btn.click();
      log('Bấm nút: "' + t + '"');
      await sleep(1300);
      beat();
    } else {
      log("⚠ Không thấy nút Trả lời trong submit-bar.");
    }

    if (currentSignature() === sig) { await advance(); }
    else { log("Trang tự chuyển câu."); await sleep(400); }
    state.answered++;
    setStatus("Đã làm " + state.answered + " câu");
  }

  async function stepFill(inputs, myGen) {
    if (!alive(myGen)) return;
    const sig = currentSignature();
    logSubmitBar();
    log("Phát hiện " + inputs.length + " ô điền từ.");
    const before = submitBarTexts();
    const stem = stemWithBlanks(inputs);

    const res = await askAI(buildFillMessages(stem, inputs.length));
    if (!alive(myGen)) return;
    if (!res.ok) { log("❌ AI lỗi: " + res.error + " — thử lại sau 5s."); await sleep(5000); return; }

    const answers = parseFillAnswers(res.text, inputs.length);
    log("AI điền từ → " + answers.join(" | "));

    let filled = 0;
    for (let i = 0; i < inputs.length; i++) {
      const v = (answers[i] || "").trim();
      if (!v) continue;
      if (typeInto(inputs[i], v)) filled++;
      await sleep(120);
    }
    log("Đã điền " + filled + "/" + inputs.length + " ô.");
    showAnswer(answers.filter(Boolean).join(" | "));

    if (!filled) { log("⚠ Không điền được ô nào — chuyển câu."); await advance(); return; }

    const btn = await findNewAnswerButton(before);
    if (!alive(myGen)) return;
    if (btn) {
      const t = (btn.textContent || "").trim();
      btn.click();
      log('Bấm nút: "' + t + '"');
      await sleep(1300);
      beat();
    } else {
      log("⚠ Không thấy nút Trả lời trong submit-bar.");
    }

    if (currentSignature() === sig) { await advance(); }
    else { log("Trang tự chuyển câu."); await sleep(400); }
    state.answered++;
    setStatus("Đã làm " + state.answered + " câu");
  }

  async function stepEssay(areas, myGen) {
    if (!alive(myGen)) return;
    const sig = currentSignature();
    logSubmitBar();
    log("Phát hiện " + areas.length + " ô tự luận.");
    const before = submitBarTexts();
    const stem = getStemText();

    const res = await askAI(buildEssayMessages(stem));
    if (!alive(myGen)) return;
    if (!res.ok) { log("❌ AI lỗi: " + res.error + " — thử lại sau 5s."); await sleep(5000); return; }

    const bare = extractBareAnswer(res.text);
    if (!bare) { log("❌ AI trả về rỗng."); await sleep(3000); return; }
    log("AI tự luận → " + bare.slice(0, 120));
    showAnswer(bare.slice(0, 200));

    const area = areas[0];
    const ok = typeInto(area, bare);
    log(ok ? ("Đã điền tự luận (" + bare.length + " ký tự).") : "⚠ Không điền được tự luận.");

    const btn = await findNewAnswerButton(before);
    if (!alive(myGen)) return;
    if (btn) {
      const t = (btn.textContent || "").trim();
      btn.click();
      log('Bấm nút: "' + t + '"');
      await sleep(1300);
      beat();
    } else {
      log("⚠ Không thấy nút Trả lời/Lưu cho tự luận.");
    }

    if (currentSignature() === sig) { await advance(); }
    else { log("Trang tự chuyển câu."); await sleep(400); }
    state.answered++;
    setStatus("Đã làm " + state.answered + " câu");
  }

  /* ================= LOOP ================= */
  function getInterval() {
    const v = parseInt(localStorage.getItem(INTERVAL_KEY) || "2500", 10);
    return isNaN(v) ? 2500 : Math.max(1200, v);
  }
  function getVerifyCount() {
    const v = parseInt(localStorage.getItem(VERIFY_KEY) || "1", 10);
    return isNaN(v) ? 1 : Math.max(0, Math.min(3, v));
  }

  async function loop() {
    const myGen = ++state.gen;
    beat();
    log("▶ Vòng lặp bắt đầu (gen " + myGen + ")");

    let noQ = 0;

    while (state.running && myGen === state.gen) {
      try {
        beat();

        if (!hasQuestion()) {
          noQ++;
          if (noQ === 1 || noQ % 5 === 0) {
            log("⏳ Chưa thấy câu hỏi (" + noQ + "/20) · " + qRootDiag());
          }
          if (noQ >= 20) {
            log("⚠ 30s không có câu hỏi — thử chuyển câu.");
            noQ = 0;
            const moved = await advance();
            if (!alive(myGen)) return;
            if (!moved) {
              log("❌ Không chuyển được câu — dừng. (Hard reload Ctrl+Shift+R rồi thử lại)");
              state.running = false;
              setStatus("Trang không có câu hỏi");
              break;
            }
            await sleep(1500);
            continue;
          }
          await sleep(1500);
          continue;
        }
        noQ = 0;

        const sig = currentSignature();
        if (sig === state.lastSig) state.sameCount++;
        else { state.lastSig = sig; state.sameCount = 0; }

        if (state.sameCount >= 3) {
          log("⚠ Kẹt ở câu này 3 lần — thử chuyển câu.");
          state.sameCount = 0;
          const moved = await advance();
          if (!alive(myGen)) return;
          if (!moved) { log("⚠ Không chuyển được câu — dừng."); state.running = false; setStatus("Hết câu / không chuyển được"); break; }
          await sleep(1200);
          continue;
        }

        const opts  = getOptions();
        const fills = opts.length ? [] : getFillInputs();
        const areas = (opts.length || fills.length) ? [] : getEssayTextareas();

        if (opts.length)        await stepMcq(opts, myGen);
        else if (fills.length)  await stepFill(fills, myGen);
        else if (areas.length)  await stepEssay(areas, myGen);

        if (!alive(myGen)) return;
        await sleep(getInterval());
      } catch (err) {
        log("❌ Lỗi vòng lặp: " + (err && err.message ? err.message : String(err)));
        await sleep(2000);
      }
    }

    log("■ Vòng lặp dừng (gen " + myGen + ")");
  }

  setInterval(() => {
    if (!state.running) return;
    const idle = Date.now() - state.lastBeat;
    if (idle > WATCHDOG_MS) {
      log("⚠ Không hoạt động " + Math.round(idle / 1000) + "s — tự khởi động lại vòng lặp.");
      state.gen++;
      state.lastBeat = Date.now();
      setTimeout(() => { if (state.running) loop(); }, 300);
    }
  }, 5000);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) log("⚠ Tab bị ẩn — trình duyệt có thể tạm dừng script (giữ tab hiện).");
    else { beat(); log("Tab hiện lại — tiếp tục."); }
  });

  /* ================= DIAGNOSTICS ================= */
  function checkPage() {
    log("=== KIỂM TRA TRANG ===");
    log("URL: " + location.href);
    ["#test-step-question",".test-step-question",".question-container",".question-name",
     ".question-option",".submit-bar",".answer-sheet",".mobile-bottom-bar",".question-text"].forEach((s) => {
      const els = $$(s);
      log("  " + s + ": " + (els.length ? ("×" + els.length) : "✗"));
    });
    const opts = getOptions();
    log("  Options: " + opts.length + (opts.length ? " (" + opts.map(optionLabel).join(",") + ")" : ""));
    log("  Fill inputs: " + getFillInputs().length);
    log("  Essay textareas: " + getEssayTextareas().length);
    const bar = submitBarTexts();
    log("  Submit-bar: " + (bar.length ? "[" + bar.join("] [") + "]" : "(trống)"));
    const sheet = $$(".answer-sheet .option");
    const done = sheet.filter((o) => o.classList.contains("done")).length;
    const aIdx = sheet.findIndex((o) => o.classList.contains("active"));
    log("  Answer-sheet: " + sheet.length + " (done: " + done + ", active: #" + (aIdx >= 0 ? (aIdx + 1) : "?") + ")");
    const stem = getStemText();
    log("  Stem: " + (stem ? stem.slice(0, 120).replace(/\s+/g, " ") : "(trống)"));
    log("======================");
  }

  async function testAI() {
    log("=== TEST AI ===");
    const model = localStorage.getItem(MODEL_CUSTOM_KEY) || localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
    log("Model: " + model);
    const body = JSON.stringify({
      model: model,
      messages: [{ role: "user", content: "Respond exactly with the word OK" }],
      temperature: 0.1,
      max_tokens: 20,
      stream: false
    });
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + POLL_KEY,
      "Accept": "application/json",
    };
    log("Gửi request...");
    let r = await fetchJSON(PROXY_URL, { method: "POST", headers: headers, body: body }, API_TIMEOUT);
    if (!r || !r.ok || !r.text) {
      const g = await gmRequest(PROXY_URL, body, API_TIMEOUT);
      if (g && (g.text || g.error)) r = g;
    }
    log("Status: " + (r && (r.status || r.error || "?")));
    log("RAW: " + ((r && r.text) || "(rỗng)").slice(0, 320));
    const ext = r && r.text ? extractContent(r.text) : "";
    log("Extracted: " + (ext || "(rỗng)"));
    log("======================");
  }

  /* ================= GUI ================= */
  function buildGui() {
    if (document.getElementById(GUI_ID)) return;

    const style = document.createElement("style");
    style.textContent = [
      "#" + GUI_ID + "{position:fixed;top:12px;right:12px;width:340px;max-height:86vh;z-index:2147483647;",
      "background:#0f172a;color:#e2e8f0;font:12px/1.45 system-ui,Segoe UI,Arial;border:1px solid #334155;",
      "border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}",
      "#" + GUI_ID + " .ais-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;",
      "background:#1e293b;cursor:move;user-select:none}",
      "#" + GUI_ID + " .ais-title{font-weight:700;color:#38bdf8}",
      "#" + GUI_ID + " .ais-head button{background:#334155;color:#e2e8f0;border:0;border-radius:6px;width:24px;height:22px;cursor:pointer}",
      "#" + GUI_ID + " .ais-body{padding:8px 10px;overflow:auto;display:flex;flex-direction:column;gap:6px}",
      "#" + GUI_ID + " .ais-row{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      "#" + GUI_ID + " .ais-row select,#" + GUI_ID + " .ais-row input{flex:1;min-width:0;background:#1e293b;color:#e2e8f0;",
      "border:1px solid #334155;border-radius:6px;padding:4px 6px;font-size:12px}",
      "#" + GUI_ID + " .ais-check{display:flex;align-items:center;gap:6px;font-size:11px;color:#cbd5e1}",
      "#" + GUI_ID + " .ais-actions{display:flex;gap:6px;margin-top:2px}",
      "#" + GUI_ID + " .ais-actions button{flex:1;padding:6px;border:0;border-radius:8px;cursor:pointer;font-weight:600;font-size:11px}",
      "#" + GUI_ID + " .ais-start{background:#16a34a;color:#fff}",
      "#" + GUI_ID + " .ais-stop{background:#dc2626;color:#fff}",
      "#" + GUI_ID + " .ais-check-b{background:#2563eb;color:#fff}",
      "#" + GUI_ID + " .ais-test-b{background:#9333ea;color:#fff}",
      "#" + GUI_ID + " .ais-status{color:#94a3b8;font-size:11px}",
      "#" + GUI_ID + " .ais-answer{background:#052e16;border:1px solid #166534;color:#bbf7d0;border-radius:8px;",
      "padding:6px;min-height:20px;word-break:break-word}",
      "#" + GUI_ID + " .ais-log{background:#020617;border:1px solid #1e293b;border-radius:8px;padding:6px;",
      "height:160px;overflow:auto;font:11px/1.4 ui-monospace,Consolas,monospace;color:#94a3b8;white-space:pre-wrap}",
      "#" + GUI_ID + " .ais-foot{padding:6px 10px;background:#1e293b;color:#64748b;font-size:10px;text-align:center}",
      "#" + GUI_ID + ".ais-collapsed .ais-body,#" + GUI_ID + ".ais-collapsed .ais-foot{display:none}",
    ].join("");
    document.head.appendChild(style);

    const box = document.createElement("div");
    box.id = GUI_ID;
    box.innerHTML =
      '<div class="ais-head"><span class="ais-title">⚡ ai slover v39.5</span>' +
      '<button class="ais-min" title="Thu nhỏ">–</button></div>' +
      '<div class="ais-body">' +
        '<label class="ais-row">Model<select class="ais-model"></select></label>' +
        '<label class="ais-row">Model khác<input class="ais-custom" type="text" placeholder="vd: openai"></label>' +
        '<label class="ais-row">Chu kỳ (ms)<input class="ais-interval" type="number" min="1200" step="500"></label>' +
        '<label class="ais-row">Kiểm tra lại<input class="ais-verify" type="number" min="0" max="3" step="1"></label>' +
        '<label class="ais-check"><input class="ais-redo" type="checkbox"> Làm lại câu đã đúng</label>' +
        '<label class="ais-check"><input class="ais-autosubmit" type="checkbox"> Tự nộp bài khi hết câu (nguy hiểm)</label>' +
        '<div class="ais-actions"><button class="ais-start">▶ Start</button><button class="ais-stop">■ Stop</button></div>' +
        '<div class="ais-actions"><button class="ais-check-b">🔍 Check page</button><button class="ais-test-b">🧪 Test AI</button></div>' +
        '<div class="ais-status">Chưa chạy</div>' +
        '<div class="ais-answer" id="ais-answer">—</div>' +
        '<div class="ais-log" id="ais-log"></div>' +
      '</div>' +
      '<div class="ais-foot">v39.5 · chống treo 60s · AI raw-log · qRoot null-safe · nút Check/Test</div>';

    document.body.appendChild(box);

    logEl    = $("#ais-log", box);
    statusEl = $(".ais-status", box);
    answerEl = $("#ais-answer", box);

    const sel = $(".ais-model", box);
    MODEL_CHOICES.forEach((m) => {
      const o = document.createElement("option");
      o.value = m; o.textContent = m;
      sel.appendChild(o);
    });

    const savedModel = localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
    if (MODEL_CHOICES.indexOf(savedModel) === -1) {
      const o = document.createElement("option");
      o.value = savedModel; o.textContent = savedModel;
      sel.appendChild(o);
    }
    sel.value = savedModel;
    sel.addEventListener("change", () => {
      localStorage.setItem(MODEL_KEY, sel.value);
      localStorage.removeItem(MODEL_CUSTOM_KEY);
      $(".ais-custom", box).value = "";
      log("Đổi model: " + sel.value);
    });

    const custom = $(".ais-custom", box);
    custom.value = localStorage.getItem(MODEL_CUSTOM_KEY) || "";
    custom.addEventListener("change", () => {
      const v = custom.value.trim();
      if (v) { localStorage.setItem(MODEL_CUSTOM_KEY, v); log("Model khác: " + v); }
      else { localStorage.removeItem(MODEL_CUSTOM_KEY); }
    });

    const intervalInp = $(".ais-interval", box);
    intervalInp.value = localStorage.getItem(INTERVAL_KEY) || "2500";
    intervalInp.addEventListener("change", () => {
      const v = Math.max(1200, parseInt(intervalInp.value, 10) || 2500);
      intervalInp.value = v;
      localStorage.setItem(INTERVAL_KEY, String(v));
    });

    const verifyInp = $(".ais-verify", box);
    verifyInp.value = localStorage.getItem(VERIFY_KEY) || "1";
    verifyInp.addEventListener("change", () => {
      const v = Math.max(0, Math.min(3, parseInt(verifyInp.value, 10) || 0));
      verifyInp.value = v;
      localStorage.setItem(VERIFY_KEY, String(v));
    });

    const redo = $(".ais-redo", box);
    redo.checked = localStorage.getItem(REDO_KEY) !== "0";
    redo.addEventListener("change", () => {
      localStorage.setItem(REDO_KEY, redo.checked ? "1" : "0");
    });

    const auto = $(".ais-autosubmit", box);
    auto.checked = localStorage.getItem(AUTOSUBMIT_KEY) === "1";
    auto.addEventListener("change", () => {
      localStorage.setItem(AUTOSUBMIT_KEY, auto.checked ? "1" : "0");
      if (auto.checked) log("⚠ Đã bật tự nộp bài — cẩn thận!");
    });

    $(".ais-start", box).addEventListener("click", start);
    $(".ais-stop", box).addEventListener("click", stop);
    $(".ais-check-b", box).addEventListener("click", checkPage);
    $(".ais-test-b", box).addEventListener("click", testAI);
    $(".ais-min", box).addEventListener("click", () => box.classList.toggle("ais-collapsed"));

    const head = $(".ais-head", box);
    let dragging = false, ox = 0, oy = 0;
    head.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      const r = box.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      box.style.left = Math.max(0, e.clientX - ox) + "px";
      box.style.top  = Math.max(0, e.clientY - oy) + "px";
      box.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { dragging = false; });

    log("GUI sẵn sàng. Bấm ▶ Start.");
  }

  function start() {
    if (state.running) { log("Đang chạy rồi."); return; }
    if (!qRoot()) log("⚠ Chưa thấy container câu hỏi — chờ trang render.");
    state.running = true;
    state.lastSig = "";
    state.sameCount = 0;
    state.answered = 0;
    state.lastBeat = Date.now();
    setStatus("Đang chạy...");
    log("Model chain: " + modelChain().join(" → "));
    loop();
  }

  function stop() {
    if (!state.running) { log("Chưa chạy."); return; }
    state.running = false;
    state.gen++;
    setStatus("Đã dừng");
    log("■ Đã dừng theo yêu cầu.");
  }

  /* ================= BOOT ================= */
  function boot() {
    buildGui();
    log("VERSION " + VERSION_STR + " booted at " + new Date().toISOString());
    log("URL: " + location.href);
    log("qRoot: " + (qRoot() ? "có container" : "chưa thấy (trang đang tải?)"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 800));
  } else {
    setTimeout(boot, 800);
  }
})();

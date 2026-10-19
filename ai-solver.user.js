// ==UserScript==
// @name         AI Solver v39.4
// @namespace    https://onluyen.vn/
// @version      39.4.0
// @description  Auto solve onluyen.vn (MCQ + fill + essay) - anti freeze watchdog
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
  const VERSION_STR = "39.4.0";
  const GUI_ID      = "ai-solver-v38";
  const PROXY_URL   = "https://gen.pollinations.ai/v1/chat/completions";
  const POLL_KEY    = "sk_D8PP0K4jFUDUa0zjrx7uxq1XM1ZoVINK";

  const MODEL_KEY        = "HW_SOLVER_MODEL_V2";
  const MODEL_CUSTOM_KEY = "HW_SOLVER_MODEL_CUSTOM";
  const MODEL_WORKING    = "HW_SOLVER_MODEL_WORKING";
  const INTERVAL_KEY     = "HW_SOLVER_INTERVAL";
  const VERIFY_KEY       = "HW_SOLVER_VERIFY";
  const AUTOSUBMIT_KEY   = "HW_SOLVER_AUTO_SUBMIT";

  const DEFAULT_MODEL  = "deepseek/deepseek-v4-flash";
  const FALLBACK_MODELS = ["deepseek", "gemini", "openai"];
  const MODEL_CHOICES  = ["deepseek/deepseek-v4-flash", "deepseek", "gemini", "openai", "claude"];

  const MAX_OPTIONS   = 12;
  const API_TIMEOUT   = 35000;   // 1 request
  const WATCHDOG_MS   = 60000;   // không beat quá 60s -> restart loop
  const ASK_BUDGET_MS = 110000;  // tổng ngân sách 1 lần hỏi AI

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
    while (logEl.childNodes.length > 120) logEl.removeChild(logEl.firstChild);
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
    return !!(el && el.closest && (el.closest(".popupNoteV2") || el.closest("#test-step-questionnoteTextarea")));
  }

  function qRoot() { return $("#test-step-question") || document; }

  function getOptions() {
    return $$("#test-step-question div.question-option").filter((el) => !insideGui(el));
  }

  function getFillInputs() {
    return $$('input[type="text"], input:not([type])', qRoot()).filter((el) =>
      !insideGui(el) && !isNoteArea(el) && !el.disabled && !el.readOnly &&
      !el.closest(".answer-sheet") && isVisible(el)
    );
  }

  function getEssayTextareas() {
    return $$("textarea", qRoot()).filter((el) =>
      !insideGui(el) && !el.disabled && !el.readOnly && !isNoteArea(el) &&
      el.id !== "test-step-questiontextarea" && isVisible(el)
    );
  }

  function getStemText() {
    const host = $("#test-step-question .question-name") || $("#step .question-name");
    const ctx  = $("#test-step-question .question-text");
    const a = host ? (host.innerText || host.textContent || "") : "";
    const b = ctx  ? (ctx.innerText  || ctx.textContent  || "") : "";
    return (a + "\n" + b).replace(/\n{3,}/g, "\n\n").trim().slice(0, 3000);
  }

  function stemWithBlanks(inputs) {
    const host = $("#test-step-question .question-name") || $("#step .question-name");
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
    const num = $("#test-step-question .question-header .num");
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
    try {
      const j = JSON.parse(text);
      const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof c === "string" && c.trim()) return c.trim();
      if (typeof j === "string") return j;
    } catch (e) {}
    if (typeof text === "string" && text.trim() && text.trim()[0] !== "{") return text.trim();
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
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + POLL_KEY },
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

  async function askAI(messages) {
    const models = modelChain();
    const deadline = Date.now() + ASK_BUDGET_MS;
    let lastErr = "unknown";

    for (let mi = 0; mi < models.length; mi++) {
      if (Date.now() > deadline) { lastErr = "budget-exceeded"; break; }
      const model = models[mi];
      const body = JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.2,
        max_tokens: 800,
        private: true,
        referrer: "onluyen-solver",
      });

      for (let attempt = 0; attempt < 2; attempt++) {
        if (Date.now() > deadline) { lastErr = "budget-exceeded"; break; }
        beat();

        let r = await fetchJSON(PROXY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + POLL_KEY },
          body: body,
        }, API_TIMEOUT);

        if (!r || !r.ok || !r.text) {
          beat();
          const g = await gmRequest(PROXY_URL, body, API_TIMEOUT);
          if (g && g.ok && g.text) r = g;
          else if (g && g.error) lastErr = g.error;
        }

        if (r && r.ok && r.text) {
          const txt = extractContent(r.text);
          if (txt) {
            setWorkingModel(model);
            log("AI (" + model + ") OK");
            return { ok: true, text: txt, model: model };
          }
          lastErr = "empty";
        } else if (r && r.error) {
          lastErr = r.error;
        } else if (r && r.status) {
          lastErr = "HTTP " + r.status;
        }

        log("↻ Thử lại model " + model + " (lỗi: " + lastErr + ")");
        await sleep(500);
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
    if (!$("#test-step-question")) return false;
    if (getOptions().length) return true;
    if (getFillInputs().length) return true;
    if (getEssayTextareas().length) return true;
    return false;
  }

  /* ================= STEPS ================= */
  async function stepMcq(opts) {
    const sig = currentSignature();
    logSubmitBar();
    log("Tìm thấy " + opts.length + " đáp án | " + sig.slice(0, 60));

    const before = submitBarTexts();
    const stem = getStemText();

    const res = await askAI(buildMcqMessages(opts));
    if (!res.ok) { log("❌ AI lỗi: " + res.error + " — thử lại sau 3s."); await sleep(3000); return; }

    const pick = parseAnswerObj(res.text, opts);
    if (!pick) { log("❌ Không đọc được đáp án AI: " + res.text.slice(0, 80)); await sleep(2500); return; }

    log("AI chọn " + pick.letter + " · " + (pick.explain || "").slice(0, 90));
    showAnswer(pick.letter + ". " + optionText(opts[pick.index]).slice(0, 120));

    let ok = await applyAnswer(pick.index);
    log(ok ? ("Đã tick " + pick.letter + ".") : ("⚠ Không tick được " + pick.letter + " — thử lại."));
    if (!ok) ok = await applyAnswer(pick.index);

    const verifyN = getVerifyCount();
    for (let v = 0; v < verifyN; v++) {
      beat();
      const chosen = optionLabel(opts[pick.index]) + ". " + optionText(opts[pick.index]);
      const vr = await askAI(buildVerifyMessages(stem, chosen));
      if (!vr.ok) { log("… kiểm tra " + (v + 1) + " bỏ qua (" + vr.error + ")"); continue; }
      let needFix = false;
      try {
        const m = vr.text.match(/\{[\s\S]*\}/);
        if (m) { const o = JSON.parse(m[0]); if (o && o.ok === false) needFix = true; }
      } catch (e) {}
      if (needFix) {
        const np = parseAnswerObj(vr.text, opts);
        if (np && np.index !== pick.index) {
          log("↻ Kiểm tra thấy sai — đổi sang " + np.letter);
          pick.index = np.index; pick.letter = np.letter;
          await applyAnswer(pick.index);
          continue;
        }
      }
      log("✓ Kiểm tra " + (v + 1) + " giữ: " + pick.letter);
    }

    const btn = await findNewAnswerButton(before);
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

  async function stepFill(inputs) {
    const sig = currentSignature();
    logSubmitBar();
    log("Phát hiện " + inputs.length + " ô điền từ.");
    const before = submitBarTexts();
    const stem = stemWithBlanks(inputs);

    const res = await askAI(buildFillMessages(stem, inputs.length));
    if (!res.ok) { log("❌ AI lỗi: " + res.error + " — thử lại sau 3s."); await sleep(3000); return; }

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

    if (!filled) { log("⚠ Không điền được ô nào — bỏ qua câu này."); await advance(); return; }

    const btn = await findNewAnswerButton(before);
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

  async function stepEssay(areas) {
    const sig = currentSignature();
    logSubmitBar();
    log("Phát hiện " + areas.length + " ô tự luận.");
    const before = submitBarTexts();
    const stem = getStemText();

    const res = await askAI(buildEssayMessages(stem));
    if (!res.ok) { log("❌ AI lỗi: " + res.error + " — thử lại sau 3s."); await sleep(3000); return; }

    const bare = extractBareAnswer(res.text);
    if (!bare) { log("❌ AI trả về rỗng."); await sleep(2500); return; }
    log("AI tự luận → " + bare.slice(0, 120));
    showAnswer(bare.slice(0, 200));

    const area = areas[0];
    const ok = typeInto(area, bare);
    log(ok ? ("Đã điền tự luận (" + bare.length + " ký tự).") : "⚠ Không điền được tự luận.");

    const btn = await findNewAnswerButton(before);
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

  /* ================= LOOP + WATCHDOG ================= */
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

    while (state.running && myGen === state.gen) {
      try {
        beat();

        if (!hasQuestion()) {
          log("Chưa thấy câu hỏi (trang đang tải)... chờ.");
          await sleep(1500);
          continue;
        }

        const sig = currentSignature();
        if (sig === state.lastSig) state.sameCount++;
        else { state.lastSig = sig; state.sameCount = 0; }

        if (state.sameCount >= 3) {
          log("⚠ Kẹt ở câu này 3 lần — thử chuyển câu.");
          state.sameCount = 0;
          const moved = await advance();
          if (!moved) { log("⚠ Không chuyển được câu — dừng."); state.running = false; setStatus("Hết câu / không chuyển được"); break; }
          await sleep(1200);
          continue;
        }

        const opts = getOptions();
        if (opts.length)            await stepMcq(opts);
        else {
          const fills = getFillInputs();
          if (fills.length)         await stepFill(fills);
          else {
            const areas = getEssayTextareas();
            if (areas.length)       await stepEssay(areas);
            else { log("Không xác định được dạng câu — chờ."); await sleep(1500); continue; }
          }
        }

        await sleep(getInterval());
      } catch (err) {
        log("❌ Lỗi vòng lặp: " + (err && err.message ? err.message : String(err)));
        await sleep(2000);
      }
    }

    log("■ Vòng lặp dừng (gen " + myGen + ")");
    if (state.running && myGen === state.gen) {
      // thoát bất thường -> tự chạy lại
      setTimeout(() => { if (state.running) loop(); }, 500);
    }
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

  /* ================= GUI ================= */
  function buildGui() {
    if (document.getElementById(GUI_ID)) return;

    const style = document.createElement("style");
    style.textContent = [
      "#" + GUI_ID + "{position:fixed;top:12px;right:12px;width:330px;max-height:86vh;z-index:2147483647;",
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
      "#" + GUI_ID + " .ais-actions button{flex:1;padding:6px;border:0;border-radius:8px;cursor:pointer;font-weight:600}",
      "#" + GUI_ID + " .ais-start{background:#16a34a;color:#fff}",
      "#" + GUI_ID + " .ais-stop{background:#dc2626;color:#fff}",
      "#" + GUI_ID + " .ais-status{color:#94a3b8;font-size:11px}",
      "#" + GUI_ID + " .ais-answer{background:#052e16;border:1px solid #166534;color:#bbf7d0;border-radius:8px;",
      "padding:6px;min-height:20px;word-break:break-word}",
      "#" + GUI_ID + " .ais-log{background:#020617;border:1px solid #1e293b;border-radius:8px;padding:6px;",
      "height:150px;overflow:auto;font:11px/1.4 ui-monospace,Consolas,monospace;color:#94a3b8;white-space:pre-wrap}",
      "#" + GUI_ID + " .ais-foot{padding:6px 10px;background:#1e293b;color:#64748b;font-size:10px;text-align:center}",
      "#" + GUI_ID + ".ais-collapsed .ais-body,#" + GUI_ID + ".ais-collapsed .ais-foot{display:none}",
    ].join("");
    document.head.appendChild(style);

    const box = document.createElement("div");
    box.id = GUI_ID;
    box.innerHTML =
      '<div class="ais-head"><span class="ais-title">⚡ ai slover v39.4</span>' +
      '<button class="ais-min" title="Thu nhỏ">–</button></div>' +
      '<div class="ais-body">' +
        '<label class="ais-row">Model<select class="ais-model"></select></label>' +
        '<label class="ais-row">Model khác<input class="ais-custom" type="text" placeholder="vd: openai"></label>' +
        '<label class="ais-row">Chu kỳ (ms)<input class="ais-interval" type="number" min="1200" step="500"></label>' +
        '<label class="ais-row">Kiểm tra lại<input class="ais-verify" type="number" min="0" max="3" step="1"></label>' +
        '<label class="ais-check"><input class="ais-redo" type="checkbox"> Làm lại câu đã đúng</label>' +
        '<label class="ais-check"><input class="ais-autosubmit" type="checkbox"> Tự nộp bài khi hết câu (nguy hiểm)</label>' +
        '<div class="ais-actions"><button class="ais-start">▶ Start</button><button class="ais-stop">■ Stop</button></div>' +
        '<div class="ais-status">Chưa chạy</div>' +
        '<div class="ais-answer" id="ais-answer">—</div>' +
        '<div class="ais-log" id="ais-log"></div>' +
      '</div>' +
      '<div class="ais-foot">v39.4 · điền từ (input) · chống nhảy cóc · chống treo (watchdog 60s)</div>';

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
    redo.checked = localStorage.getItem("HW_SOLVER_REDO_DONE") !== "0";
    redo.addEventListener("change", () => {
      localStorage.setItem("HW_SOLVER_REDO_DONE", redo.checked ? "1" : "0");
    });

    const auto = $(".ais-autosubmit", box);
    auto.checked = localStorage.getItem(AUTOSUBMIT_KEY) === "1";
    auto.addEventListener("change", () => {
      localStorage.setItem(AUTOSUBMIT_KEY, auto.checked ? "1" : "0");
      if (auto.checked) log("⚠ Đã bật tự nộp bài — cẩn thận!");
    });

    $(".ais-start", box).addEventListener("click", start);
    $(".ais-stop", box).addEventListener("click", stop);
    $(".ais-min", box).addEventListener("click", () => box.classList.toggle("ais-collapsed"));

    // drag
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
    buildGui();
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 800));
  } else {
    setTimeout(boot, 800);
  }
})();

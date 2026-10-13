// ==UserScript==
// @name         ai slover v38.2.0 (Stable + Mobile)
// @namespace    https://github.com/The-Lazybone/ONLUYEN-HOMEWORK-AUTO-SOLVER
// @version      38.2.0
// @author       The-Lazybone & Gemini
// @description  Stable AI homework solver — v21 flow + model switcher + mobile touch support + auto-update.
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=onluyen.vn
// @match        https://*.onluyen.vn/*
// @match        https://app.onluyen.vn/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      pollinations.ai
// @connect      gen.pollinations.ai
// @connect      *
// @updateURL    https://raw.githubusercontent.com/THE-LAZYBONE/ai-solver/main/ai-solver.user.js
// @downloadURL  https://raw.githubusercontent.com/THE-LAZYBONE/ai-solver/main/ai-solver.user.js
// ==/UserScript==

/* =====================================================================
   v38.2.0 — STABLE + MOBILE + GITHUB READY
   ---------------------------------------------------------------------
   ✅ Core: giữ nguyên v38.1 (endpoint gen.pollinations.ai, flow v21)
   🎯 Model: chỉ 4 preset gốc (openai / deepseek / gemini / claude)
   📱 Mobile: touch drag, responsive GUI, tap-friendly buttons
   🔄 Auto-update: @updateURL + @downloadURL — push GitHub là tự update
   ===================================================================== */

(function () {
  'use strict';

  console.log('[AI-Solver] ai slover v38.2.0 Injected! ~');

  const GUI_ID = 'ai-solver-v38';

  const CONFIG = {
    PROXY_URL: "https://gen.pollinations.ai/v1/chat/completions",
    POLL_KEY: "sk_D8PP0K4jFUDUa0zjrx7uxq1XM1ZoVINK",
    DEFAULT_MODEL: localStorage.getItem("HW_SOLVER_MODEL") || "openai",
    LOOP_INTERVAL_MS: parseInt(localStorage.getItem("HW_SOLVER_INTERVAL"), 10) || 4000,
    RE_SOLVE_DONE: localStorage.getItem("HW_SOLVER_RE_SOLVE_DONE") !== "false"
  };

  /* Chỉ 4 model gốc */
  const MODEL_PRESETS = [
    { value: "openai",   label: "🤖 OpenAI (Mặc định)" },
    { value: "deepseek", label: "🧠 DeepSeek Chat" },
    { value: "gemini",   label: "⚡ Google Gemini" },
    { value: "claude",   label: "🎭 Anthropic Claude" }
  ];

  const logger = {
    info:  (...a) => console.log('[HW-Solver][INFO]', ...a),
    warn:  (...a) => console.warn('[HW-Solver][WARN]', ...a),
    error: (...a) => console.error('[HW-Solver][ERROR]', ...a)
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* ================== UTILS ================== */
  function cleanQuestionText(raw) {
    if (!raw) return "";
    return String(raw)
      .replace(/Đáp án của bạn/gi, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (el.getClientRects().length === 0) return false;
    return true;
  }

  function escapeHtmlAttr(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function extractMCQAnswerLetter(rawResp) {
    if (!rawResp) return "";
    const text = String(rawResp).replace(/[*_`]/g, "").trim();
    if (!text) return "";

    let m = text.match(/(?:ĐÁP\s*ÁN|ANSWER|CHỌN|KẾT\s*QUẢ)[^\w]{0,10}\[?([A-D])\]?(?![A-Za-z])/i);
    if (m) return m[1].toUpperCase();

    m = text.match(/^\s*[\[\(]\s*([A-D])\s*[\]\)]/);
    if (m) return m[1].toUpperCase();

    m = text.match(/^\s*([A-D])\s*[\.\:\-\)]/m);
    if (m) return m[1].toUpperCase();

    m = text.match(/\b([A-D])\b/);
    if (m) return m[1].toUpperCase();

    m = text.match(/[A-D]/i);
    return m ? m[0].toUpperCase() : "";
  }

  /* ================== API CLIENT ================== */
  class APIClient {
    async call(prompt, systemPrompt) {
      const payload = {
        model: CONFIG.DEFAULT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: prompt }
        ],
        temperature: 0.0
      };

      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: CONFIG.PROXY_URL,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${CONFIG.POLL_KEY}`
          },
          data: JSON.stringify(payload),
          timeout: 60000,
          onload: function(res) {
            try {
              if (res.status !== 200) {
                return reject(new Error(`HTTP ${res.status}: ${(res.responseText || "").slice(0, 150)}`));
              }
              let content = "";
              try {
                const data = JSON.parse(res.responseText);
                if (data.choices && data.choices[0] && data.choices[0].message) {
                  content = data.choices[0].message.content;
                } else if (typeof data === "string") {
                  content = data;
                } else {
                  content = res.responseText;
                }
              } catch (jsonErr) {
                content = res.responseText;
              }
              if (!content || content.startsWith("<") || content.includes("<!DOCTYPE html>")) {
                return reject(new Error("Phản hồi HTML lỗi từ server."));
              }
              resolve(content.trim());
            } catch (e) {
              reject(new Error("Lỗi xử lý phản hồi: " + e.message));
            }
          },
          onerror:   () => reject(new Error("Lỗi kết nối mạng.")),
          ontimeout: () => reject(new Error("Yêu cầu quá thời gian chờ (60s)."))
        });
      });
    }
  }
  const apiClient = new APIClient();

  /* ================== SCRAPER ================== */
  class Scraper {
    _getActiveContainer() {
      const sel = '.test-step-question, app-test-school-step-data-regular, .question-container, app-question-mathplay-renderer';
      const all = document.querySelectorAll(sel);
      for (const el of all) {
        if (el.getClientRects().length > 0) return el;
      }
      return document.body;
    }

    detectQuestionType() {
      const container = this._getActiveContainer();
      let fullQuestionText = cleanQuestionText(container.innerText);

      const audioEl = container.querySelector('audio source, audio');
      if (audioEl && audioEl.src) {
        fullQuestionText = `[Audio Link: ${audioEl.src}]\n` + fullQuestionText;
      }

      const isDone = this.isCurrentQuestionDone();

      const inputEl = container.querySelector(
        'input[type="text"], input.can-resize-second, .answer-input input'
      );
      if (inputEl && isElementVisible(inputEl)) {
        return { type: "fill_in", question: fullQuestionText, inputElement: inputEl, container, isDone };
      }

      const tfSubItems = Array.from(container.querySelectorAll(
        '.child-content, app-question-true-false-item, .true-false-item'
      ));
      if (tfSubItems.length > 0) {
        const subQuestions = tfSubItems.map((item, idx) => {
          const charEl = item.querySelector('.option-char');
          const textEl = item.querySelector('.option-text');
          let char = charEl ? charEl.innerText.trim().replace(/[^a-d]/gi, '').toLowerCase() : "";
          if (!char) char = String.fromCharCode(97 + idx);
          const text = cleanQuestionText(textEl ? textEl.innerText : item.innerText);
          const trueRadio  = item.querySelector('input[value="true"],  input[id*="true"]');
          const falseRadio = item.querySelector('input[value="false"], input[id*="false"]');
          return {
            index: char,
            text,
            trueElement:  trueRadio  ? trueRadio.parentElement  : item.querySelector('label[for*="true"]'),
            falseElement: falseRadio ? falseRadio.parentElement : item.querySelector('label[for*="false"]'),
            trueInput:  trueRadio,
            falseInput: falseRadio
          };
        }).filter(sub => sub.text.length > 0);

        if (subQuestions.length > 0) {
          return { type: "true_false", question: fullQuestionText, subQuestions, container, isDone };
        }
      }

      const optionNodes = Array.from(container.querySelectorAll(
        '.question-option, .select-item, .item-answer, .option, .answer-item, .answer-box, .choice-item, .radio-item, app-question-multiple-choice-item, .ant-radio-wrapper, .answer'
      )).filter(n => !n.closest(`#${GUI_ID}`));

      if (optionNodes.length > 0) {
        const options = optionNodes.map((node, index) => {
          const bubble = node.querySelector('.question-option-label, .item-answer, .option-char');
          let letter = bubble ? bubble.innerText.trim().toUpperCase() : "";
          letter = letter.replace(/[^A-D]/g, '');
          if (!letter) letter = String.fromCharCode(65 + index);
          const contentNode = node.querySelector('.question-option-content, .option-content, label, span') || node;
          const text = cleanQuestionText(contentNode.innerText);
          return { letter, text, element: node };
        }).filter(o => o.text.length > 0);

        if (options.length > 0) {
          return { type: "mcq", question: fullQuestionText, options, container, isDone };
        }
      }

      return { type: "unknown" };
    }

    isCurrentQuestionDone() {
      const activeIndicator = document.querySelector(
        '.mobile-bottom-bar .number.active, .answer-sheet .option.active'
      );
      return !!(activeIndicator && activeIndicator.classList.contains('done'));
    }

    isAssignmentFinished() {
      const indicators = Array.from(document.querySelectorAll(
        ".answer-sheet .option, .mobile-bottom-bar .number, .complete-message"
      ));
      if (indicators.length === 0) return false;
      return indicators.every(el => el.classList.contains("done") || el.classList.contains("active"));
    }
  }
  const scraper = new Scraper();

  /* ================== UI CONTROLLER ================== */
  class UIController {
    _simulateClick(el) {
      if (!el) return;
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
      ["mousedown", "mouseup", "click"].forEach(evtType => {
        try {
          el.dispatchEvent(new MouseEvent(evtType, { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
        } catch (e) {}
      });
    }

    selectOption(option) {
      if (!option || !option.element) return false;
      const node = option.element;

      const isSelected = node.classList.contains('selected') ||
                         node.classList.contains('highlighed') ||
                         node.classList.contains('active') ||
                         node.classList.contains('checked');
      if (isSelected) return true;

      this._simulateClick(node);

      const inputEl =
        node.querySelector("input[type='radio'], input[type='checkbox']") ||
        node.querySelector("input");
      if (inputEl) {
        inputEl.checked = true;
        inputEl.dispatchEvent(new Event("input",  { bubbles: true }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        inputEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }

      const labelEl = node.querySelector("label") || node.querySelector(".question-option-label") || node;
      if (labelEl && labelEl !== node) this._simulateClick(labelEl);

      return true;
    }

    selectTrueFalse(subItem, isTrue) {
      const targetEl    = isTrue ? subItem.trueElement  : subItem.falseElement;
      const targetInput = isTrue ? subItem.trueInput    : subItem.falseInput;
      if (targetEl) this._simulateClick(targetEl);
      if (targetInput) {
        targetInput.checked = true;
        targetInput.dispatchEvent(new Event("change", { bubbles: true }));
        targetInput.dispatchEvent(new Event("input",  { bubbles: true }));
      }
    }

    fillInput(inputEl, text) {
      if (!inputEl) return;
      const value = String(text == null ? "" : text);

      try { inputEl.focus(); } catch (e) {}

      let nativeSetter;
      try {
        if (inputEl instanceof HTMLTextAreaElement) {
          nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        } else if (inputEl instanceof HTMLInputElement) {
          nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        }
      } catch (e) {}

      try {
        if (nativeSetter) nativeSetter.call(inputEl, value);
        else inputEl.value = value;
      } catch (e) { inputEl.value = value; }

      inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      try { inputEl.blur(); } catch (e) {}
    }

    async clickNext() {
      for (let i = 0; i < 10; i++) {
        const loadingBar = document.querySelector(
          'ngx-loading-bar [role="progressbar"], .loading-container, app-loading-service'
        );
        if (!loadingBar || !isElementVisible(loadingBar)) break;
        await sleep(200);
      }

      const navBtns = Array.from(document.querySelectorAll(
        'button.nav-btn, .mobile-bottom-bar button, button'
      ));
      const nextBtn = navBtns.find(b => {
        if (!isElementVisible(b)) return false;
        if (b.disabled) return false;
        if (b.closest(`#${GUI_ID}`)) return false;

        const icon = b.querySelector('.fa-chevron-right, .fa-angle-right, .fa-arrow-right');
        const text = (b.innerText || "").trim().toLowerCase();
        const isForbidden = /nộp\s*bài|kết\s*thúc|hoàn\s*thành|finish|complete|dừng/i.test(text);
        if (isForbidden) return false;

        return icon !== null || text.includes('tiếp') || text.includes('sau') || text.includes('next');
      });

      if (nextBtn && !nextBtn.disabled) {
        this._simulateClick(nextBtn);
        await sleep(500);
        return true;
      }
      return false;
    }

    async clickSubmit() {
      const candidates = Array.from(document.querySelectorAll(
        'button, input[type="button"], input[type="submit"], a.btn'
      ));
      const submitButton = candidates.find(b => {
        if (!isElementVisible(b)) return false;
        if (b.disabled) return false;
        if (b.closest(`#${GUI_ID}`)) return false;

        const text = (b.innerText || b.value || "").trim().toLowerCase();
        if (!text) return false;

        const isForbidden = /nộp\s*bài|kết\s*thúc|hoàn\s*thành|nộp|finish|complete/i.test(text);
        const isMatch = /trả lời|kiểm tra|xác nhận|submit|check|gửi|cập nhật|làm lại/i.test(text);
        return isMatch && !isForbidden;
      });

      if (submitButton) {
        this._simulateClick(submitButton);
        await sleep(600);
        return true;
      }
      return false;
    }
  }
  const uiController = new UIController();

  /* ================== GUI ================== */
  class ModernGUI {
    constructor(solverInstance) {
      this.solver = solverInstance;
      this.init();
      this.startGuardian();
    }

    init() {
      if (document.getElementById(GUI_ID)) return;

      const styleId = 'ai-solver-styles';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
          #${GUI_ID} {
            position: fixed !important;
            top: 90px !important; right: 25px !important;
            width: 340px !important;
            max-width: 92vw !important;
            background: rgba(15, 23, 42, 0.96) !important;
            backdrop-filter: blur(16px) !important;
            border: 1px solid rgba(168, 85, 247, 0.5) !important;
            border-radius: 16px !important;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8) !important;
            color: #f8fafc !important;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            z-index: 999999999 !important;
            overflow: hidden !important;
            user-select: none !important;
            -webkit-user-select: none !important;
            display: block !important;
            box-sizing: border-box !important;
          }
          #${GUI_ID} * { box-sizing: border-box !important; }
          #ai-solver-header {
            background: linear-gradient(135deg, #7c3aed, #3b82f6);
            padding: 12px 16px;
            display: flex; justify-content: space-between; align-items: center;
            font-weight: 700; color: white; font-size: 14px;
            letter-spacing: 0.5px;
            cursor: grab;
            touch-action: none;
            -webkit-tap-highlight-color: transparent;
          }
          #ai-solver-header:active { cursor: grabbing; }
          .ai-header-controls {
            display: flex; gap: 6px; align-items: center;
            touch-action: manipulation;
          }
          .ai-ctrl-btn {
            background: rgba(255, 255, 255, 0.2);
            border: none; color: white;
            width: 28px; height: 28px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 12px; cursor: pointer; transition: background 0.2s;
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
          }
          .ai-ctrl-btn:hover { background: rgba(255, 255, 255, 0.4); }
          .ai-ctrl-btn:active { background: rgba(255, 255, 255, 0.5); }
          #ai-solver-body { padding: 16px; }
          .ai-status-box {
            background: #020617; border: 1px solid #1e293b; border-radius: 10px;
            padding: 10px; font-size: 11px; color: #94a3b8;
            margin-bottom: 12px;
            max-height: 150px; overflow-y: auto;
            white-space: pre-wrap; word-break: break-word;
            -webkit-overflow-scrolling: touch;
          }
          .ai-btn-group {
            display: grid; grid-template-columns: 1fr 1fr;
            gap: 8px; margin-bottom: 6px;
          }
          .ai-btn {
            padding: 12px;
            border: none; border-radius: 10px;
            font-weight: 700; font-size: 12px;
            cursor: pointer; transition: all 0.2s;
            color: white; text-align: center;
            min-height: 44px;
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
          }
          .ai-btn-primary { background: #16a34a; grid-column: span 2; }
          .ai-btn-primary:hover, .ai-btn-primary:active { background: #15803d; }
          .ai-btn-secondary { background: #2563eb; }
          .ai-btn-secondary:hover, .ai-btn-secondary:active { background: #1d4ed8; }
          .ai-btn-danger { background: #dc2626; }
          .ai-btn-danger:hover, .ai-btn-danger:active { background: #b91c1c; }
          .ai-settings-panel {
            background: #020617; border: 1px solid #1e293b;
            border-radius: 10px; padding: 12px;
            margin-bottom: 12px; font-size: 11px;
            max-height: 60vh; overflow-y: auto;
            -webkit-overflow-scrolling: touch;
          }
          .ai-settings-group { margin-bottom: 10px; }
          .ai-settings-group label {
            display: block; color: #94a3b8; margin-bottom: 4px;
          }
          .ai-settings-group input[type="text"],
          .ai-settings-group input[type="number"],
          .ai-settings-group select {
            width: 100%; background: #0f172a;
            border: 1px solid #334155;
            color: #f8fafc;
            padding: 9px 10px;
            border-radius: 6px; font-size: 12px;
            outline: none;
            min-height: 40px;
            font-family: inherit;
          }
          .ai-settings-group select {
            cursor: pointer;
            -webkit-appearance: none;
            appearance: none;
            background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white'><path d='M7 10l5 5 5-5z'/></svg>");
            background-repeat: no-repeat;
            background-position: right 8px center;
            background-size: 20px;
            padding-right: 32px;
          }
          .ai-settings-group input:focus,
          .ai-settings-group select:focus { border-color: #7c3aed; }
          .ai-checkbox-group {
            display: flex; align-items: center; gap: 10px;
            color: #f8fafc; cursor: pointer;
            padding: 6px 0;
            -webkit-tap-highlight-color: transparent;
          }
          .ai-checkbox-group input {
            width: 18px; height: 18px;
            accent-color: #7c3aed; cursor: pointer;
            flex-shrink: 0;
          }
          .ai-footer {
            text-align: center; font-size: 10px; color: #64748b;
            border-top: 1px solid #1e293b; padding: 8px;
            background: rgba(2, 6, 23, 0.6);
          }
          @media (max-width: 480px) {
            #${GUI_ID} {
              width: 92vw !important;
              right: 4vw !important;
              top: 60px !important;
            }
            #ai-solver-body { padding: 12px; }
            .ai-btn { font-size: 13px; padding: 14px 10px; }
            .ai-status-box { font-size: 12px; max-height: 110px; }
            .ai-settings-panel { padding: 10px; }
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      }

      const safeModel    = escapeHtmlAttr(CONFIG.DEFAULT_MODEL);
      const safeInterval = escapeHtmlAttr(CONFIG.LOOP_INTERVAL_MS);

      const container = document.createElement('div');
      container.id = GUI_ID;
      container.innerHTML = `
        <div id="ai-solver-header">
          <span>⚡ ai slover v38.2</span>
          <div class="ai-header-controls">
            <button class="ai-ctrl-btn" id="ai-settings-btn" title="Cài đặt">⚙️</button>
            <button class="ai-ctrl-btn" id="ai-toggle-btn"   title="Thu gọn / Mở rộng">▲</button>
          </div>
        </div>
        <div id="ai-solver-body">
          <div id="ai-main-view">
            <div id="ai-status" class="ai-status-box">Trạng thái: Sẵn sàng càn quét ~</div>
            <div class="ai-btn-group">
              <button class="ai-btn ai-btn-primary"   id="ai-start-btn">🚀 Tự Động Giải</button>
              <button class="ai-btn ai-btn-secondary" id="ai-once-btn">🎯 Giải 1 Câu</button>
              <button class="ai-btn ai-btn-danger"    id="ai-stop-btn">⏹ Dừng Lại</button>
            </div>
          </div>
          <div id="ai-settings-view" class="ai-settings-panel" style="display: none;">
            <div style="font-weight: bold; color: #a855f7; margin-bottom: 10px;">⚙️ Cài đặt hệ thống</div>

            <div class="ai-settings-group">
              <label>Chọn Model AI:</label>
              <select id="ai-model-select">
                <option value="openai"   ${CONFIG.DEFAULT_MODEL === "openai"   ? "selected" : ""}>🤖 OpenAI (Mặc định)</option>
                <option value="deepseek" ${CONFIG.DEFAULT_MODEL === "deepseek" ? "selected" : ""}>🧠 DeepSeek Chat</option>
                <option value="gemini"   ${CONFIG.DEFAULT_MODEL === "gemini"   ? "selected" : ""}>⚡ Google Gemini</option>
                <option value="claude"   ${CONFIG.DEFAULT_MODEL === "claude"   ? "selected" : ""}>🎭 Anthropic Claude</option>
              </select>
            </div>

            <div class="ai-settings-group">
              <label>Model tùy chỉnh (nâng cao):</label>
              <input type="text" id="ai-model-input" value="${safeModel}" placeholder="vd: openai">
            </div>

            <div class="ai-settings-group">
              <label>Tốc độ quét (ms):</label>
              <input type="number" id="ai-interval-input" value="${safeInterval}" min="1500">
            </div>

            <div class="ai-settings-group">
              <label class="ai-checkbox-group">
                <input type="checkbox" id="ai-resolv-done-checkbox" ${CONFIG.RE_SOLVE_DONE ? 'checked' : ''}>
                <span>Giải lại cả những câu đã làm</span>
              </label>
            </div>

            <button class="ai-btn ai-btn-secondary" id="ai-save-settings-btn"
                    style="width: 100%; margin-top: 4px;">💾 Lưu Cài Đặt</button>
          </div>
        </div>
        <div class="ai-footer">Stable Master v38.2 · Mobile Ready</div>
      `;

      (document.body || document.documentElement).appendChild(container);

      /* ---- Kéo thả ---- */
      const header = document.getElementById('ai-solver-header');
      let isDragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

      const getXY = (e) => {
        if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        return { x: e.clientX, y: e.clientY };
      };

      const onDragStart = (e) => {
        if (e.target.closest('.ai-header-controls')) return;
        isDragging = true;
        const { x, y } = getXY(e);
        startX = x; startY = y;
        const rect = container.getBoundingClientRect();
        startLeft = rect.left; startTop = rect.top;
        container.style.setProperty('right',  'auto', 'important');
        container.style.setProperty('bottom', 'auto', 'important');
        container.style.setProperty('left',   startLeft + 'px', 'important');
        container.style.setProperty('top',    startTop  + 'px', 'important');
        container.style.setProperty('max-width', '92vw', 'important');
        if (e.cancelable) e.preventDefault();
      };

      const onDragMove = (e) => {
        if (!isDragging) return;
        const { x, y } = getXY(e);
        const w = container.offsetWidth || 340;
        let nl = startLeft + (x - startX);
        let nt = startTop  + (y - startY);
        nl = Math.max(0, Math.min(window.innerWidth - w,  nl));
        nt = Math.max(0, Math.min(window.innerHeight - 40, nt));
        container.style.setProperty('left', nl + 'px', 'important');
        container.style.setProperty('top',  nt + 'px', 'important');
        if (e.cancelable) e.preventDefault();
      };

      const onDragEnd = () => { isDragging = false; };

      header.addEventListener('mousedown', onDragStart);
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup',   onDragEnd);
      header.addEventListener('touchstart', onDragStart, { passive: false });
      window.addEventListener('touchmove',  onDragMove,  { passive: false });
      window.addEventListener('touchend',   onDragEnd);
      window.addEventListener('touchcancel', onDragEnd);

      /* ---- Buttons ---- */
      document.getElementById('ai-start-btn').onclick = () => this.solver.start();
      document.getElementById('ai-once-btn').onclick  = () => this.solver.solveOnce();
      document.getElementById('ai-stop-btn').onclick  = () => this.solver.stop();

      const body = document.getElementById('ai-solver-body');
      const toggleBtn = document.getElementById('ai-toggle-btn');
      let minimized = false;
      toggleBtn.onclick = () => {
        minimized = !minimized;
        body.style.display = minimized ? 'none' : 'block';
        toggleBtn.innerText = minimized ? '▼' : '▲';
      };

      const settingsBtn  = document.getElementById('ai-settings-btn');
      const mainView     = document.getElementById('ai-main-view');
      const settingsView = document.getElementById('ai-settings-view');
      let showSettings = false;
      settingsBtn.onclick = () => {
        showSettings = !showSettings;
        mainView.style.display     = showSettings ? 'none'  : 'block';
        settingsView.style.display = showSettings ? 'block' : 'none';
      };

      const modelSelect = document.getElementById('ai-model-select');
      const modelInput  = document.getElementById('ai-model-input');

      modelSelect.onchange = () => { modelInput.value = modelSelect.value; };
      modelInput.oninput = () => {
        const v = modelInput.value.trim();
        const match = Array.from(modelSelect.options).find(o => o.value === v);
        if (match) modelSelect.value = v;
      };

      document.getElementById('ai-save-settings-btn').onclick = () => {
        const newModel    = modelInput.value.trim() || modelSelect.value.trim();
        const newInterval = parseInt(document.getElementById('ai-interval-input').value.trim(), 10);
        const reSolveDone = document.getElementById('ai-resolv-done-checkbox').checked;

        if (newModel) {
          CONFIG.DEFAULT_MODEL = newModel;
          localStorage.setItem("HW_SOLVER_MODEL", newModel);
          const match = Array.from(modelSelect.options).find(o => o.value === newModel);
          if (match) modelSelect.value = newModel;
        }
        if (!isNaN(newInterval) && newInterval >= 1500) {
          CONFIG.LOOP_INTERVAL_MS = newInterval;
          localStorage.setItem("HW_SOLVER_INTERVAL", newInterval);
        }
        CONFIG.RE_SOLVE_DONE = reSolveDone;
        localStorage.setItem("HW_SOLVER_RE_SOLVE_DONE", reSolveDone);

        this.updateStatus(
          `✅ Đã lưu!\nModel: ${CONFIG.DEFAULT_MODEL}\nQuét: ${CONFIG.LOOP_INTERVAL_MS}ms\nGiải lại câu cũ: ${CONFIG.RE_SOLVE_DONE ? "ON" : "OFF"}`,
          "#4ade80"
        );
        setTimeout(() => {
          showSettings = false;
          mainView.style.display     = 'block';
          settingsView.style.display = 'none';
        }, 900);
      };
    }

    startGuardian() {
      setInterval(() => {
        if (!document.getElementById(GUI_ID)) this.init();
      }, 1000);
    }

    updateStatus(text, color = "#f8fafc") {
      const el = document.getElementById('ai-status');
      if (el) { el.innerText = text; el.style.color = color; }
    }
  }

  /* ================== MAIN SOLVER ================== */
  class HomeworkSolver {
    constructor() {
      this.active = false;
      this.timer = null;
      this.gui = new ModernGUI(this);
    }

    start() {
      if (this.active) return;
      this.active = true;
      this.gui.updateStatus("🔄 Đang chạy tự động...", "#4ade80");
      this._runLoop();
    }

    stop() {
      this.active = false;
      if (this.timer) clearTimeout(this.timer);
      this.gui.updateStatus("⏹ Đã dừng hoạt động.", "#f87171");
    }

    async _runLoop() {
      if (!this.active) return;
      const success = await this.solveOnce();
      if (!this.active) return;
      const delay = success ? CONFIG.LOOP_INTERVAL_MS : 1500;
      this.timer = setTimeout(() => this._runLoop(), delay);
    }

    async solveOnce() {
      try {
        this.gui.updateStatus("🔍 Đang quét câu hỏi...", "#60a5fa");
        const detected = scraper.detectQuestionType();

        if (detected.type === "unknown") {
          if (scraper.isAssignmentFinished()) {
            this.gui.updateStatus("🎉 Bài tập đã hoàn thành xuất sắc!", "#4ade80");
            this.stop();
            return "FINISHED";
          }
          this.gui.updateStatus("⚠️ Không tìm thấy câu hỏi (đang tải)...", "#facc15");
          return false;
        }

        if (detected.isDone && !CONFIG.RE_SOLVE_DONE) {
          this.gui.updateStatus("⏭ Câu này đã làm rồi — chuyển câu...", "#a78bfa");
          await uiController.clickNext();
          return true;
        }

        if (detected.isDone) {
          this.gui.updateStatus("🔄 Đang giải lại câu cũ...", "#38bdf8");
        }

        if (detected.type === "fill_in") {
          this.gui.updateStatus(
            `📖 Điền từ:\n"${detected.question.slice(0, 80)}..."\n\n🧠 [${CONFIG.DEFAULT_MODEL}] ...`,
            "#fbbf24"
          );
          const prompt = `Đề bài:\n${detected.question}\n\nCHỈ TRẢ VỀ kết quả đáp án ngắn gọn bằng từ hoặc con số duy nhất, tuyệt đối không kèm giải thích.`;
          const sysPrompt = "Bạn là trợ lý giải bài tập thông minh. Chỉ trả về duy nhất kết quả ngắn gọn.";
          const aiResponse = await apiClient.call(prompt, sysPrompt);
          const cleanAnswer = aiResponse.replace(/^(Đáp án|Kết quả)[:\s]*/i, "").trim().split("\n")[0].trim();
          if (!cleanAnswer) {
            this.gui.updateStatus(`❌ Không trích xuất được đáp án:\n${aiResponse}`, "#f87171");
            return false;
          }
          uiController.fillInput(detected.inputElement, cleanAnswer);
          await sleep(400);
          await uiController.clickSubmit();
          this.gui.updateStatus(`✅ Đã điền: [${cleanAnswer}]`, "#4ade80");
          await uiController.clickNext();
          return true;
        }

        if (detected.type === "true_false") {
          this.gui.updateStatus(
            `📖 Đúng/Sai:\n"${detected.question.slice(0, 80)}..."\n\n🧠 [${CONFIG.DEFAULT_MODEL}] ...`,
            "#fbbf24"
          );
          let prompt = `Đề bài chính:\n${detected.question}\n\nCác ý cần đánh giá Đúng hay Sai:\n`;
          detected.subQuestions.forEach(sub => { prompt += `- Ý ${sub.index}: ${sub.text}\n`; });
          const sysPrompt =
            "Bạn là trợ lý giải bài tập khoa học. Phân tích kỹ các ý Đúng/Sai. " +
            "TRẢ VỀ mỗi dòng là một ý kèm ĐÚNG hoặc SAI, ví dụ:\na: ĐÚNG\nb: SAI";
          const aiResponse = await apiClient.call(prompt, sysPrompt);

          let solvedCount = 0;
          detected.subQuestions.forEach(sub => {
            const esc = String(sub.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(
              `(?:^|[^\\w])${esc}\\s*[:\\-\\.,\\)\\]]*\\s*(ĐÚNG|SAI|TRUE|FALSE|Đ|S)(?![A-Za-zÀ-ỹ])`,
              "i"
            );
            const m = aiResponse.match(re);
            if (m) {
              const v = m[1].toUpperCase();
              const isTrue = v === "Đ" || v === "T" || v === "TRUE" || v === "ĐÚNG";
              uiController.selectTrueFalse(sub, isTrue);
              solvedCount++;
            }
          });

          if (solvedCount === 0) {
            this.gui.updateStatus(`❌ Không phân tích được kết quả:\n${aiResponse}`, "#f87171");
            return false;
          }
          await sleep(400);
          await uiController.clickSubmit();
          this.gui.updateStatus(`✅ Đã giải ${solvedCount}/${detected.subQuestions.length} ý.`, "#4ade80");
          await uiController.clickNext();
          return true;
        }

        if (detected.type === "mcq") {
          this.gui.updateStatus(
            `📖 MCQ:\n"${detected.question.slice(0, 80)}..."\n\n🧠 [${CONFIG.DEFAULT_MODEL}] ...`,
            "#fbbf24"
          );
          const prompt =
            "Đề bài:\n" + detected.question +
            "\n\nCác lựa chọn:\n" +
            detected.options.map(o => `${o.letter}. ${o.text}`).join("\n");
          const sysPrompt =
            "Bạn là trợ lý giải bài tập trắc nghiệm. " +
            "BẮT BUỘC dòng đầu tiên là 'ĐÁP ÁN: [X]' (X = A/B/C/D).";
          const aiResponse = await apiClient.call(prompt, sysPrompt);
          const letter = extractMCQAnswerLetter(aiResponse);
          if (!letter) {
            this.gui.updateStatus(`❌ Không tìm thấy đáp án hợp lệ:\n${aiResponse}`, "#f87171");
            return false;
          }
          const targetOpt = detected.options.find(o => o.letter === letter);
          if (!targetOpt) {
            this.gui.updateStatus(`⚠️ AI chọn ${letter} không khớp lựa chọn nào.\n${aiResponse}`, "#facc15");
            return false;
          }
          uiController.selectOption(targetOpt);
          await sleep(400);
          await uiController.clickSubmit();
          this.gui.updateStatus(`✅ Đã chọn: ${letter}`, "#4ade80");
          await uiController.clickNext();
          return true;
        }

      } catch (err) {
        logger.error(err);
        this.gui.updateStatus(`❌ Lỗi: ${err.message}`, "#f87171");
        return false;
      }
    }
  }

  window.hwSolver = new HomeworkSolver();
  logger.info("ai slover v38.2.0 đã khởi chạy! ~");
})();

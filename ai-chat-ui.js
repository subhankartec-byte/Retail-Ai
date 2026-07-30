/* ============================================================
   ai-chat-ui.js — Retail AI · Universal AI Assistant, shared
   "Ask AI" chat panel
   ------------------------------------------------------------
   Plain script (no imports — talks to window.RetailChat, which
   already owns auth/history/context-shaping). Browser:
   window.AIChatUI.

   WHAT THIS FILE IS
   ------------------------------------------------------------
   A single reusable chat-overlay UI, generalised from
   Store_Review a1.html's own "Ask AI" implementation (the only
   place this pattern existed before now) — same markup, same
   CSS, same interaction model, extracted so every tool gets the
   identical experience instead of five more hand-rolled copies.
   This file owns ONLY presentation and the request/response
   plumbing to RetailChat.ask(); it has no opinion about what a
   tool's data means — each host page supplies that via
   `buildContext()`.

   USAGE
   ------------------------------------------------------------
       <script src="ai-chat-ui.js"></script>   (after retail-chat.js)

       AIChatUI.mount({
         toolKey: 'inventoryValidity',       // RetailChat.buildToolContext()'s toolName
         suggestedQuestions: ['Explain this report.', 'What is the biggest issue?', ...],
         subtitle: () => 'Ask about this file',           // optional, fn -> string
         isReady: () => !!state.model,                    // optional, fn -> bool; blocks Ask AI until data is loaded
         notReadyMessage: 'Upload and process a file first.',
         buildContext: () => ({                           // optional, fn -> RetailChat.ask()'s context object
           toolContext: RetailChat.buildToolContext('inventoryValidity', { ... }),
           decisionEngine: null, retailIntelligence: null, retailKnowledge: null
         })
       });

       // later, to open programmatically (e.g. from a toolbar button):
       AIChatUI.open();

   Every tool gets the exact same overlay, message bubbles,
   suggested-question chips, input box, thinking-indicator and
   failure-message set — the ONLY thing that varies per tool is
   the context object handed to RetailChat.ask(), which is the
   correct place for that variation to live (per-tool data
   shape), not the UI.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AIChatUI = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var CSS_ID = 'ai-chat-ui-css';
var CSS = '' +
'.aic-btn{background:var(--plum,#6b3fa0);color:#fff;border:1px solid var(--plum,#6b3fa0);border-radius:5px;' +
  'padding:6px 11px;font-size:12px;cursor:pointer;font-weight:600;white-space:nowrap;font-family:inherit}' +
'.aic-btn:hover{background:var(--plum-hover,#7d4fb5)}' +
'.aic-overlay{position:fixed;inset:0;background:rgba(14,42,69,.55);z-index:9999;display:flex;' +
  'align-items:flex-end;justify-content:center;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
'.aic-overlay.aic-hidden{display:none!important}' +
'.aic-panel{background:#fff;width:100%;max-width:640px;max-height:88vh;border-radius:14px 14px 0 0;' +
  'display:flex;flex-direction:column;box-shadow:0 -8px 40px rgba(0,0,0,.3);overflow:hidden}' +
'@media(min-width:700px){.aic-overlay{align-items:center}.aic-panel{border-radius:14px;max-height:80vh}}' +
'.aic-head{background:linear-gradient(180deg,var(--navy2,var(--navy,#17395c)),var(--navy,#0e2a45));color:#fff;padding:11px 14px;' +
  'display:flex;align-items:center;gap:9px;border-bottom:3px solid var(--gold,#c9a24a)}' +
'.aic-head b{font-size:14px;letter-spacing:.1em;text-transform:uppercase}' +
'.aic-head .aic-x{margin-left:auto;background:rgba(255,255,255,.14);border:none;color:#fff;width:28px;height:28px;' +
  'border-radius:6px;font-size:17px;cursor:pointer;line-height:1}' +
'.aic-sub{padding:7px 14px;font-size:11px;color:var(--mute,var(--muted,#6b7a88));background:#f6f8fa;border-bottom:1px solid var(--line,#c9d3dc)}' +
'.aic-chat{flex:1;overflow-y:auto;padding:12px 14px;min-height:180px;background:#fbfcfd}' +
'.aic-msg{margin-bottom:10px;display:flex}' +
'.aic-msg.aic-u{justify-content:flex-end}' +
'.aic-bub{max-width:86%;padding:8px 11px;border-radius:11px;font-size:12.5px;line-height:1.55;white-space:pre-wrap}' +
'.aic-msg.aic-u .aic-bub{background:var(--plum-soft,#ece3f7);border:1px solid #d9c9ef;color:#2a1b45}' +
'.aic-msg.aic-a .aic-bub{background:#fff;border:1px solid var(--line,#c9d3dc)}' +
'.aic-empty{color:var(--mute,var(--muted,#6b7a88));font-size:12px;text-align:center;padding:26px 12px;line-height:1.6}' +
'.aic-chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 14px 0}' +
'.aic-chip{font-size:11px;padding:5px 10px;border:1px solid var(--line,#c9d3dc);border-radius:15px;cursor:pointer;' +
  'color:var(--navy,#0e2a45);background:#fff;font-family:inherit}' +
'.aic-chip:hover{background:var(--gold-soft,#f6e9c6);border-color:var(--gold-line,#e0c583)}' +
'.aic-input{display:flex;gap:8px;padding:10px 14px 14px}' +
'.aic-input input{flex:1;min-width:0;padding:9px 11px;border:1px solid var(--line,#c9d3dc);border-radius:8px;font-size:13px;font-family:inherit}' +
'.aic-input button{background:var(--plum,#6b3fa0);color:#fff;border:none;border-radius:8px;padding:0 16px;font-weight:700;cursor:pointer;font-size:13px}' +
'.aic-input button:disabled{opacity:.5;cursor:default}' +
'.aic-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--gold,#c9a24a);animation:aic-blink 1s infinite}' +
'@keyframes aic-blink{0%,100%{opacity:.3}50%{opacity:1}}' +
'@media print{.aic-overlay{display:none!important}}';

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  var st = document.createElement('style');
  st.id = CSS_ID;
  st.textContent = CSS;
  document.head.appendChild(st);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

var FAIL_MSG = {
  invalid_question: 'Type a question first.',
  signed_out: 'Sign in to use this feature.',
  rate_limited: 'Limit reached for now — try again later.',
  unavailable: 'This is temporarily unavailable. Try again in a moment.',
  network: 'Could not reach the AI service. Check your connection and try again.',
  bad_response: 'Got something unexpected back. Try again.'
};

var DEFAULT_QUESTIONS = [
  'Explain this report.',
  'What is the biggest issue?',
  'Which items require action?',
  'Suggest business actions.'
];

function buildMarkup() {
  var wrap = document.createElement('div');
  wrap.className = 'aic-overlay aic-hidden';
  wrap.id = 'aicOverlay';
  wrap.innerHTML =
    '<div class="aic-panel">' +
      '<div class="aic-head"><b>Ask AI</b><button class="aic-x" id="aicClose" title="Close">×</button></div>' +
      '<div class="aic-sub" id="aicSub"></div>' +
      '<div class="aic-chat" id="aicChat"></div>' +
      '<div class="aic-chips" id="aicChips"></div>' +
      '<div class="aic-input"><input type="text" id="aicInput" placeholder="Ask about this report…"><button id="aicSend">Ask</button></div>' +
    '</div>';
  document.body.appendChild(wrap);
  return wrap;
}

/* mount(opts) — call once per page. Injects CSS + the overlay
   markup (appended to <body>, hidden until open() is called), and
   wires all interaction. Safe to call multiple times — a second
   mount() replaces the first's config rather than duplicating
   DOM. */
var state = null;

function mount(opts) {
  ensureCss();
  opts = opts || {};
  state = {
    toolKey: opts.toolKey || 'tool',
    suggestedQuestions: opts.suggestedQuestions || DEFAULT_QUESTIONS,
    subtitle: typeof opts.subtitle === 'function' ? opts.subtitle : function () { return 'Ask about this report'; },
    isReady: typeof opts.isReady === 'function' ? opts.isReady : function () { return true; },
    notReadyMessage: opts.notReadyMessage || 'Load and process a report first.',
    buildContext: typeof opts.buildContext === 'function' ? opts.buildContext : function () { return {}; },
    chat: []
  };

  var existing = document.getElementById('aicOverlay');
  if (existing) existing.remove();
  var overlay = buildMarkup();

  var chatEl = overlay.querySelector('#aicChat');
  var inputEl = overlay.querySelector('#aicInput');
  var sendEl = overlay.querySelector('#aicSend');
  var chipsEl = overlay.querySelector('#aicChips');
  var subEl = overlay.querySelector('#aicSub');
  var closeEl = overlay.querySelector('#aicClose');

  function renderChat() {
    if (!state.chat.length) {
      chatEl.innerHTML = '<div class="aic-empty">Ask anything about this report — what needs attention, why, and what to do next.</div>';
      return;
    }
    chatEl.innerHTML = state.chat.map(function (m) {
      return '<div class="aic-msg ' + (m.role === 'user' ? 'aic-u' : 'aic-a') + '"><div class="aic-bub">' +
        (m.pending ? '<span class="aic-dot"></span> thinking…' : esc(m.text)) + '</div></div>';
    }).join('');
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  async function send() {
    if (!state.isReady()) { alert(state.notReadyMessage); return; }
    var q = (inputEl.value || '').trim();
    if (!q) return;
    inputEl.value = '';
    state.chat.push({ role: 'user', text: q });
    if (typeof RetailChat === 'undefined' || !RetailChat) {
      state.chat.push({ role: 'assistant', text: FAIL_MSG.unavailable });
      renderChat();
      return;
    }
    state.chat.push({ role: 'assistant', text: '', pending: true });
    renderChat();
    sendEl.disabled = true;
    var ctx = {};
    try { ctx = state.buildContext() || {}; } catch (e) { /* context-building must never block the question */ }
    var res;
    try { res = await RetailChat.ask(q, ctx); } catch (e) { res = null; }
    if (res && res.ok) {
      state.chat[state.chat.length - 1] = { role: 'assistant', text: res.answer };
    } else {
      state.chat[state.chat.length - 1] = { role: 'assistant', text: FAIL_MSG[res && res.reason] || FAIL_MSG.unavailable };
    }
    sendEl.disabled = false;
    renderChat();
  }

  function open() {
    if (!state.isReady()) { alert(state.notReadyMessage); return; }
    subEl.textContent = state.subtitle();
    chipsEl.innerHTML = state.suggestedQuestions.map(function (c) {
      return '<span class="aic-chip">' + esc(c) + '</span>';
    }).join('');
    Array.prototype.forEach.call(chipsEl.querySelectorAll('.aic-chip'), function (chip, i) {
      chip.onclick = function () { inputEl.value = state.suggestedQuestions[i]; send(); };
    });
    renderChat();
    overlay.classList.remove('aic-hidden');
    inputEl.focus();
  }
  function close() { overlay.classList.add('aic-hidden'); }

  closeEl.addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  sendEl.addEventListener('click', send);
  inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

  state._open = open;
  state._close = close;
  state._clear = function () {
    state.chat = [];
    if (typeof RetailChat !== 'undefined' && RetailChat.clearHistory) { try { RetailChat.clearHistory(); } catch (e) {} }
  };
}

/* open()/close()/clear() — the only calls a host page needs
   after mount(). clear() should be called whenever the
   underlying report changes (a new file processed) so old chat
   turns don't leak into a new file's context — the same
   discipline Store_Review a1.html's own original implementation
   already established. */
function open() { if (state) state._open(); }
function close() { if (state) state._close(); }
function clear() { if (state) state._clear(); }

return { mount: mount, open: open, close: close, clear: clear };
}));

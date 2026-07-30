/* ============================================================
   ai-toolbar-ui.js — Retail AI · Universal Toolbar, shared AI
   actions bar
   ------------------------------------------------------------
   Plain script, no imports. Browser: window.AIToolbar.

   WHAT THIS FILE IS
   ------------------------------------------------------------
   The one place "AI Summary" and "Ask AI" buttons are styled and
   built, so every tool's toolbar looks and behaves identically
   instead of six hand-rolled copies. Deliberately does NOT touch
   Export Excel / Print — every tool already has its own, already
   in its own established place; rendering a second, redundant
   set here would be duplicate UI in the other direction. A host
   page that already has Export/Print buttons keeps them exactly
   where they are; this component only adds the two AI actions,
   with consistent styling, next to them.

   USAGE
   ------------------------------------------------------------
       <script src="ai-toolbar-ui.js"></script>

       AIToolbar.mount('#toolbarSlot', {
         onAISummary: () => runAISummary(),   // your tool's existing AIPipeline.run() trigger
         onAskAI: () => AIChatUI.open()        // usually just this
       });

   Renders two buttons with the exact class/markup Store Review's
   original toolbar used (`.tb-btn.ai`) so a page that already
   defines that class (most tools copied Store Review's toolbar
   pattern) gets pixel-identical styling for free; a page that
   doesn't defines it via this file's own injected fallback CSS
   instead, so appearance stays consistent everywhere either way.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AIToolbar = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var CSS_ID = 'ai-toolbar-ui-css';
/* Scoped to .ait-bar so this can never override a host page's
   own .tb-btn rules if one already exists (CSS cascade: a host
   page's own stylesheet, loaded earlier in <head>, still wins on
   equal specificity for plain .tb-btn; these are only a floor for
   pages that have no such class at all). */
var CSS = '' +
'.ait-bar{display:flex;gap:7px;flex-wrap:wrap;align-items:center}' +
'.ait-bar .ait-btn{background:var(--plum,#6b3fa0);color:#fff;border:1px solid var(--plum,#6b3fa0);' +
  'border-radius:5px;padding:6px 11px;font-size:12px;cursor:pointer;font-weight:600;white-space:nowrap;font-family:inherit}' +
'.ait-bar .ait-btn:hover{background:var(--plum-hover,#7d4fb5)}' +
'.ait-bar .ait-btn:disabled{opacity:.55;cursor:default}';

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  var st = document.createElement('style');
  st.id = CSS_ID;
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* mount(container, opts) — container is a CSS selector or Element.
   opts.onAISummary / opts.onAskAI are click handlers; either may
   be omitted to skip that button (e.g. a tool with no meaningful
   "summary" concept yet). Renders using the host page's OWN
   `.tb-btn`/`.tb-btn.ai` classes when they exist (checked via a
   quick stylesheet-agnostic heuristic: just always add both class
   lists — `tb-btn ai` first for pages already using that
   convention, `ait-btn` second as this file's own fallback,
   scoped under .ait-bar) so the button looks right whichever
   convention the host page follows, without needing per-page
   configuration. */
function mount(container, opts) {
  ensureCss();
  opts = opts || {};
  var el = typeof container === 'string' ? document.querySelector(container) : container;
  if (!el) return null;

  var bar = document.createElement('div');
  bar.className = 'ait-bar';

  var buttons = {};
  if (opts.onAISummary) {
    var b1 = document.createElement('button');
    b1.type = 'button';
    b1.className = 'tb-btn ai ait-btn';
    b1.id = opts.summaryButtonId || 'aitSummaryBtn';
    b1.textContent = opts.summaryLabel || 'AI Summary';
    b1.addEventListener('click', opts.onAISummary);
    bar.appendChild(b1);
    buttons.summary = b1;
  }
  if (opts.onAskAI) {
    var b2 = document.createElement('button');
    b2.type = 'button';
    b2.className = 'tb-btn ai ait-btn';
    b2.id = opts.askButtonId || 'aitAskBtn';
    b2.textContent = opts.askLabel || 'Ask AI';
    b2.addEventListener('click', opts.onAskAI);
    bar.appendChild(b2);
    buttons.ask = b2;
  }

  el.appendChild(bar);
  return buttons;
}

return { mount: mount };
}));

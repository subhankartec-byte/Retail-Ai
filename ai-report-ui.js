/* ============================================================
   ai-report-ui.js — Retail AI · Universal AI Pipeline, shared
   Stage 9 report renderer
   ------------------------------------------------------------
   Plain script (no imports, no auth, pure DOM rendering).
   Browser: window.AIReportUI.

   WHAT THIS FILE IS
   ------------------------------------------------------------
   Every tool that wires into AIPipeline.run() gets back the same
   Stage 9 shape (executiveSummary / keyFindings / businessImpact
   / recommendations / confidenceScore / warnings /
   dataQualityNotes / aiObservations / nextBestActions). Without
   this file, each tool would need to hand-write its own render
   function for that shape — five more copies of the same HTML
   assembly logic. renderReport(container, report) is the ONE
   place that happens.

   Deliberately generic CSS class names (ai-report-*) so it can
   sit inside whatever card/panel container a tool already has
   (Store Review's #aiSummaryCard, a new panel on tools that had
   none) without needing that tool's own stylesheet changed —
   the base rules below are self-contained and scoped under
   .ai-report-root so they cannot leak into a host page's other
   styles.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AIReportUI = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var CSS_ID = 'ai-report-ui-css';
var CSS = '' +
  '.ai-report-root{font-family:inherit;color:inherit}' +
  '.ai-report-root .ar-headline{font-size:1.02em;font-weight:700;margin:0 0 .6em}' +
  '.ai-report-root .ar-section{margin:0 0 .85em}' +
  '.ai-report-root .ar-section h4{font-size:.72em;text-transform:uppercase;letter-spacing:.06em;' +
    'opacity:.65;margin:0 0 .35em;font-weight:600}' +
  '.ai-report-root ul.ar-list{list-style:disc;margin:0;padding-left:1.15em}' +
  '.ai-report-root ul.ar-list li{margin:0 0 .3em}' +
  '.ai-report-root .ar-warn{color:#b45309}' +
  '.ai-report-root .ar-conf{display:inline-block;font-size:.72em;font-family:monospace;' +
    'padding:.15em .55em;border-radius:999px;border:1px solid currentColor;opacity:.85;margin:0 0 .6em}' +
  '.ai-report-root .ar-foot{font-size:.78em;opacity:.6;margin-top:.6em}';

function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById(CSS_ID)) return;
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

function section(title, items) {
  if (!items || !items.length) return '';
  return '<div class="ar-section"><h4>' + esc(title) + '</h4><ul class="ar-list">' +
    items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul></div>';
}

/* renderReport(container, report) — container is an Element (or
   an id string); report is AIPipeline's Stage 9 output. Always
   renders SOMETHING sensible even for a degraded/AI-unavailable
   report — never leaves a container blank without explanation. */
function renderReport(container, report) {
  var el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  ensureCss();
  report = report || {};

  var confPct = Math.round((report.confidenceScore || 0) * 100);
  var html = '<div class="ai-report-root">';
  html += '<span class="ar-conf">Confidence ' + confPct + '%</span>';
  if (report.executiveSummary) html += '<p class="ar-headline">' + esc(report.executiveSummary) + '</p>';
  html += section('Key Findings', report.keyFindings);
  html += section('Business Impact', report.businessImpact);
  html += section('Recommendations', report.recommendations);
  html += section('Next Best Actions', report.nextBestActions);
  html += section('Data Quality Notes', report.dataQualityNotes);
  if (report.warnings && report.warnings.length) {
    html += '<div class="ar-section ar-warn"><h4>Warnings</h4><ul class="ar-list">' +
      report.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
  }
  html += '<div class="ar-foot">Generated ' + esc(new Date(report.generatedAt || Date.now()).toLocaleString()) +
    ' · source: ' + esc(report.source || 'rules') + ' — AI-assisted analysis, always check against the figures above.</div>';
  html += '</div>';
  el.innerHTML = html;
}

/* renderBusy/renderError — the two other states every tool's AI
   trigger already needs (loading, and "couldn't do it"), kept
   here too so the whole lifecycle is defined in one place. */
function renderBusy(container, message) {
  var el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  el.innerHTML = '<div class="ai-report-root"><p class="note">' + esc(message || 'Generating analysis…') + '</p></div>';
}
function renderError(container, message) {
  var el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  el.innerHTML = '<div class="ai-report-root"><p class="ar-warn">' + esc(message || 'Could not generate an analysis. Try again.') + '</p></div>';
}

return { renderReport: renderReport, renderBusy: renderBusy, renderError: renderError };
}));

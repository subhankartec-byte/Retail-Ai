/* ============================================================
   retail-decision.js — Retail AI · cross-tool decision engine (Phase 6)
   ------------------------------------------------------------
   Pure JS, zero dependencies. Browser: window.RetailDecision.
   Node (tests): module.exports.

   The problem this solves: every tool (Store Review, Inventory
   Validity, Inventory Audit, Stock IN/OUT Adjustment, SOH Image
   Link Builder, BlueDart Waybill Builder) runs as an independent
   page with no shared state. This module is the shared blackboard
   plus the correlation logic on top of it:

     saveSummary(toolKey, data)  - a tool calls this once it has
                                   computed its own report, storing
                                   an aggregate-only summary (same
                                   numbers already on that tool's
                                   screen — never raw rows) under a
                                   namespaced localStorage key.
     loadSummaries()             - reads whatever summaries are
                                   currently saved, tool by tool.
     evaluate(summaries)         - pure function: summaries in,
                                   recommendations out. No I/O, so
                                   it's fully testable with
                                   hand-built input.

   Deliberately deterministic and rule-based, not an LLM call.
   Every recommendation carries the evidence that produced it, so
   a manager can check it against the source tool's own report
   rather than trust a black box. An AI narration layer can sit on
   top of this output in a later phase; the decisions themselves
   stay auditable.

   v1 (pilot, this phase): only storeReview is wired up by any
   tool page, so only the `coaching` category can ever be
   non-empty. transfers/reorders/attention/atRisk need
   inventoryValidity / inventoryAudit / stockAdjustment data and
   stay empty arrays until those tools are connected — this is
   the correct, honest degradation, not a bug.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RetailDecision = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var LS_PREFIX = 'retailai.decision.v1.';
var TOOL_KEYS = [
  'storeReview', 'inventoryValidity', 'inventoryAudit',
  'stockAdjustment', 'sohImageLinks', 'blueDart'
];

/* A staff member's average bill value (abv) more than this fraction
   below the store's own overall average transaction value (atv) is
   a coaching candidate. Requires at least MIN_BILLS bills so someone
   with one lucky or unlucky sale isn't flagged on noise. */
var COACHING_GAP = 0.20;
var MIN_BILLS = 3;

/* ---------- storage ---------- */
function saveSummary(toolKey, data) {
  if (TOOL_KEYS.indexOf(toolKey) === -1) return false;
  try {
    if (typeof localStorage === 'undefined') return false;
    var envelope = { v: 1, tool: toolKey, savedAt: new Date().toISOString(), data: data };
    localStorage.setItem(LS_PREFIX + toolKey, JSON.stringify(envelope));
    return true;
  } catch (e) { return false; }
}

function loadSummaries() {
  var out = {};
  TOOL_KEYS.forEach(function (k) {
    out[k] = null;
    try {
      if (typeof localStorage === 'undefined') return;
      var raw = localStorage.getItem(LS_PREFIX + k);
      if (!raw) return;
      var env = JSON.parse(raw);
      if (env && env.data) out[k] = env;
    } catch (e) { /* corrupt entry — treat as absent */ }
  });
  return out;
}

/* ---------- coverage ---------- */
function ageDays(iso) {
  var t = Date.parse(iso);
  if (!isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function coverageOf(summaries) {
  var available = [], missing = [], stalest = null;
  TOOL_KEYS.forEach(function (k) {
    var env = summaries[k];
    if (env && env.data) {
      available.push(k);
      var age = ageDays(env.savedAt);
      if (age !== null && (!stalest || age > stalest.ageDays)) {
        stalest = { tool: k, ageDays: Math.round(age * 10) / 10 };
      }
    } else {
      missing.push(k);
    }
  });
  return { available: available, missing: missing, stalest: stalest };
}

/* ---------- coaching (from Store Review) ----------
   storeReview.data.totals.atv is the store-wide average bill
   value; storeReview.data.staff[].abv is the same metric per
   person. Comparing them directly is valid — same units, same
   definition, just a different level of aggregation. */
function coachingFrom(storeReview) {
  if (!storeReview || !storeReview.data) return [];
  var d = storeReview.data;
  var storeAtv = d.totals && d.totals.atv;
  if (!storeAtv || !Array.isArray(d.staff)) return [];
  var out = [];
  d.staff.forEach(function (s) {
    if (!s || !s.bills || s.bills < MIN_BILLS || !s.abv) return;
    var gapPct = (storeAtv - s.abv) / storeAtv;
    if (gapPct >= COACHING_GAP) {
      out.push({
        staffName: s.name,
        metric: 'Average Bill Value',
        value: s.abv,
        storeAvg: storeAtv,
        gapPct: Math.round(gapPct * 1000) / 10,
        evidence: ['storeReview']
      });
    }
  });
  out.sort(function (a, b) { return b.gapPct - a.gapPct; });
  return out;
}

/* ---------- main ---------- */
function evaluate(summaries) {
  summaries = summaries || {};
  var coverage = coverageOf(summaries);
  var recommendations = {
    transfers: [],
    reorders: [],
    attention: [],
    coaching: coachingFrom(summaries.storeReview),
    atRisk: []
  };
  return { coverage: coverage, recommendations: recommendations };
}

return {
  evaluate: evaluate,
  saveSummary: saveSummary,
  loadSummaries: loadSummaries,
  TOOL_KEYS: TOOL_KEYS,
  LS_PREFIX: LS_PREFIX
};
}));

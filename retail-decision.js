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

   v2 (this phase): storeReview + inventoryValidity are wired up.
   coaching (from storeReview) and atRisk (from inventoryValidity)
   can be non-empty. transfers/reorders/attention still stay empty
   arrays — correct degradation, not a gap:
     - reorders deliberately waits for inventoryValidity's Cut
       Piece styles to be cross-referenced against storeReview's
       *per-style* sell-through, which storeReview's aggregate
       summary doesn't yet expose (only dept/brand/size level).
       Recommending "reorder" on a broken run without knowing if
       it even sells would actively mislead a manager, so this
       stays empty rather than guess.
     - transfers needs multi-store data in one upload (see
       inventoryValidity's own multiStore flag) — populated once
       that path is wired in a later phase.
     - attention needs inventoryAudit / stockAdjustment.
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
/* Tools whose data a recommendation can actually be built from.
   sohImageLinks/blueDart are enrichment-only (brand resolution,
   dispatch context) — their absence shouldn't tank confidence the
   way a missing primary signal does. */
var PRIMARY_TOOLS = ['storeReview', 'inventoryValidity', 'inventoryAudit', 'stockAdjustment'];

/* A staff member's average bill value (abv) more than this fraction
   below the store's own overall average transaction value (atv) is
   a coaching candidate. Requires at least MIN_BILLS bills so someone
   with one lucky or unlucky sale isn't flagged on noise. */
var COACHING_GAP = 0.20;
var MIN_BILLS = 3;

/* How many Cut Piece styles (highest value first) to surface. */
var AT_RISK_TOP_N = 20;

/* Freshness bands for the per-tool status indicator. */
var FRESH_DAYS = 3;
var AGING_DAYS = 14;

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

/* ---------- coverage + freshness ---------- */
function ageDays(iso) {
  var t = Date.parse(iso);
  if (!isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function freshnessOf(age) {
  if (age === null) return null;
  if (age <= FRESH_DAYS) return 'fresh';
  if (age <= AGING_DAYS) return 'aging';
  return 'stale';
}

function coverageOf(summaries) {
  var available = [], missing = [], perTool = {}, maxPrimaryAge = 0;
  TOOL_KEYS.forEach(function (k) {
    var env = summaries[k];
    if (env && env.data) {
      available.push(k);
      var age = ageDays(env.savedAt);
      var rounded = age === null ? null : Math.round(age * 10) / 10;
      perTool[k] = { status: 'available', ageDays: rounded, freshness: freshnessOf(age) };
      if (PRIMARY_TOOLS.indexOf(k) !== -1 && age !== null && age > maxPrimaryAge) maxPrimaryAge = age;
    } else {
      missing.push(k);
      perTool[k] = { status: 'missing', ageDays: null, freshness: null };
    }
  });
  var stalest = null;
  available.forEach(function (k) {
    var p = perTool[k];
    if (p.ageDays !== null && (!stalest || p.ageDays > stalest.ageDays)) stalest = { tool: k, ageDays: p.ageDays };
  });
  return { available: available, missing: missing, perTool: perTool, stalest: stalest, _maxPrimaryAge: maxPrimaryAge };
}

/* ---------- confidence ----------
   Based on how many PRIMARY signals are available (auxiliary
   tools don't move this number) and how stale the oldest primary
   signal is. Deterministic, no scoring magic beyond this. */
function confidenceOf(coverage) {
  var primaryAvailable = PRIMARY_TOOLS.filter(function (k) { return coverage.available.indexOf(k) !== -1; }).length;
  if (primaryAvailable === 0) {
    return { level: 'none', score: 0, reason: 'No primary signals available yet.' };
  }
  var ratio = primaryAvailable / PRIMARY_TOOLS.length;
  var score = ratio, staleNote = '';
  if (coverage._maxPrimaryAge > AGING_DAYS) { score *= 0.5; staleNote = ' Some data is over ' + AGING_DAYS + ' days old.'; }
  else if (coverage._maxPrimaryAge > FRESH_DAYS) { score *= 0.75; staleNote = ' Some data is aging.'; }
  var level = score >= 0.7 ? 'high' : (score >= 0.35 ? 'medium' : 'low');
  return {
    level: level,
    score: Math.round(score * 100) / 100,
    reason: primaryAvailable + ' of ' + PRIMARY_TOOLS.length + ' primary signals available.' + staleNote
  };
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

/* ---------- at risk (from Inventory Validity Console) ----------
   Cut Piece = a broken size run (1-2 sizes left of a style that
   should have 3+). Flagging the highest-value ones first: that's
   where the most capital is tied up in stock that isn't a
   sellable run any more. */
function atRiskFrom(inventoryValidity) {
  if (!inventoryValidity || !inventoryValidity.data) return [];
  var d = inventoryValidity.data;
  if (!Array.isArray(d.topCutPiece)) return [];
  return d.topCutPiece.slice(0, AT_RISK_TOP_N).map(function (u) {
    var sizeCount = u.sizeCount || 0;
    return {
      style: u.style,
      store: u.store,
      brand: u.brand,
      value: u.value,
      qty: u.qty,
      reasons: ['Incomplete size run (' + sizeCount + ' size' + (sizeCount === 1 ? '' : 's') + ' left)'],
      evidence: ['inventoryValidity']
    };
  });
}

/* ---------- main ---------- */
function evaluate(summaries) {
  summaries = summaries || {};
  var coverage = coverageOf(summaries);
  var confidence = confidenceOf(coverage);
  delete coverage._maxPrimaryAge; // internal-only, not part of the public shape

  var recommendations = {
    transfers: [],
    reorders: [],
    attention: [],
    coaching: coachingFrom(summaries.storeReview),
    atRisk: atRiskFrom(summaries.inventoryValidity)
  };
  return { coverage: coverage, confidence: confidence, recommendations: recommendations };
}

return {
  evaluate: evaluate,
  saveSummary: saveSummary,
  loadSummaries: loadSummaries,
  TOOL_KEYS: TOOL_KEYS,
  PRIMARY_TOOLS: PRIMARY_TOOLS,
  LS_PREFIX: LS_PREFIX
};
}));

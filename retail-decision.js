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

   ---------------------------------------------------------
   Recommendation Card — one shape, every category
   ---------------------------------------------------------
   Every item in every category (coaching / atRisk / attention /
   transfers / reorders) is normalised to the same card, so the UI
   never branches per category:

     { category, title, context, reason, metricLabel, metricValue,
       severity: 'low'|'medium'|'high', evidence: [toolKey, ...] }

   evidence lists every tool that contributed to a card. A card
   with more than one entry in `evidence` is corroborated — two
   independent tools agree, not just one report's own numbers.

   ---------------------------------------------------------
   v3 (this phase): storeReview, inventoryValidity, inventoryAudit
   and stockAdjustment are wired up.
     - coaching: from storeReview alone.
     - atRisk: from inventoryValidity alone (Cut Piece styles).
     - attention: inventoryAudit's shortage/excess merged with
       stockAdjustment's OUT/IN by barcode. The same barcode
       showing up in both tools' equivalent list (audit shortage +
       stock-adjustment OUT, or audit excess + stock-adjustment IN)
       is corroborated — two independent reconciliations agreeing,
       not one tool's opinion — and is ranked above single-source
       findings.
   transfers/reorders still stay empty arrays — correct
   degradation, not a gap:
     - reorders deliberately waits for inventoryValidity's Cut
       Piece styles to be cross-referenced against storeReview's
       *per-style* sell-through, which storeReview's aggregate
       summary doesn't yet expose (only dept/brand/size level).
       Recommending "reorder" on a broken run without knowing if
       it even sells would actively mislead a manager, so this
       stays empty rather than guess.
     - transfers needs multi-store data correlated across stores,
       not yet wired in.
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

/* How many items (highest value / most corroborated first) to
   surface per category. */
var AT_RISK_TOP_N = 20;
var ATTENTION_TOP_N = 20;

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

/* ---------- Recommendation Card ----------
   The one shape every category's items are normalised to. */
function makeCard(opts) {
  return {
    category: opts.category,
    title: opts.title,
    context: opts.context || null,
    reason: opts.reason,
    metricLabel: opts.metricLabel || '',
    metricValue: opts.metricValue,
    severity: opts.severity || 'medium',
    evidence: opts.evidence || []
  };
}

function inr(n) {
  return '₹' + Math.round(n || 0).toLocaleString('en-IN');
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
      var gapPctRounded = Math.round(gapPct * 1000) / 10;
      out.push({
        _sort: gapPct,
        card: makeCard({
          category: 'coaching',
          title: s.name,
          reason: 'Average Bill Value is ' + gapPctRounded + '% below store average — consider coaching.',
          metricValue: inr(s.abv) + ' vs ' + inr(storeAtv),
          severity: gapPct >= 0.35 ? 'high' : (gapPct >= 0.25 ? 'medium' : 'low'),
          evidence: ['storeReview']
        })
      });
    }
  });
  out.sort(function (a, b) { return b._sort - a._sort; });
  return out.map(function (x) { return x.card; });
}

/* ---------- at risk (from Inventory Validity Console) ----------
   Cut Piece = a broken size run (1-2 sizes left of a style that
   should have 3+). Flagging the highest-value ones first: that's
   where the most capital is tied up in stock that isn't a
   sellable run any more. Severity follows how broken the run is:
   one size left is worse than two. */
function atRiskFrom(inventoryValidity) {
  if (!inventoryValidity || !inventoryValidity.data) return [];
  var d = inventoryValidity.data;
  if (!Array.isArray(d.topCutPiece)) return [];
  return d.topCutPiece.slice(0, AT_RISK_TOP_N).map(function (u) {
    var sizeCount = u.sizeCount || 0;
    return makeCard({
      category: 'atRisk',
      title: u.style,
      context: [u.store, u.brand].filter(Boolean).join(' · ') || null,
      reason: 'Incomplete size run (' + sizeCount + ' size' + (sizeCount === 1 ? '' : 's') + ' left)',
      metricValue: inr(u.value) + ' · ' + u.qty + ' pcs',
      severity: sizeCount <= 1 ? 'high' : (sizeCount === 2 ? 'medium' : 'low'),
      evidence: ['inventoryValidity']
    });
  });
}

/* ---------- attention (Inventory Audit + Stock IN/OUT Adjustment) ----------
   Inventory Audit's "Shortage" (system qty > physical qty) is the
   same real-world phenomenon as Stock Adjustment's "OUT" list
   (barcode in system, not found in a physical scan): stock the
   system believes exists but isn't there. Likewise Audit's
   "Excess" and Stock Adjustment's "IN" list (found in a scan, not
   in system) are the same phenomenon from the other direction.
   Merging both tools' lists by barcode means a barcode flagged by
   BOTH independent reconciliations is corroborated — a much
   stronger signal than either tool's own opinion — and is ranked
   first regardless of value. */
function mergeByBarcode(listA, listB) {
  var map = {};
  function ingest(list, sourceTool) {
    (list || []).forEach(function (x) {
      if (!x || !x.barcode) return;
      var m = map[x.barcode];
      if (!m) { m = map[x.barcode] = { barcode: x.barcode, style: '', desc: '', qty: 0, value: 0, sources: [] }; }
      m.qty = Math.max(m.qty, Number(x.qty) || 0);
      m.value = Math.max(m.value, Number(x.value) || 0);
      if (!m.style && x.style) m.style = x.style;
      if (!m.desc && x.desc) m.desc = x.desc;
      if (m.sources.indexOf(sourceTool) === -1) m.sources.push(sourceTool);
    });
  }
  ingest(listA.list, listA.tool);
  ingest(listB.list, listB.tool);
  return Object.keys(map).map(function (k) { return map[k]; });
}

function attentionCardsFor(merged, type) {
  var label = type === 'shortage' ? 'Shortage' : 'Excess';
  var reasonText = type === 'shortage'
    ? 'System shows stock not found in a physical count.'
    : 'Found in a physical count but not in the system.';
  return merged.map(function (m) {
    var corroborated = m.sources.length > 1;
    return {
      _sort: (corroborated ? 1 : 0) * 1e12 + m.value,
      card: makeCard({
        category: 'attention',
        title: (m.style || m.barcode),
        context: m.desc || m.barcode,
        reason: label + (corroborated ? ' — confirmed independently by both Inventory Audit and Stock IN/OUT Adjustment.' : '. ' + reasonText),
        metricValue: inr(m.value) + ' · ' + m.qty + ' units',
        severity: corroborated ? 'high' : 'medium',
        evidence: m.sources.slice()
      })
    };
  });
}

function attentionFrom(inventoryAudit, stockAdjustment) {
  var auditData = inventoryAudit && inventoryAudit.data;
  var stockData = stockAdjustment && stockAdjustment.data;
  if (!auditData && !stockData) return [];

  var shortageMerged = mergeByBarcode(
    { list: auditData && auditData.topShortage, tool: 'inventoryAudit' },
    { list: stockData && stockData.topOut, tool: 'stockAdjustment' }
  );
  var excessMerged = mergeByBarcode(
    { list: auditData && auditData.topExcess, tool: 'inventoryAudit' },
    { list: stockData && stockData.topIn, tool: 'stockAdjustment' }
  );

  var all = attentionCardsFor(shortageMerged, 'shortage').concat(attentionCardsFor(excessMerged, 'excess'));
  all.sort(function (a, b) { return b._sort - a._sort; });
  return all.slice(0, ATTENTION_TOP_N).map(function (x) { return x.card; });
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
    attention: attentionFrom(summaries.inventoryAudit, summaries.stockAdjustment),
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

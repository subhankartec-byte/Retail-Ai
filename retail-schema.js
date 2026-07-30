/* ============================================================
   retail-schema.js — Retail AI · canonical row model (Phase A,
   AI Intelligence Core)
   ------------------------------------------------------------
   Pure JS, zero dependencies. Browser: window.RetailSchema.
   Node (tests): module.exports.

   WHAT THIS FILE IS
   ------------------------------------------------------------
   A single canonical row shape for two retail business concepts
   — a sale LINE (one POS transaction line) and a stock ITEM (one
   merchandise fact: SOH, a reconciliation line, an adjustment
   line) — plus one pure adapter function per already-integrated
   Decision Engine tool (storeReview / inventoryValidity /
   inventoryAudit / stockAdjustment) that reduces an array of
   canonical rows into the EXACT object shape that tool already
   hands to RetailDecision.saveSummary() today.

   WHAT THIS FILE IS NOT (Phase A scope)
   ------------------------------------------------------------
   - Not wired into any tool page or into retail-decision.js.
     Both are untouched; this is new, freestanding infrastructure.
   - Not a file parser / column mapper. Canonical rows are the
     OUTPUT of parsing + mapping (a future phase's job), never
     built from a raw file here.
   - No AI, no network call, no localStorage access. 100% pure
     functions in, data out.

   DESIGN PRINCIPLES (approved architecture, AI Intelligence Core
   design doc, Phase A)
   ------------------------------------------------------------
   1. Thin adapters never duplicate business logic a tool already
      owns. inventoryValidity / inventoryAudit / stockAdjustment
      classify their own data (Valid/Cut Piece/Free Size,
      Shortage/Excess/Match/Mismatch/Unidentified, Bring-IN/Take-
      OUT) before that data ever becomes a canonical row — this
      file only rolls already-classified rows up into totals and
      top-N lists, exactly like each tool's own saveSummary call
      already does today.
   2. Thick adapters (storeReview only) reproduce ONLY logic that
      is genuinely required because the source data is still raw
      (POS bill-line facts, not pre-aggregated). Every formula
      below (agg/billsOf/festive-segment) is a line-by-line port
      of the actual functions in "Store_Review a1.html" — not a
      re-derivation from memory.
   3. The schema is organised around business concepts (identity /
      descriptive attributes / location / quantity / money /
      transaction context / classification / AI intelligence),
      not around any one tool's internal variable names, so a
      future, unrelated tool can reuse it without a redesign.
   4. `intelligence.*` is reserved for future AI enrichment
      (retailer detection, brand/category/gender confidence,
      pricing tier — AI Intelligence Core Phases C/D). Every field
      is null/unset in Phase A. Adding a new enrichment field later
      only ever touches this one sub-object — no adapter, no other
      field, and no existing consumer needs to change.
   5. Two genuinely different tools' classification vocabularies
      are kept as separate, honestly-named fields
      (`classification.reconStatus` for Inventory Audit's
      value-based reconciliation vs. `classification.presenceStatus`
      for Stock Adjustment's presence-only diff) rather than forced
      into one shared enum — this project's own repeated lesson is
      that things which look similar across tools often aren't.

   CANONICAL ROW SHAPE
   ------------------------------------------------------------
   {
     recordType: 'sale' | 'stock',        // required

     // ---- identity ("what item is this") ----
     styleCode: string|null,
     barcode:   string|null,
     sku:       string|null,

     // ---- descriptive attributes (retail taxonomy) ----
     brand:         string|null,
     description:   string|null,
     colour:        string|null,
     size:          string|null,          // already-resolved label, not a raw grid code
     category:      string|null,
     department:    string|null,          // universal concept: POS dept (sale) or merch dept (stock)
     gender:        string|null,
     productFamily: string|null,
     season:        string|null,

     // ---- location ----
     storeCode: string|null,

     // ---- quantity ----
     qty:         number|null,   // primary quantity — meaning is row-type-specific, documented per adapter
     systemQty:   number|null,   // reconciliation: what the system believes (inventoryAudit)
     physicalQty: number|null,   // reconciliation: what was physically counted (inventoryAudit)
     sizeCount:   number|null,   // style-level: distinct sizes present (inventoryValidity)

     // ---- money ----
     mrp:        number|null,
     value:      number|null,
     discount:   number|null,
     lossValue:  number|null,    // inventoryAudit shortage rows only
     gainValue:  number|null,    // inventoryAudit excess rows only

     // ---- transaction context: recordType:'sale' only, else null ----
     transaction: {
       billId:    string|null,
       date:      Date|string|null,
       staffName: string|null,
       subclass:  string|null,   // drives festive-segment derivation, see festiveSegmentOf()
       isOnOffer: boolean,
       isReturn:  boolean
     } | null,

     // ---- classification: recordType:'stock' only, else null ----
     classification: {
       sizeRunClass:    'Valid'|'CutPiece'|'FreeSize'|null,                        // inventoryValidity
       reconStatus:     'Shortage'|'Excess'|'Match'|'Mismatch'|'Unidentified'|null, // inventoryAudit
       presenceStatus:  'BringIn'|'TakeOut'|'Common'|null                          // stockAdjustment
     } | null,

     // ---- AI intelligence enrichment — reserved, always null in Phase A ----
     intelligence: {
       retailer: string|null, retailerConfidence: number|null,
       brandConfidence: number|null, categoryConfidence: number|null,
       genderConfidence: number|null, productFamilyConfidence: number|null,
       pricingTier: string|null,
       source: 'file'|'ai'|null
     }
   }
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RetailSchema = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var RECORD_TYPES = ['sale', 'stock'];

/* ---------- factories ---------- */
function makeRow(recordType, fields) {
  fields = fields || {};
  if (RECORD_TYPES.indexOf(recordType) === -1) {
    throw new Error('RetailSchema.makeRow: recordType must be "sale" or "stock", got "' + recordType + '"');
  }
  var row = {
    recordType: recordType,
    styleCode: null, barcode: null, sku: null,
    brand: null, description: null, colour: null, size: null,
    category: null, department: null, gender: null, productFamily: null, season: null,
    storeCode: null,
    qty: null, systemQty: null, physicalQty: null, sizeCount: null,
    mrp: null, value: null, discount: null, lossValue: null, gainValue: null,
    transaction: recordType === 'sale' ? {
      billId: null, date: null, staffName: null, subclass: null,
      isOnOffer: false, isReturn: false
    } : null,
    classification: recordType === 'stock' ? {
      sizeRunClass: null, reconStatus: null, presenceStatus: null
    } : null,
    intelligence: {
      retailer: null, retailerConfidence: null,
      brandConfidence: null, categoryConfidence: null,
      genderConfidence: null, productFamilyConfidence: null,
      pricingTier: null, source: null
    }
  };
  for (var k in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
    if (k === 'transaction' && row.transaction && fields.transaction) {
      for (var tk in fields.transaction) row.transaction[tk] = fields.transaction[tk];
    } else if (k === 'classification' && row.classification && fields.classification) {
      for (var ck in fields.classification) row.classification[ck] = fields.classification[ck];
    } else if (k === 'intelligence' && fields.intelligence) {
      for (var ik in fields.intelligence) row.intelligence[ik] = fields.intelligence[ik];
    } else {
      row[k] = fields[k];
    }
  }
  return row;
}
function makeSaleRow(fields) { return makeRow('sale', fields); }
function makeStockRow(fields) { return makeRow('stock', fields); }

function isValidRow(row) {
  return !!row && RECORD_TYPES.indexOf(row.recordType) !== -1;
}

/* ---------- small shared helpers ---------- */
function round(n) { return Math.round(n || 0); }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
function sumBy(rows, fn) { return rows.reduce(function (a, r) { return a + num(fn(r)); }, 0); }
function topNByValue(rows, valueFn, n) {
  return rows.slice().sort(function (a, b) { return num(valueFn(b)) - num(valueFn(a)); }).slice(0, n);
}

/* ============================================================
   1. storeReview  —  THICK adapter (Store_Review a1.html:613-838)
   ------------------------------------------------------------
   The source file is genuinely bill-line-level POS data with no
   pre-aggregation, so — unlike the other three adapters — this
   one must reproduce the tool's own aggregation formulas
   (agg/billsOf/festive-segment) rather than just reshape
   already-computed results. Ported line-by-line from the
   functions at Store_Review a1.html:613 (agg), 604 (billsOf),
   738 (festive-segment rule).
   ============================================================ */
function billsOf(rows, rule) {
  var net = {}, ret = {};
  rows.forEach(function (r) {
    var bill = (r.transaction && r.transaction.billId != null) ? r.transaction.billId : '';
    net[bill] = (net[bill] || 0) + num(r.value);
    if (num(r.qty) < 0 || (r.transaction && r.transaction.isReturn)) ret[bill] = 1;
  });
  var ks = Object.keys(net);
  if (rule === 'distinct') return ks.length;
  if (rule === 'noret') return ks.filter(function (k) { return !ret[k]; }).length;
  return ks.filter(function (k) { return Math.abs(net[k]) > 0.005; }).length;   // default 'net0'
}
function agg(rows, rule) {
  var val = sumBy(rows, function (r) { return r.value; });
  var qty = sumBy(rows, function (r) { return r.qty; });
  var bills = billsOf(rows, rule);
  var mrp = sumBy(rows, function (r) { return num(r.mrp) * num(r.qty); });
  return {
    val: val, qty: qty, bills: bills,
    atv: bills ? val / bills : 0,
    upt: bills ? qty / bills : 0,
    asp: qty ? val / qty : 0,
    mrp: mrp
  };
}
function groupSum(rows, keyFn) {
  var m = {};
  rows.forEach(function (r) {
    var k = keyFn(r);
    if (k === null || k === undefined || k === '') return;
    if (!m[k]) m[k] = { qty: 0, val: 0 };
    m[k].qty += num(r.qty);
    m[k].val += num(r.value);
  });
  return m;
}
function sortedEntries(m) {
  return Object.keys(m).map(function (k) { return { key: k, qty: m[k].qty, val: m[k].val }; })
    .sort(function (a, b) { return b.val - a.val; });
}
/* Faithful port of Store_Review a1.html:738 — a subclass containing
   "NON" collapses to NON FESTIVE, "FESTIVE" collapses to FESTIVE,
   otherwise the raw subclass is its own segment. */
function festiveSegmentOf(row) {
  var s = row.transaction && row.transaction.subclass;
  if (!s || s === 'NA') return null;
  if (s.indexOf('NON') !== -1) return 'NON FESTIVE';
  if (s.indexOf('FESTIVE') !== -1) return 'FESTIVE';
  return s;
}
function sizeSortKeyOf(size) {
  if (typeof RetailProfiles !== 'undefined' && RetailProfiles.sizeSortKey) {
    return RetailProfiles.sizeSortKey('unknown', size);
  }
  return String(size || '');   // graceful fallback if retail-profiles.js isn't loaded
}
function totalsShape(a) {
  return { value: round(a.val), bills: a.bills, qty: a.qty, atv: round(a.atv), upt: +a.upt.toFixed(2), asp: round(a.asp) };
}

/**
 * toStoreReviewSummary — reproduces Store_Review a1.html's AI_CONTEXT
 * object (the exact payload it already sends to
 * RetailDecision.saveSummary('storeReview', ...)).
 *
 * @param {Array} currentRows  canonical 'sale' rows for the period being reviewed
 * @param {Array|null} [compareRows] canonical 'sale' rows for the comparison period.
 *   IMPORTANT: whether a compare period exists is caller INTENT, not data —
 *   pass null/undefined when the user configured no comparison period at all;
 *   pass an array (which may legitimately be empty, []) when a comparison
 *   period WAS configured but happens to have no matching rows. The real
 *   tool makes the same distinction (periodB() !== null vs. its rows being
 *   empty) — confirmed by a live round-trip test against Store_Review
 *   a1.html, where a configured-but-empty compare period still produces a
 *   non-null comparePeriod/compareTotals (all zeros), not null.
 * @param {Object} context
 * @param {string} context.periodLabel
 * @param {number} context.periodDays
 * @param {string} [context.comparePeriodLabel]
 * @param {number} [context.comparePeriodDays]
 * @param {'net0'|'noret'|'distinct'} context.billRule
 */
function toStoreReviewSummary(currentRows, compareRows, context) {
  currentRows = (currentRows || []).filter(isValidRow);
  context = context || {};
  var rule = context.billRule || 'net0';
  var hasCompare = compareRows != null;
  var compareRowsClean = hasCompare ? compareRows.filter(isValidRow) : [];

  var t = agg(currentRows, rule);
  var l = hasCompare ? agg(compareRowsClean, rule) : null;

  var offerRows = currentRows.filter(function (r) { return r.transaction && r.transaction.isOnOffer; });
  var fullRows = currentRows.filter(function (r) { return !(r.transaction && r.transaction.isOnOffer); });
  var offC = agg(offerRows, rule), fulC = agg(fullRows, rule);

  var discC = (t.mrp > t.val && t.mrp > 0) ? (t.mrp - t.val) / t.mrp * 100 : null;

  var weekendRows = currentRows.filter(function (r) {
    var d = r.transaction && r.transaction.date ? new Date(r.transaction.date) : null;
    if (!d || isNaN(d.getTime())) return false;
    var dow = d.getDay();
    return dow === 5 || dow === 6 || dow === 0;
  });
  var wt = agg(weekendRows, rule);

  var staffNames = [];
  currentRows.forEach(function (r) {
    var n = r.transaction && r.transaction.staffName;
    if (n && staffNames.indexOf(n) === -1) staffNames.push(n);
  });
  var staff = staffNames
    .map(function (n) {
      var rows = currentRows.filter(function (r) { return r.transaction && r.transaction.staffName === n; });
      var a = agg(rows, rule);
      return { name: String(n).slice(0, 60), bills: a.bills, qty: a.qty, value: round(a.val), abv: a.bills ? round(a.val / a.bills) : 0, _sort: a.val };
    })
    .sort(function (x, y) { return y._sort - x._sort; })
    .slice(0, 30)
    .map(function (x) { return { name: x.name, bills: x.bills, qty: x.qty, value: x.value, abv: x.abv }; });

  var departments = sortedEntries(groupSum(currentRows, function (r) { return r.department; }))
    .slice(0, 30)
    .map(function (o) { return { dept: String(o.key).slice(0, 60), qty: o.qty, value: round(o.val) }; });

  var festive = sortedEntries(groupSum(currentRows, festiveSegmentOf))
    .slice(0, 15)
    .map(function (o) { return { segment: String(o.key).slice(0, 60), qty: o.qty, value: round(o.val) }; });

  var hasBrandData = currentRows.some(function (r) { return !!r.brand; });
  var brand = hasBrandData
    ? sortedEntries(groupSum(currentRows, function (r) { return r.brand || 'Unmapped'; }))
        .slice(0, 15)
        .map(function (o) { return { brand: String(o.key).slice(0, 60), qty: round(o.qty), value: round(o.val) }; })
    : null;

  var sizeCurve = sortedEntries(groupSum(currentRows.filter(function (r) { return r.size && String(r.size).toUpperCase() !== 'FS'; }), function (r) { return r.size; }))
    .sort(function (a, b) { return sizeSortKeyOf(a.key) - sizeSortKeyOf(b.key); })
    .slice(0, 30)
    .map(function (o) { return { size: String(o.key).slice(0, 60), qty: o.qty }; });

  return {
    currency: 'INR',
    period: { label: context.periodLabel || '', days: num(context.periodDays) },
    comparePeriod: hasCompare ? { label: context.comparePeriodLabel || '', days: num(context.comparePeriodDays) } : null,
    billRule: rule,
    totals: totalsShape(t),
    compareTotals: (hasCompare && l) ? totalsShape(l) : null,
    discountPctOnMrp: discC != null ? +discC.toFixed(1) : null,
    offerMix: { onOfferValue: round(offC.val), fullPriceValue: round(fulC.val) },
    weekend: { value: round(wt.val), shareOfPeriod: t.val ? +(100 * wt.val / t.val).toFixed(1) : 0 },
    staff: staff,
    departments: departments,
    festive: festive,
    brand: brand,
    sizeCurve: sizeCurve
  };
}

/* ============================================================
   2. inventoryValidity  —  THIN adapter
   ------------------------------------------------------------
   Canonical rows here are STYLE-level (one row per unique
   style+store+brand — the same grain Inventory_Validity_Console.
   html's own `units` array already uses), each already carrying
   classification.sizeRunClass. This adapter only re-groups and
   rolls up already-classified rows — it never re-derives
   Valid/Cut-Piece/Free-Size itself. Grouping-key rule (store when
   multi-store, else brand) ported from
   Inventory_Validity_Console.html:832.
   ============================================================ */
function toInventoryValiditySummary(canonicalRows) {
  var rows = (canonicalRows || []).filter(function (r) { return isValidRow(r) && r.recordType === 'stock'; });
  var storeSet = {};
  rows.forEach(function (r) { storeSet[r.storeCode || 'ALL'] = 1; });
  var multiStore = Object.keys(storeSet).length > 1;
  var groupKeyOf = multiStore
    ? function (r) { return r.storeCode || 'ALL'; }
    : function (r) { return r.brand || '(blank)'; };

  var groupMap = {};
  function ensure(g) {
    return groupMap[g] || (groupMap[g] = {
      key: g, styles: 0, valid: 0, cut: 0, free: 0,
      qtyTotal: 0, qtyValid: 0, qtyCut: 0, qtyFree: 0,
      valTotal: 0, valValid: 0, valCut: 0, valFree: 0
    });
  }
  rows.forEach(function (r) {
    var g = ensure(groupKeyOf(r));
    var cls = r.classification && r.classification.sizeRunClass;
    g.styles++; g.qtyTotal += num(r.qty); g.valTotal += num(r.value);
    if (cls === 'Valid') { g.valid++; g.qtyValid += num(r.qty); g.valValid += num(r.value); }
    else if (cls === 'CutPiece') { g.cut++; g.qtyCut += num(r.qty); g.valCut += num(r.value); }
    else if (cls === 'FreeSize') { g.free++; g.qtyFree += num(r.qty); g.valFree += num(r.value); }
  });
  var groupList = Object.keys(groupMap).map(function (k) { return groupMap[k]; });

  /* Faithful port of Inventory_Validity_Console.html:849-858 — multi-store
     groups sort alphabetically by store code; single-store (brand-keyed)
     groups put known W-house brand aliases first, then alphabetical. */
  var BRAND_PRIORITY = { w: 0, wforwoman: 0, folksong: 1, wishful: 2 };
  var normKey = function (s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); };
  groupList.sort(function (a, b) {
    if (!multiStore) {
      var pa = BRAND_PRIORITY[normKey(a.key)], pb = BRAND_PRIORITY[normKey(b.key)];
      if (pa === undefined) pa = 9;
      if (pb === undefined) pb = 9;
      if (pa !== pb) return pa - pb;
    }
    return String(a.key).localeCompare(String(b.key));
  });

  var totals = groupList.reduce(function (t, g) {
    ['styles', 'valid', 'cut', 'free', 'qtyTotal', 'qtyValid', 'qtyCut', 'qtyFree', 'valTotal', 'valValid', 'valCut', 'valFree']
      .forEach(function (k) { t[k] += g[k]; });
    return t;
  }, { styles: 0, valid: 0, cut: 0, free: 0, qtyTotal: 0, qtyValid: 0, qtyCut: 0, qtyFree: 0, valTotal: 0, valValid: 0, valCut: 0, valFree: 0 });

  var groups = groupList.map(function (g) {
    return { key: g.key, styles: g.styles, valid: g.valid, cut: g.cut, free: g.free,
      qtyTotal: g.qtyTotal, qtyCut: g.qtyCut, valTotal: round(g.valTotal), valCut: round(g.valCut) };
  });

  var topCutPiece = topNByValue(
    rows.filter(function (r) { return r.classification && r.classification.sizeRunClass === 'CutPiece'; }),
    function (r) { return r.value; }, 20
  ).map(function (r) {
    return { store: r.storeCode, style: r.styleCode, brand: r.brand, dept: r.department, qty: r.qty, value: round(r.value), sizeCount: r.sizeCount };
  });

  return { totals: totals, groups: groups, topCutPiece: topCutPiece, multiStore: multiStore };
}

/* ============================================================
   3. inventoryAudit  —  THIN adapter, with one documented exception
   ------------------------------------------------------------
   Shortage/Excess/Match/Unidentified counts and values ARE
   straightforward per-row sums, filtered by
   classification.reconStatus — safe to derive here.

   mm_pairs/mm_units/mm_val are NOT: they come from Inventory_Audit
   _Toolf1.html's pairing algorithm (classifyVariances(), which
   links a deficit row to one-or-more surplus rows by matching
   style or equal value). That is a RELATIONAL fact about pairs of
   rows, not a property of any single row, and reconstructing it
   here would mean re-implementing the tool's own pairing logic —
   exactly what principle 1 (thin adapters never duplicate business
   logic) forbids. So mismatch totals are accepted as a pass-through
   via context.mismatchTotals, exactly as cls.summary is passed
   through unchanged in the tool's own saveDecisionSummary() today.
   ============================================================ */
function toInventoryAuditSummary(canonicalRows, context) {
  var rows = (canonicalRows || []).filter(function (r) { return isValidRow(r) && r.recordType === 'stock'; });
  context = context || {};
  var mm = context.mismatchTotals || { pairs: 0, units: 0, value: 0 };

  var byStatus = function (status) {
    return rows.filter(function (r) { return r.classification && r.classification.reconStatus === status; });
  };
  var shortage = byStatus('Shortage'), excess = byStatus('Excess'),
      matched = byStatus('Match'), unident = byStatus('Unidentified');

  var summary = {
    mm_pairs: mm.pairs, mm_units: mm.units, mm_val: mm.value,
    sh_lines: shortage.length, sh_units: sumBy(shortage, function (r) { return r.qty; }), sh_val: sumBy(shortage, function (r) { return r.lossValue; }),
    ex_lines: excess.length, ex_units: sumBy(excess, function (r) { return r.qty; }), ex_val: sumBy(excess, function (r) { return r.gainValue; }),
    matched: matched.length, match_units: sumBy(matched, function (r) { return r.systemQty; }),
    unident: unident.length, unident_units: sumBy(unident, function (r) { return r.physicalQty; })
  };

  var topShortage = topNByValue(shortage, function (r) { return r.lossValue; }, 20)
    .map(function (r) { return { barcode: r.barcode, style: r.styleCode, desc: r.description, brand: r.brand, qty: r.qty, value: round(r.lossValue) }; });
  var topExcess = topNByValue(excess, function (r) { return r.gainValue; }, 20)
    .map(function (r) { return { barcode: r.barcode, style: r.styleCode, desc: r.description, brand: r.brand, qty: r.qty, value: round(r.gainValue) }; });

  return { summary: summary, topShortage: topShortage, topExcess: topExcess };
}

/* ============================================================
   4. stockAdjustment  —  THIN adapter
   ------------------------------------------------------------
   Presence-only diff (see classification.presenceStatus): a row
   is 'BringIn' (found physically, absent from system), 'TakeOut'
   (in system, absent physically), or 'Common' (present both
   sides — matches Stock_IN_OUT_Adjustment.html's own commonCount
   metric). No quantity-mismatch reconciliation here — that would
   be Inventory Audit's concept, not this tool's, and this project
   has already learned the hard way that conflating the two is
   wrong (PROJECT_STATUS.md Phase 6.4).
   ============================================================ */
function toStockAdjustmentSummary(canonicalRows) {
  var rows = (canonicalRows || []).filter(function (r) { return isValidRow(r) && r.recordType === 'stock'; });
  var inRows = rows.filter(function (r) { return r.classification && r.classification.presenceStatus === 'BringIn'; });
  var outRows = rows.filter(function (r) { return r.classification && r.classification.presenceStatus === 'TakeOut'; });
  var commonRows = rows.filter(function (r) { return r.classification && r.classification.presenceStatus === 'Common'; });

  var top = function (list) {
    return topNByValue(list, function (r) { return r.value; }, 20)
      .map(function (r) { return { barcode: r.barcode, style: r.styleCode, desc: r.description, qty: r.qty, value: round(r.value) }; });
  };

  return {
    totals: {
      inCount: inRows.length, inQty: sumBy(inRows, function (r) { return r.qty; }), inValue: round(sumBy(inRows, function (r) { return r.value; })),
      outCount: outRows.length, outQty: sumBy(outRows, function (r) { return r.qty; }), outValue: round(sumBy(outRows, function (r) { return r.value; })),
      commonCount: commonRows.length
    },
    topOut: top(outRows),
    topIn: top(inRows)
  };
}

return {
  makeRow: makeRow, makeSaleRow: makeSaleRow, makeStockRow: makeStockRow, isValidRow: isValidRow,
  toStoreReviewSummary: toStoreReviewSummary,
  toInventoryValiditySummary: toInventoryValiditySummary,
  toInventoryAuditSummary: toInventoryAuditSummary,
  toStockAdjustmentSummary: toStockAdjustmentSummary,
  RECORD_TYPES: RECORD_TYPES
};
}));

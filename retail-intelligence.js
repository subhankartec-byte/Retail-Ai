/* ============================================================
   retail-intelligence.js — Retail AI · rule-tier file & retailer
   classification (Phase B, AI Intelligence Core)
   ------------------------------------------------------------
   Pure JS, zero dependencies, zero network calls. Browser:
   window.RetailIntelligence. Node (tests): module.exports.

   WHAT THIS FILE IS
   ------------------------------------------------------------
   The deterministic RULE tier of the two detection capabilities
   the locked AI Intelligence Core architecture calls for
   (PROJECT_STATUS.md §3.7, Decision 1):

     classifyFileType(sheets) — "what kind of file is this"
       (SOH / Sales / MB51 / GRN / IST / store master / Blue Dart
       waybill template), generalizing BlueDart_Etail_Waybill_
       Builder1.html's WB.classify() (structural header-pattern
       matching) and retail-import.js's findHeaderRow() (SOH
       synonym-scored header detection) into ONE extensible,
       scored rule table instead of two separate ad-hoc
       implementations.

     detectRetailer(sheets) — "which retailer's file is this",
       generalizing retail-import.js's detectHouse() (hardcoded
       W_BRANDS/AU_BRANDS majority vote + a Jaypore-only header
       fingerprint) into a data-driven signature registry any
       future retailer can be added to without touching detection
       logic, plus a genuine 0–1 confidence score (the original
       only ever returned a bare house name or 'unknown').

   WHAT THIS FILE IS NOT (Phase B scope)
   ------------------------------------------------------------
   - No AI, no network call, no fetch, no Promise. 100% synchronous,
     deterministic, pure functions. The AI fallback tier this
     architecture calls for is explicitly Phase C's job
     (api/retail-knowledge.js) — not started, not stubbed here.
   - Not wired into any tool page. Standalone, like retail-schema.js.
   - Does not decide UI behaviour (auto-identify / confirm banner /
     Universal Retail Mode). This module only returns a fileType /
     retailer guess plus a confidence score and level; deciding what
     to DO with that confidence is the calling code's job, in a
     later phase.
   - Does not cover Inventory_Audit_Toolf1.html's 3-file upload
     (system/master/physical) or Stock_IN_OUT_Adjustment.html's
     2-file upload. Checked both before writing this file: neither
     one auto-classifies its inputs by content — each uses fixed,
     separately-labelled drop zones instead (Inventory Audit:
     #drop-master/#drop-physical/#drop-system; Stock IN/OUT: user-
     driven column mapping per upload). There is no existing
     detection logic to generalize for either, so none is invented
     here — a real, documented boundary, not an oversight.

   REUSE
   ------------------------------------------------------------
   When retail-import.js is loaded on the same page, this module
   delegates header-row detection and column mapping to
   RetailImport.findHeaderRow()/mapColumns() (proven, already-
   tested code) rather than re-implementing synonym scoring here —
   this file only replaces retail-import.js's DECISION step
   (the hardcoded 2-brand-set + 1-fingerprint check), not its
   detection mechanics. When RetailProfiles is loaded, the retailer
   signature registry's brand-code lists are pulled from
   RetailProfiles.PROFILES instead of being duplicated. Both are
   optional — this file still works standalone with a smaller
   built-in fallback, same graceful-degradation convention every
   other shared module in this repo already follows.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RetailIntelligence = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ---------- shared helpers ---------- */
function trim(v) { return String(v == null ? '' : v).trim(); }
function normLoose(v) { return trim(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/* Flatten the first `scan` rows of a sheet into normalised header
   text — the same "does any of these header cells look like X"
   technique BlueDart's WB.classify() already uses (its own norm()
   only trims; case-insensitivity there comes from the /i regex
   flag, reproduced here the same way). */
function flatHeaderText(rows, scan) {
  return (rows || []).slice(0, scan || 6)
    .reduce(function (a, r) { return a.concat(r || []); }, [])
    .map(trim);
}
function anyHeaderMatches(flat, re) {
  return flat.some(function (c) { return re.test(c); });
}

function clamp01(n) { return n < 0 ? 0 : (n > 1 ? 1 : n); }

/* Phase B's initial confidence banding. Tunable — Phase C's UX
   (auto-identify / confirm banner / Universal Retail Mode) is the
   phase that actually acts on these thresholds; this file only
   needs to produce a defensible, consistent score to band. */
var HIGH_MIN = 0.75, MEDIUM_MIN = 0.4;
function confidenceLevel(score) {
  if (score >= HIGH_MIN) return 'high';
  if (score >= MEDIUM_MIN) return 'medium';
  return 'low';
}

/* ============================================================
   1. File-type classification
   ============================================================ */
var FILE_TYPES = ['soh', 'sales', 'mb51', 'grn', 'ist', 'storeMaster', 'waybillTemplate'];

/* ---- structural rules ported from BlueDart_Etail_Waybill_
   Builder1.html's WB.classify() (lines ~292-309), unchanged
   regexes, generalised into scored rule entries instead of an
   if/else priority chain. ---- */
var IST_D = /donor|^from\s*(store|loc|branch)/i, IST_R = /receiv|^to\s*(store|loc|branch)/i, IST_S = /style/i;

function testWaybillTemplate(sheets) {
  for (var i = 0; i < sheets.length; i++) {
    var flat = flatHeaderText(sheets[i].rows, 6);
    if (anyHeaderMatches(flat, /^Reference No \*/) && anyHeaderMatches(flat, /^Billing Area/)) return 0.9;
  }
  return 0;
}
function testMb51(sheets) {
  for (var i = 0; i < sheets.length; i++) {
    var flat = flatHeaderText(sheets[i].rows, 6);
    if (anyHeaderMatches(flat, /^Supplying Plant$/i) && anyHeaderMatches(flat, /^Movement Type$/i) && anyHeaderMatches(flat, /^Reference$/i)) return 0.9;
  }
  return 0;
}
function testGrn(sheets) {
  for (var i = 0; i < sheets.length; i++) {
    var flat = flatHeaderText(sheets[i].rows, 6);
    if (anyHeaderMatches(flat, /^PO Number$/i) && anyHeaderMatches(flat, /^To Location$/i) && anyHeaderMatches(flat, /^From Location$/i)) return 0.9;
  }
  return 0;
}
function testIst(sheets) {
  for (var i = 0; i < sheets.length; i++) {
    var rows = sheets[i].rows || [];
    var limit = Math.min(rows.length, 15);
    for (var r = 0; r < limit; r++) {
      var cells = (rows[r] || []).map(trim);
      if (cells.some(function (c) { return IST_D.test(c); }) &&
          cells.some(function (c) { return IST_R.test(c); }) &&
          cells.some(function (c) { return IST_S.test(c); })) return 0.8;
    }
  }
  return 0;
}
function testStoreMaster(sheets) {
  for (var i = 0; i < sheets.length; i++) {
    var flat = flatHeaderText(sheets[i].rows, 6);
    if (anyHeaderMatches(flat, /store\s*code\s*\/?\s*sap\s*code/i) ||
        (anyHeaderMatches(flat, /^STOREID$/i) && anyHeaderMatches(flat, /Store Address/i)) ||
        anyHeaderMatches(flat, /Complete Address/i)) return 0.9;
  }
  return 0;
}

/* ---- Sales (POS Bill Wise Item List), ported from Store_Review
   a1.html's own check: `has(raw[0],['BillNo','Bill No'])`. Scored
   up when corroborating columns are also present, but a bare
   BillNo match alone is still enough to flag it — same as the
   source tool, which relies on BillNo alone. ---- */
function testSales(sheets) {
  var best = 0;
  for (var i = 0; i < sheets.length; i++) {
    var flat = flatHeaderText(sheets[i].rows, 3);
    if (!anyHeaderMatches(flat, /^Bill\s*No$/i)) continue;
    var score = 0.6;
    if (anyHeaderMatches(flat, /^Salesman$|^Sales\s*Man$/i)) score += 0.15;
    if (anyHeaderMatches(flat, /^Quantity$|^Qty$/i)) score += 0.15;
    if (score > best) best = score;
  }
  return clamp01(best);
}

/* ---- SOH, delegates to RetailImport.findHeaderRow() when
   available (the exact same synonym-scored detection Inventory_
   Validity_Console.html already relies on) rather than duplicating
   its ~20-field FIELDS table here. hits>=6 is retail-import.js's
   own "confident early exit" threshold (findHeaderRow, line 82) —
   reused as the band boundary here too. Falls back to a small
   built-in synonym check when retail-import.js isn't loaded on the
   page, so this module still works standalone. ---- */
var SOH_FALLBACK_SYNONYMS = ['style code', 'style', 'article', 'sku', 'ean', 'barcode', 'soh qty', 'soh', 'mrp', 'brand'];
function testSoh(sheets) {
  var best = 0;
  for (var i = 0; i < sheets.length; i++) {
    var rows = sheets[i].rows || [];
    if (typeof RetailImport !== 'undefined' && RetailImport.findHeaderRow) {
      var hdr = RetailImport.findHeaderRow(rows);
      var score = hdr.hits >= 6 ? 0.9 : hdr.hits >= 3 ? 0.55 : hdr.hits > 0 ? 0.25 : 0;
      if (score > best) best = score;
    } else {
      var flat = flatHeaderText(rows, 25).map(normLoose);
      var hits = 0;
      SOH_FALLBACK_SYNONYMS.forEach(function (syn) { if (flat.indexOf(syn) !== -1) hits++; });
      var score2 = hits >= 4 ? 0.7 : hits >= 2 ? 0.4 : hits > 0 ? 0.2 : 0;
      if (score2 > best) best = score2;
    }
  }
  return best;
}

var FILE_TYPE_RULES = [
  { type: 'waybillTemplate', test: testWaybillTemplate },
  { type: 'mb51', test: testMb51 },
  { type: 'grn', test: testGrn },
  { type: 'ist', test: testIst },
  { type: 'storeMaster', test: testStoreMaster },
  { type: 'sales', test: testSales },
  { type: 'soh', test: testSoh }
];

/**
 * classifyFileType — deterministic, rule-tier only file-type guess.
 * @param {Array<{name:string, rows:Array<Array>}>} sheets  same shape
 *   BlueDart_Etail_Waybill_Builder1.html's sheetsFromBuffer() already
 *   produces. A single-sheet caller can pass [{name:'Sheet1', rows}].
 * @returns {{fileType:string, confidence:number, level:string, source:'rules'}}
 *   fileType is 'unknown' when no rule scores above 0.
 */
function classifyFileType(sheets) {
  sheets = sheets || [];
  var best = { type: 'unknown', score: 0 };
  FILE_TYPE_RULES.forEach(function (rule) {
    var score = clamp01(rule.test(sheets) || 0);
    if (score > best.score) best = { type: rule.type, score: score };
  });
  return {
    fileType: best.score > 0 ? best.type : 'unknown',
    confidence: best.score,
    level: confidenceLevel(best.score),
    source: 'rules'
  };
}

/* ============================================================
   2. Retailer signature registry
   ============================================================ */

/* Jaypore has no brand column in its SOH export — the only known
   retailer today detected structurally instead of by brand code,
   ported from retail-import.js's detectHouse() (World + LOB Desc +
   Divison header fingerprint). Keyed by RetailImport.FIELDS field
   names so it composes directly with RetailImport.mapColumns()'s
   output when that module is loaded. */
var HEADER_FINGERPRINTS = {
  jaypore: ['world', 'lob', 'division']
};

/* Built-in fallback registry, used only when RetailProfiles isn't
   loaded on the page. Kept intentionally minimal — RetailProfiles
   is the real, maintained source of brand-code lists (see
   retail-profiles.js); duplicating it fully here would be exactly
   the kind of drift this project's own coding standards warn
   against. */
var FALLBACK_SIGNATURES = [
  { key: 'w', displayName: 'W BRAND', brandCodes: ['W', 'WI', 'FS', 'HO', 'WISHFUL', 'FOLKSONG', 'W BRAND', 'WFORWOMAN'] },
  { key: 'aurelia', displayName: 'AURELIA', brandCodes: ['AU', 'EL', 'AURELIA', 'ELLEVEN', 'SHOPFORAURELIA'] },
  { key: 'jaypore', displayName: 'JAYPORE', brandCodes: [] }
];

function retailerSignatures() {
  if (typeof RetailProfiles !== 'undefined' && RetailProfiles.PROFILES) {
    return Object.keys(RetailProfiles.PROFILES)
      .filter(function (k) { return k !== 'unknown'; })
      .map(function (k) {
        var p = RetailProfiles.PROFILES[k];
        return { key: p.key, displayName: p.displayName || p.key.toUpperCase(), brandCodes: (p.brands || []).slice() };
      });
  }
  return FALLBACK_SIGNATURES;
}

function brandCodeSetOf(sig) {
  var set = {};
  sig.brandCodes.forEach(function (b) { set[normLoose(b)] = 1; });
  return set;
}

/* Generalises retail-import.js's detectHouse() brand-column
   majority vote (originally hardcoded to exactly 2 brand sets) to
   any number of registered retailers, and — unlike the original,
   which only ever returned a bare house name — produces a genuine
   0-1 confidence from how dominant the winning retailer's share of
   non-blank brand values is. */
function detectFromBrandColumn(rows, headerIdx, brandColIdx, signatures) {
  var withBrands = signatures.filter(function (s) { return s.brandCodes.length; });
  if (!withBrands.length || brandColIdx < 0) return null;
  var sets = withBrands.map(function (s) { return { key: s.key, set: brandCodeSetOf(s) }; });
  var counts = {}, total = 0;
  var scanEnd = Math.min(rows.length, headerIdx + 1 + 8000);
  for (var r = headerIdx + 1; r < scanEnd; r++) {
    var v = normLoose((rows[r] || [])[brandColIdx]);
    if (!v) continue;
    total++;
    var hit = null;
    for (var i = 0; i < sets.length; i++) { if (sets[i].set[v]) { hit = sets[i].key; break; } }
    counts[hit || '__other__'] = (counts[hit || '__other__'] || 0) + 1;
  }
  if (!total) return null;
  var bestKey = null, bestCount = 0;
  for (var k in counts) {
    if (k === '__other__') continue;
    if (counts[k] > bestCount) { bestKey = k; bestCount = counts[k]; }
  }
  if (!bestKey || bestCount <= 0) return null;
  return {
    retailer: bestKey,
    confidence: clamp01(bestCount / total),
    via: 'brand column (' + bestCount + ' of ' + total + ' rows)'
  };
}

/* Generalises the Jaypore-only header-fingerprint branch of
   detectHouse() into a lookup any future retailer can add an entry
   to (HEADER_FINGERPRINTS above) without new detection code. */
function detectFromHeaderFingerprint(fields) {
  for (var key in HEADER_FINGERPRINTS) {
    var required = HEADER_FINGERPRINTS[key];
    if (required.every(function (f) { return !!fields[f]; })) {
      return { retailer: key, confidence: 0.9, via: 'header fingerprint (' + required.join(' + ') + ')' };
    }
  }
  return null;
}

/* Minimal fallback header/column detection for when RetailImport
   isn't loaded — just enough to locate a header row and a
   brand-like column. Deliberately not a re-implementation of
   RetailImport's full synonym table (see file header comment). */
function fallbackFindBrandColumn(rows) {
  var scan = Math.min(rows.length, 25);
  for (var r = 0; r < scan; r++) {
    var cells = (rows[r] || []).map(normLoose);
    var idx = cells.indexOf('brand');
    if (idx === -1) idx = cells.indexOf('brand code');
    if (idx === -1) idx = cells.indexOf('brand name');
    if (idx !== -1) return { headerIdx: r, brandColIdx: idx };
  }
  return { headerIdx: 0, brandColIdx: -1 };
}

/* ============================================================
   2b. Layer 1 — Style/Variant Code pattern (Universal AI
   Pipeline, Brand Detection Engine)
   ------------------------------------------------------------
   Deliberately NOT a hand-authored regex/prefix list per
   retailer — at "hundreds of retailers" scale that's the same
   maintenance burden the closed registry already had, just moved
   here. Instead this matches against LEARNED shape signatures
   (see ai-learning-store.js): once some other signal (brand
   column, header fingerprint, manual confirm, or AI + human
   accept) has confidently identified a retailer for a file that
   also has a style/variant code column, the caller derives a
   generic shape signature from those codes and persists it. This
   function only ever CONSUMES that learned data — it stays pure
   and I/O-free (this file's own standing design rule): callers
   pass `learnedSignatures` in, no localStorage/network access
   happens here.

   shapeOf() reuses the exact masking convention already
   established elsewhere in this app (retail-assist.js's
   maskValue(): digit -> #, upper -> A, lower -> a) so a learned
   signature is a shape, never a real code. */
function shapeOf(v) {
  return String(v == null ? '' : v).trim().slice(0, 24)
    .replace(/[0-9]/g, '#').replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a');
}
/* The leading alphabetic token plus at most one following
   delimiter — e.g. "W-KUR-2201" -> "W-", "AU2201" -> "AU",
   "WI-SKT-6650" -> "WI-". Deliberately stops at the FIRST
   delimiter/digit, not the last letter before the digit run: the
   original `/^[^0-9]*[A-Za-z]/` greedily consumed everything up to
   the last letter before any digit (e.g. "W-KUR-2201" -> "W-KUR"),
   which meant every distinct category segment in a retailer's own
   style codes (KUR/DRS/TOP/...) produced a DIFFERENT prefix, so no
   single (shape, prefix) pair could ever reach deriveStyleSignature's
   0.6 dominance threshold and Layer 1 learning never actually fired
   — found in production-readiness review. A signature with too
   short/generic a prefix (e.g. just "A-") is common across many
   retailers and shouldn't be trusted alone; MIN_PREFIX_LEN below
   gates that. */
function literalPrefixOf(v) {
  var m = String(v == null ? '' : v).trim().match(/^[A-Za-z]+[-_/ ]?/);
  return m ? m[0] : '';
}
var MIN_PREFIX_LEN = 2;

/* deriveStyleSignature(values) -> {shape, prefix, sampleSize} | null
   Pure aggregation: given a column of style/variant code strings,
   find the single dominant (shape, prefix) pair. Used by callers
   (ai-pipeline.js / retail-knowledge.js) to LEARN a signature once
   they already trust a retailer identification by some other
   means — never called by detectRetailer() itself. */
function deriveStyleSignature(values) {
  var pairs = {}, counts = {}, total = 0;
  (values || []).forEach(function (v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return;
    total++;
    var shape = shapeOf(s), prefix = literalPrefixOf(s);
    var key = shape + '::' + prefix;   // '::' never appears inside a masked shape or a literal prefix
    counts[key] = (counts[key] || 0) + 1;
    pairs[key] = { shape: shape, prefix: prefix };
  });
  if (!total) return null;
  var bestKey = null, bestCount = 0;
  for (var k in counts) { if (counts[k] > bestCount) { bestKey = k; bestCount = counts[k]; } }
  if (!bestKey) return null;
  var best = pairs[bestKey];
  return { shape: best.shape, prefix: best.prefix, sampleSize: total, dominance: clamp01(bestCount / total) };
}

/* detectFromLearnedStyleShape(rows, headerIdx, styleColIdx, learnedSignatures)
   learnedSignatures: [{ key, value:{shape,prefix}, confidence, validated }, ...]
   (the exact shape AILearningStore.list('retailerSignature') returns).
   Only VALIDATED entries are ever trusted here — an unconfirmed AI
   guess must never silently become a deterministic Layer 1 match. */
function detectFromLearnedStyleShape(rows, headerIdx, styleColIdx, learnedSignatures) {
  var validated = (learnedSignatures || []).filter(function (s) {
    return s && s.validated && s.value && s.value.prefix && s.value.prefix.length >= MIN_PREFIX_LEN;
  });
  if (!validated.length || styleColIdx < 0) return null;

  var scanEnd = Math.min(rows.length, headerIdx + 1 + 8000);
  var counts = {}, total = 0;
  for (var r = headerIdx + 1; r < scanEnd; r++) {
    var v = String((rows[r] || [])[styleColIdx] == null ? '' : (rows[r] || [])[styleColIdx]).trim();
    if (!v) continue;
    total++;
    for (var i = 0; i < validated.length; i++) {
      var sig = validated[i].value;
      if (v.indexOf(sig.prefix) === 0 && shapeOf(v) === sig.shape) {
        counts[validated[i].key] = (counts[validated[i].key] || 0) + 1;
      }
    }
  }
  if (!total) return null;

  var bestKey = null, bestCount = 0, matchingSignatures = 0;
  for (var k in counts) {
    if (counts[k] > 0) matchingSignatures++;
    if (counts[k] > bestCount) { bestKey = k; bestCount = counts[k]; }
  }
  if (!bestKey || bestCount <= 0) return null;

  /* A shape shared by multiple different learned retailers is not
     distinctive — discount confidence proportionally rather than
     report a false-confident single winner. */
  var raw = bestCount / total;
  var discounted = matchingSignatures > 1 ? raw / matchingSignatures : raw;
  return {
    retailer: bestKey,
    confidence: clamp01(discounted),
    via: 'learned style-code pattern (' + bestCount + ' of ' + total + ' rows' + (matchingSignatures > 1 ? ', ambiguous with ' + (matchingSignatures - 1) + ' other learned signature(s)' : '') + ')'
  };
}

/**
 * detectRetailer — deterministic, rule-tier only retailer guess.
 * @param {Array<{name:string, rows:Array<Array>}>} sheets
 * @param {Object} [opts]
 * @param {Array} [opts.learnedStyleSignatures]  Layer 1 input — the
 *   exact shape AILearningStore.list('retailerSignature') returns.
 *   Optional and additive: omitting it (every existing call site
 *   does, and keeps working unchanged) simply skips Layer 1, so
 *   this is 100% backward compatible.
 * @returns {{retailer:string, confidence:number, level:string, via:string, source:'rules'}}
 *   retailer is 'unknown' when no signal matches — the caller
 *   (a later phase) decides what that means for the UI (Universal
 *   Retail Mode et al.), this module just reports its best guess.
 */
function detectRetailer(sheets, opts) {
  sheets = sheets || [];
  var learnedStyleSignatures = (opts && opts.learnedStyleSignatures) || [];
  var signatures = retailerSignatures();
  var best = null;

  for (var i = 0; i < sheets.length; i++) {
    var rows = sheets[i].rows || [];
    if (!rows.length) continue;

    var headerIdx, fields, brandColIdx, styleColIdx;
    if (typeof RetailImport !== 'undefined' && RetailImport.findHeaderRow && RetailImport.mapColumns) {
      headerIdx = RetailImport.findHeaderRow(rows).idx;
      fields = RetailImport.mapColumns(rows, headerIdx).fields;
      brandColIdx = fields.brand ? fields.brand.index : -1;
      styleColIdx = fields.style ? fields.style.index : (fields.variant ? fields.variant.index : -1);
    } else {
      var found = fallbackFindBrandColumn(rows);
      headerIdx = found.headerIdx;
      brandColIdx = found.brandColIdx;
      styleColIdx = -1;
      fields = {};   // header-fingerprint detection needs RetailImport's field map; skipped in fallback mode
    }

    /* Layer 1 (highest priority): learned style/variant-code shape.
       Checked first so a strong, previously-confirmed signature can
       win even when this file happens to lack (or misdetect) a
       brand column. */
    var byStyleShape = detectFromLearnedStyleShape(rows, headerIdx, styleColIdx, learnedStyleSignatures);
    if (byStyleShape && (!best || byStyleShape.confidence > best.confidence)) best = byStyleShape;

    /* Layer 3: header fingerprint (structural — column presence,
       e.g. Jaypore's World+LOB+Division). */
    var byFingerprint = fields ? detectFromHeaderFingerprint(fields) : null;
    if (byFingerprint && (!best || byFingerprint.confidence > best.confidence)) best = byFingerprint;

    /* Layer 2: brand column majority vote. */
    var byBrand = detectFromBrandColumn(rows, headerIdx, brandColIdx, signatures);
    if (byBrand && (!best || byBrand.confidence > best.confidence)) best = byBrand;
  }

  if (!best) return { retailer: 'unknown', confidence: 0, level: 'low', via: 'no brand column, no known fingerprint', source: 'rules' };
  return { retailer: best.retailer, confidence: best.confidence, level: confidenceLevel(best.confidence), via: best.via, source: 'rules' };
}

return {
  classifyFileType: classifyFileType,
  detectRetailer: detectRetailer,
  confidenceLevel: confidenceLevel,
  FILE_TYPES: FILE_TYPES,
  /* Brand Detection Engine, Layer 1 helpers — exposed so callers
     (ai-pipeline.js / retail-knowledge.js) can LEARN a signature
     once they trust a detection by some other means. Kept out of
     detectRetailer() itself, which only ever reads learned data
     via opts.learnedStyleSignatures and stays I/O-free. */
  deriveStyleSignature: deriveStyleSignature,
  shapeOf: shapeOf
};
}));

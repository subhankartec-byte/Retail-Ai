/* =========================================================
   retail-knowledge.js — Retail AI · AI Intelligence Core,
   Retail Knowledge Intelligence client (Phase 7 Steps C + D)
   ---------------------------------------------------------
   ES module (needs `import` — talks to its own endpoint,
   api/retail-knowledge.js, and needs a fresh Firebase ID token
   the same way retail-insights.js does):

       <script type="module" src="retail-knowledge.js"></script>

   STEP C (LOCKED, 2026-07-29) BUILT
   ---------------------------------------------------------
   detectRetailer(sheets) — the orchestrator for Decision 1
   (AI-Assisted Retailer Detection): calls retail-intelligence.js's
   deterministic rule tier FIRST (Phase B, unmodified, locked); only
   falls through to the AI tier (api/retail-knowledge.js,
   task:'detect-retailer') when the rule tier isn't already
   high-confidence. This is a real cost optimisation, not just
   tidiness — a known retailer's file never needs to reach Gemini at
   all. Produces the confidence-gated UX decision the locked
   architecture calls for: high -> 'auto', medium -> 'confirm',
   low -> 'universal' (Universal Retail Mode).

   classifyFile(sheets) — the equivalent orchestrator for file-TYPE
   classification, reusing retail-assist.js's classifyFile()
   (the raw AI caller for api/map-schema.js's task:'classify') the
   same way. File type has no Universal-Mode equivalent — below
   'high' confidence, the caller falls back to manual selection,
   the same pattern retail-mapping.js's manual modal already uses
   for column mapping.
   Both functions and everything they call are UNCHANGED by Step D
   below — Step D only adds new functions alongside them.

   STEP D (this addition) BUILDS
   ---------------------------------------------------------
   enrichItems(canonicalRows) — Retail Knowledge Intelligence's
   item-level reasoning (Decision 2). Takes Phase A's canonical rows
   (retail-schema.js, locked, READ-ONLY — never modified, only its
   already-reserved `intelligence.*` slots are populated), reasons
   jointly per item over every available field at once (style-code
   shape + real product description + masked price shape +
   already-known colour/size/brand), and returns enriched rows with
   `brand`/`category`/`gender`/`productFamily` filled in (only where
   missing — an AI guess never overwrites an already-known value)
   and `intelligence.pricingTier`/`*Confidence` set, each field
   independently confidence-gated at the same MIN_CONF this app uses
   everywhere else. Deduplicates by style before calling the AI
   (Tier 2's defining property) and skips the call entirely when no
   row in the batch actually needs anything (same cost-optimisation
   discipline as Step C).

   WHAT THIS STEP DOES NOT DO
   ---------------------------------------------------------
   - Does not modify retail-intelligence.js (Phase B, locked),
     retail-schema.js (Phase A, locked), or Step C's own
     detectRetailer()/classifyFile() — all read from or left
     untouched, never edited.
   - Not wired into any tool page yet, same posture as every prior
     Phase 7 step.
   - Stays within AI Data Policy Tier 2 (deduplicated, capped item
     subset) — see api/retail-knowledge.js's header comment for the
     one deliberate, documented exception (product descriptions are
     sent as real text, not shape-masked, with a different safety
     net) and why it doesn't compromise the policy's intent.

   Optional by design, same philosophy as retail-assist.js /
   retail-insights.js: if this file, RetailIntelligence, or the
   network is unavailable, detectRetailer()/classifyFile() still
   resolve using whatever tier succeeded — AI is never required for
   either function to return a usable answer.
   ========================================================= */
import { auth } from "./firebase.js";

(function () {
  'use strict';

  var DETECT_RETAILER_ENDPOINT = '/api/retail-knowledge';
  var TIMEOUT_MS = 12000;

  async function idToken () {
    var u = auth.currentUser;
    if (!u) return null;
    try { return await u.getIdToken(); } catch (e) { return null; }
  }

  /* Candidate retailer keys for the AI tier come from RetailProfiles
     (the same registry retail-intelligence.js's rule tier already
     pulls from) — never hardcoded here, so a future retailer needs
     no change to this file or to api/retail-knowledge.js, only a
     longer registry. */
  function knownCandidates () {
    if (typeof RetailProfiles !== 'undefined' && RetailProfiles.PROFILES) {
      return Object.keys(RetailProfiles.PROFILES).filter(function (k) { return k !== 'unknown'; });
    }
    return ['w', 'aurelia', 'jaypore'];   // graceful fallback if RetailProfiles isn't loaded
  }

  function modeFor (level) {
    return level === 'high' ? 'auto' : (level === 'medium' ? 'confirm' : 'universal');
  }

  function levelOf (confidence) {
    if (typeof RetailIntelligence !== 'undefined' && RetailIntelligence.confidenceLevel) {
      return RetailIntelligence.confidenceLevel(confidence);
    }
    return confidence >= 0.75 ? 'high' : (confidence >= 0.4 ? 'medium' : 'low');   // same banding as Phase B, duplicated only as a last-resort fallback
  }

  /* Picks the sheet most likely to carry a real header row — the
     one with the most non-blank cells across its first few rows.
     Good enough for a single-file classification/detection call;
     not a replacement for retail-import.js's/retail-intelligence.js's
     own more careful header-row scoring, which still runs per-sheet
     inside RetailIntelligence itself. */
  function bestHeaderSheet (sheets) {
    var best = sheets[0] || { name: '', rows: [] };
    var bestScore = -1;
    sheets.forEach(function (s) {
      var rows = s.rows || [];
      var score = 0;
      for (var r = 0; r < Math.min(rows.length, 5); r++) {
        score += (rows[r] || []).filter(function (c) { return String(c == null ? '' : c).trim(); }).length;
      }
      if (score > bestScore) { bestScore = score; best = s; }
    });
    return best;
  }

  function headerAndSamplesOf (sheet) {
    var rows = sheet.rows || [];
    var headerIdx = (typeof RetailImport !== 'undefined' && RetailImport.findHeaderRow) ? RetailImport.findHeaderRow(rows).idx : 0;
    var headers = (rows[headerIdx] || []).map(function (h) { return String(h == null ? '' : h).slice(0, 100); });
    var samples = (typeof RetailAssist !== 'undefined' && RetailAssist.buildSamples)
      ? RetailAssist.buildSamples(rows, headerIdx, headers.length, 3)
      : [];
    return { headers: headers, samples: samples };
  }

  async function callDetectRetailerAI (sheet, candidates, ruleHint) {
    try {
      var token = await idToken();
      if (!token) return null;

      var hs = headerAndSamplesOf(sheet);
      var body = {
        task: 'detect-retailer',
        headers: hs.headers,
        samples: hs.samples,
        candidates: candidates,
        ruleHint: (ruleHint && ruleHint.retailer && ruleHint.retailer !== 'unknown')
          ? { retailer: ruleHint.retailer, confidence: ruleHint.confidence }
          : null,
        filename: '',
        sheetName: sheet.name || ''
      };

      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
      var res;
      try {
        res = await fetch(DETECT_RETAILER_ENDPOINT, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify(body)
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;

      var data = await res.json();
      if (!data || typeof data.confidence !== 'number') return null;
      return { retailer: data.retailer || 'unknown', confidence: data.confidence, source: 'ai' };
    } catch (e) {
      return null;
    }
  }

  /**
   * detectRetailer(sheets) — always resolves, never throws.
   * @param {Array<{name:string, rows:Array<Array>}>} sheets
   * @returns {Promise<{retailer:string, confidence:number, level:string, mode:string, via:string, source:string}>}
   *   mode is 'auto' | 'confirm' | 'universal' — the confidence-gated
   *   UX decision a future wiring phase should act on. retailer is
   *   'unknown' when neither tier found a confident answer.
   */
  async function detectRetailer (sheets) {
    sheets = sheets || [];
    var rule = (typeof RetailIntelligence !== 'undefined')
      ? RetailIntelligence.detectRetailer(sheets)
      : { retailer: 'unknown', confidence: 0, level: 'low', via: 'RetailIntelligence not loaded', source: 'rules' };

    if (rule.level === 'high') {
      return { retailer: rule.retailer, confidence: rule.confidence, level: rule.level, mode: 'auto', via: rule.via, source: rule.source };
    }

    var candidates = knownCandidates();
    var sheet = bestHeaderSheet(sheets);
    var ai = await callDetectRetailerAI(sheet, candidates, rule.retailer !== 'unknown' ? rule : null);

    var final = rule;
    if (ai && ai.retailer !== 'unknown' && ai.confidence > rule.confidence) {
      final = { retailer: ai.retailer, confidence: ai.confidence, via: 'AI classification (Gemini)', source: 'ai' };
    }
    var level = levelOf(final.confidence);
    return { retailer: final.retailer, confidence: final.confidence, level: level, mode: modeFor(level), via: final.via, source: final.source };
  }

  /**
   * classifyFile(sheets) — always resolves, never throws.
   * @param {Array<{name:string, rows:Array<Array>}>} sheets
   * @returns {Promise<{fileType:string, confidence:number, level:string, source:string}>}
   *   No 'mode' — file type has no Universal-Mode equivalent. Below
   *   'high' confidence, the caller should fall back to manual
   *   selection, the same pattern retail-mapping.js already uses.
   */
  async function classifyFile (sheets) {
    sheets = sheets || [];
    var rule = (typeof RetailIntelligence !== 'undefined')
      ? RetailIntelligence.classifyFileType(sheets)
      : { fileType: 'unknown', confidence: 0, level: 'low', source: 'rules' };

    if (rule.level === 'high') return rule;

    var sheet = bestHeaderSheet(sheets);
    var hs = headerAndSamplesOf(sheet);
    var ai = (typeof RetailAssist !== 'undefined' && RetailAssist.classifyFile)
      ? await RetailAssist.classifyFile(hs.headers, hs.samples, { sheetName: sheet.name })
      : null;

    if (ai && ai.fileType !== 'unknown' && ai.confidence > rule.confidence) {
      return { fileType: ai.fileType, confidence: ai.confidence, level: levelOf(ai.confidence), source: 'ai' };
    }
    return rule;
  }

  /* ============================================================
     Phase D — enrichItems(canonicalRows)
     ============================================================ */
  var ENRICH_MAX_ITEMS = 40;                 // mirrors api/retail-knowledge.js's MAX_ITEMS
  var ENRICH_TARGET_FIELDS = ['brand', 'category', 'gender', 'productFamily'];
  var ENRICH_MIN_CONF = 0.6;                 // same threshold used everywhere else in this app (retail-assist.js's MIN_CONF)
  var ENRICH_DIGIT_RUN_RE = /\d{4,}/;

  function shapeOf (v) {
    if (typeof RetailAssist !== 'undefined' && RetailAssist.maskValue) return RetailAssist.maskValue(v);
    return String(v == null ? '' : v).trim().replace(/[0-9]/g, '#').replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a');
  }
  /* Real product-catalog text, not shape-masked — see the design
     note in api/retail-knowledge.js's header comment. Still capped
     and stripped of any accidentally-embedded long digit run
     (a barcode/phone/EAN that has no business being in a
     description field), the same defensive check the server
     re-applies and fails closed on. */
  function safeDescription (v) {
    return String(v == null ? '' : v).trim().slice(0, 80).replace(ENRICH_DIGIT_RUN_RE, '####');
  }
  function shortLabel (v, max) {
    return String(v == null ? '' : v).trim().slice(0, max || 30).replace(ENRICH_DIGIT_RUN_RE, '');
  }

  function needsEnrichment (row) {
    if (!row || row.recordType !== 'stock' && row.recordType !== 'sale') return false;
    if (!row.brand || !row.category || !row.gender || !row.productFamily) return true;
    if (!row.intelligence || !row.intelligence.pricingTier) return true;
    return false;
  }

  /* Deduplicates by style (Tier 2's defining property — never one
     request entry per row) and ranks by combined qty/value so a
     hard MAX_ITEMS cap drops the least business-impactful items
     first, not an arbitrary prefix — same "rank by impact, then
     cap" philosophy retail-decision.js already uses for its own
     top-N lists. Returns internal records keyed by the REAL style
     code for the client's own bookkeeping only; a synthetic,
     content-free key (see buildRequestItems) is what actually goes
     over the wire — the real style code is never transmitted, even
     as an identifier, only as its masked SHAPE. */
  function distinctItemsNeeding (canonicalRows) {
    var byStyle = {};
    canonicalRows.forEach(function (row) {
      if (!needsEnrichment(row)) return;
      var styleKey = row.styleCode || row.barcode || row.sku;
      if (!styleKey) return;
      styleKey = String(styleKey);
      if (!byStyle[styleKey]) byStyle[styleKey] = { styleKey: styleKey, sample: row, impact: 0 };
      byStyle[styleKey].impact += Math.abs(Number(row.value) || 0) + Math.abs(Number(row.qty) || 0);
    });
    return Object.keys(byStyle).map(function (k) { return byStyle[k]; })
      .sort(function (a, b) { return b.impact - a.impact; })
      .slice(0, ENRICH_MAX_ITEMS);
  }

  /* Synthetic, position-based keys ("i0", "i1", ...) — deliberately
     NOT derived from the real style code. A key is purely a
     round-trip reference token for matching the AI's response back
     to the request; it carries no information of its own, so unlike
     styleCode (sent as a masked shape) it never needs masking, but
     it also must never leak the real value it stands in for. */
  function buildRequestItems (distinct) {
    return distinct.map(function (d, i) {
      var r = d.sample;
      var priceSource = r.mrp != null ? r.mrp : r.value;
      return {
        key: 'i' + i,
        styleCode: r.styleCode ? shapeOf(r.styleCode) : '',
        description: r.description ? safeDescription(r.description) : '',
        priceShape: priceSource != null ? shapeOf(String(priceSource)) : '',
        colour: r.colour ? shortLabel(r.colour) : '',
        size: r.size ? shortLabel(r.size, 20) : '',
        knownBrand: r.brand ? shortLabel(r.brand) : ''
      };
    });
  }

  async function callEnrichItemsAI (distinct) {
    try {
      var token = await idToken();
      if (!token) return null;

      var items = buildRequestItems(distinct);
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
      var res;
      try {
        res = await fetch(DETECT_RETAILER_ENDPOINT, {   // same endpoint as detectRetailer, different task
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ task: 'enrich-items', items: items })
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;

      var data = await res.json();
      if (!data || !Array.isArray(data.items)) return null;
      return data.items;
    } catch (e) {
      return null;
    }
  }

  /**
   * enrichItems(canonicalRows) — always resolves, never throws.
   * @param {Array} canonicalRows  RetailSchema canonical rows (Phase A)
   * @returns {Promise<Array>} the SAME rows, same order, shallow-cloned,
   *   with brand/category/gender/productFamily filled in where they
   *   were missing (never overwriting an already-known value) and
   *   intelligence.pricingTier/*Confidence set where confident.
   *   Rows that needed nothing, or that the AI couldn't help with,
   *   come back unchanged.
   */
  async function enrichItems (canonicalRows) {
    canonicalRows = canonicalRows || [];
    var distinct = distinctItemsNeeding(canonicalRows);

    var byStyle = {};
    if (distinct.length) {
      var aiItems = await callEnrichItemsAI(distinct);
      if (aiItems) {
        aiItems.forEach(function (it) {
          if (!it || typeof it.key !== 'string') return;
          var idx = parseInt(it.key.slice(1), 10);   // 'i<N>' -> N, matching buildRequestItems' index
          if (!isFinite(idx) || !distinct[idx]) return;
          byStyle[distinct[idx].styleKey] = it;
        });
      }
    }

    return canonicalRows.map(function (row) {
      var styleKey = row && (row.styleCode || row.barcode || row.sku);
      var ai = styleKey ? byStyle[String(styleKey)] : null;
      if (!ai) return row;

      var out = Object.assign({}, row, { intelligence: Object.assign({}, row.intelligence) });
      ENRICH_TARGET_FIELDS.forEach(function (f) {
        var conf = ai[f + 'Confidence'];
        if (out[f] || typeof ai[f] !== 'string' || typeof conf !== 'number' || conf < ENRICH_MIN_CONF) return;
        out[f] = ai[f];
        out.intelligence[f + 'Confidence'] = conf;
      });
      /* pricingTier's value lives inside intelligence on the locked
         Phase A schema, which reserves no dedicated pricingTierConfidence
         slot — presence (post confidence-gate) already communicates
         "confident enough", consistent with the "null below threshold"
         rule everywhere else in this app. */
      var ptConf = ai.pricingTierConfidence;
      if (!out.intelligence.pricingTier && typeof ai.pricingTier === 'string' && typeof ptConf === 'number' && ptConf >= ENRICH_MIN_CONF) {
        out.intelligence.pricingTier = ai.pricingTier;
      }
      out.intelligence.source = 'ai';
      return out;
    });
  }

  window.RetailKnowledge = { detectRetailer: detectRetailer, classifyFile: classifyFile, enrichItems: enrichItems };
}());

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
    return { headers: headers, samples: samples, headerIdx: headerIdx };
  }

  /* Content labels for the AI tier's Layer 3 (Universal AI Pipeline:
     description/category/department/division reasoning folded into
     the AI call rather than a hand-authored keyword list — see
     retail-intelligence.js's header comment). Pulls distinct values
     from whichever of world/dept/desc/category-ish fields
     RetailImport already mapped; already-categorical short labels
     only, never a full row or price. Best-effort: returns [] when
     RetailImport isn't loaded or nothing usable is found. */
  function contentLabelsOf (sheet, headerIdx) {
    if (typeof RetailImport === 'undefined' || !RetailImport.mapColumns) return [];
    try {
      var rows = sheet.rows || [];
      var fields = RetailImport.mapColumns(rows, headerIdx).fields;
      var cols = ['world', 'dept', 'group', 'klass', 'subclass'].map(function (f) { return fields[f] ? fields[f].index : -1; }).filter(function (i) { return i >= 0; });
      if (!cols.length) return [];
      var seen = {}, out = [];
      var scanEnd = Math.min(rows.length, headerIdx + 1 + 500);
      for (var r = headerIdx + 1; r < scanEnd && out.length < 20; r++) {
        for (var c = 0; c < cols.length && out.length < 20; c++) {
          var v = String((rows[r] || [])[cols[c]] == null ? '' : (rows[r] || [])[cols[c]]).trim().slice(0, 40);
          if (!v || /[0-9]{4,}/.test(v) || seen[v]) continue;
          seen[v] = 1; out.push(v);
        }
      }
      return out;
    } catch (e) { return []; }
  }

  /* Optional dependency, same graceful-degradation convention as
     RetailProfiles/RetailImport elsewhere in this file: if
     ai-learning-store.js isn't loaded on the page, Layer 1 simply
     contributes nothing and learning writes are silently skipped —
     detection still works via Layers 2-4. */
  function learnedStyleSignatures () {
    if (typeof AILearningStore === 'undefined' || !AILearningStore.list) return [];
    try { return AILearningStore.list('retailerSignature'); } catch (e) { return []; }
  }

  /* learnFrom(sheets, retailerKey, source) — call once a retailer
     has been confidently identified (deterministic Layer 2/3 match,
     or an AI suggestion a human accepted via the manual-confirm UI)
     to derive and persist a style-code shape signature for Layer 1.
     Never called with an unvalidated AI guess — see
     ai-learning-store.js's own "never trust a single AI guess"
     contract. Best-effort, never throws. */
  function learnFrom (sheets, retailerKey, opts) {
    if (typeof AILearningStore === 'undefined' || typeof RetailIntelligence === 'undefined' || !RetailIntelligence.deriveStyleSignature) return;
    if (!retailerKey || retailerKey === 'unknown') return;
    try {
      var sheet = bestHeaderSheet(sheets || []);
      var rows = sheet.rows || [];
      if (typeof RetailImport === 'undefined' || !RetailImport.mapColumns) return;
      var headerIdx = RetailImport.findHeaderRow ? RetailImport.findHeaderRow(rows).idx : 0;
      var fields = RetailImport.mapColumns(rows, headerIdx).fields;
      var styleColIdx = fields.style ? fields.style.index : (fields.variant ? fields.variant.index : -1);
      if (styleColIdx < 0) return;
      var values = [];
      var scanEnd = Math.min(rows.length, headerIdx + 1 + 2000);
      for (var r = headerIdx + 1; r < scanEnd; r++) values.push((rows[r] || [])[styleColIdx]);
      var sig = RetailIntelligence.deriveStyleSignature(values);
      if (!sig || sig.sampleSize < 5 || sig.dominance < 0.6) return;   // too little/too mixed evidence to trust
      AILearningStore.recordIfBetter('retailerSignature', retailerKey, { shape: sig.shape, prefix: sig.prefix }, {
        confidence: sig.dominance,
        source: (opts && opts.source) || 'brand-column',
        validated: true
      });
    } catch (e) { /* learning is best-effort, never blocks detection */ }
  }

  async function callDetectRetailerAI (sheet, headerIdx, candidates, ruleHint) {
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
        sheetName: sheet.name || '',
        contentLabels: contentLabelsOf(sheet, headerIdx)
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
      return {
        retailer: data.retailer || null,
        suggestedName: data.suggestedName || null,
        confidence: data.confidence,
        registered: !!data.registered,
        source: 'ai'
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * detectRetailer(sheets) — always resolves, never throws.
   * @param {Array<{name:string, rows:Array<Array>}>} sheets
   * @returns {Promise<{retailer:string, confidence:number, level:string, mode:string, via:string, source:string, suggestedName:?string}>}
   *   mode is 'auto' | 'confirm' | 'universal' — the confidence-gated
   *   UX decision the caller acts on. retailer is 'unknown' when no
   *   tier found a confident, REGISTERED answer. suggestedName is
   *   set only when the AI tier recognised a real retailer that
   *   isn't registered yet (Layer 4, open-vocabulary) — it is never
   *   auto-applied; surface it to the user via the existing manual-
   *   confirm UI as an "add this retailer?" prompt, and only call
   *   learnFrom() once they accept it.
   */
  async function detectRetailer (sheets) {
    sheets = sheets || [];
    var rule;
    try {
      rule = (typeof RetailIntelligence !== 'undefined')
        ? RetailIntelligence.detectRetailer(sheets, { learnedStyleSignatures: learnedStyleSignatures() })
        : { retailer: 'unknown', confidence: 0, level: 'low', via: 'RetailIntelligence not loaded', source: 'rules' };
    } catch (e) {
      /* detectRetailer() must always resolve, never throw (see JSDoc
         below) — a malformed sheet must degrade to 'unknown', not
         propagate and break every caller's "never throws" contract
         (e.g. AIPipeline.run()). */
      rule = { retailer: 'unknown', confidence: 0, level: 'low', via: 'rule tier threw: ' + (e && e.message), source: 'rules' };
    }

    if (rule.level === 'high') {
      learnFrom(sheets, rule.retailer, { source: rule.source === 'rules' ? 'brand-column' : rule.source });
      return { retailer: rule.retailer, confidence: rule.confidence, level: rule.level, mode: 'auto', via: rule.via, source: rule.source, suggestedName: null };
    }

    var candidates = knownCandidates();
    var sheet = bestHeaderSheet(sheets);
    var hs = headerAndSamplesOf(sheet);
    var ai = await callDetectRetailerAI(sheet, hs.headerIdx, candidates, rule.retailer !== 'unknown' ? rule : null);

    var final = rule, suggestedName = null;
    if (ai && ai.registered && ai.retailer && ai.confidence > rule.confidence) {
      final = { retailer: ai.retailer, confidence: ai.confidence, via: 'AI classification (Gemini)', source: 'ai' };
    } else if (ai && !ai.registered && ai.suggestedName) {
      suggestedName = ai.suggestedName;   // never promoted into `final` — see JSDoc above
    }
    var level = levelOf(final.confidence);
    /* Deliberately does NOT call learnFrom() here even at high AI
       confidence. This line used to, which directly contradicted
       this function's own JSDoc ("only call learnFrom() once they
       accept it [via manual-confirm]") and learnFrom()'s own
       "never called with an unvalidated AI guess" contract — found
       in production-readiness review: learnFrom() always writes
       validated:true (retail-knowledge.js's recordIfBetter call),
       so a single unconfirmed Gemini answer could get persisted as
       a trusted signature and then deterministically applied,
       silently and without any confirm dialog, to a LATER, actually
       different file that happened to share a similar style-code
       shape (Layer 1 in retail-intelligence.js only trusts
       validated:true entries). Learning now only happens from
       genuinely deterministic evidence (the rule-tier branch above)
       or an explicit human confirmation (confirmRetailer(), called
       by every tool's manual-confirm UI once a person accepts a
       detection or suggestion) — never from AI output alone. */
    return { retailer: final.retailer, confidence: final.confidence, level: level, mode: modeFor(level), via: final.via, source: final.source, suggestedName: suggestedName };
  }

  /* confirmRetailer(sheets, retailerKey) — call from the manual-
     confirm UI once a human accepts a detection (including an
     open-vocabulary suggestedName being registered as a brand-new
     retailer key elsewhere). This is the explicit, human-gated
     write path Stage 8 requires: a single AI guess never becomes
     trusted on its own. */
  function confirmRetailer (sheets, retailerKey) {
    learnFrom(sheets, retailerKey, { source: 'manual-confirm' });
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

  window.RetailKnowledge = { detectRetailer: detectRetailer, classifyFile: classifyFile, enrichItems: enrichItems, confirmRetailer: confirmRetailer };
}());

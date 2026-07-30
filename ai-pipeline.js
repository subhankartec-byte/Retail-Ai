/* ============================================================
   ai-pipeline.js — Retail AI · Universal AI Pipeline
   ------------------------------------------------------------
   ES module (needs `import` — calls /api/chat directly for
   Stage 6/7, the same way retail-insights.js/retail-knowledge.js
   call their own endpoints):

       <script type="module" src="ai-pipeline.js"></script>
       (load AFTER retail-import.js, retail-profiles.js,
        retail-intelligence.js, retail-knowledge.js,
        ai-learning-store.js, retail-schema.js — all optional,
        all checked at call time, never at load time)

   WHAT THIS FILE IS
   ------------------------------------------------------------
   The single entry point every tool calls instead of talking to
   Gemini, retailer detection, or report formatting on its own.
   `AIPipeline.run(input)` composes the 9 stages below — every
   stage reuses an EXISTING, already-built, already-audited
   module; this file adds no new AI call it doesn't have to, and
   duplicates no prompt, no parsing, no validation logic that
   already lives somewhere else in this app:

     Stage 1  Input Validation        -> RetailKnowledge.classifyFile()
                                          (retail-intelligence.js rule tier
                                          + api/map-schema.js task:'classify'
                                          AI fallback, unchanged)
     Stage 2  Data Understanding      -> RetailImport.mapColumns() /
                                          RetailAssist.suggest() (unchanged)
     Stage 3  Retail Intelligence     -> RetailKnowledge.detectRetailer()
                                          (Brand Detection Engine: Layers
                                          1-4, see retail-intelligence.js /
                                          api/retail-knowledge.js)
     Stage 4  Data Cleaning           -> new, generic (below): normalises
                                          labels, dedupes exact-duplicate
                                          canonical rows, flags anomalies.
                                          Never touches business
                                          classification a tool already
                                          computed (RetailSchema principle
                                          1: thin adapters never duplicate
                                          business logic a tool owns).
     Stage 5  Business Analysis       -> the tool's OWN already-built
                                          aggregate (whatever it already
                                          hands to RetailDecision.
                                          saveSummary()/RetailInsights.
                                          summarize() today) plus, when
                                          available, RetailDecision.
                                          evaluate() for cross-tool
                                          corroboration. This stage does
                                          NOT re-derive business logic —
                                          three genuinely different retail
                                          domains (sales / size-run health
                                          / reconciliation) don't collapse
                                          into one generic formula, and
                                          retail-schema.js's adapters
                                          already exist for exactly this.
     Stage 6  AI Reasoning            -> /api/chat (the existing
     Stage 7  Report Generation          "experienced retail consultant"
                                          endpoint) — asked one universal
                                          question, given Stage 3-5's
                                          output as toolContext. No new
                                          endpoint, no new prompt style:
                                          this literally IS the "reason
                                          about WHY, not just WHAT"
                                          capability this app already
                                          built for chat, reused here for
                                          one-shot report narration.
     Stage 8  Learning                -> ai-learning-store.js +
                                          RetailKnowledge.confirmRetailer()
                                          (unchanged, called from Stage 3)
     Stage 9  Universal Output        -> formatUniversalOutput() (below) —
                                          the ONE report shape every tool
                                          gets back, regardless of which
                                          stages actually had data.

   FUTURE TOOLS
   ------------------------------------------------------------
   A new tool becomes AI-native by providing three things to
   run() — sheets, an aggregateContext it already knows how to
   build, and a toolContext label — nothing else. See the
   Future Tool Integration Guide in PROJECT_STATUS.md / the
   Universal AI Pipeline design notes for the exact recipe.

   FAILURE POLICY
   ------------------------------------------------------------
   Every stage degrades independently and never throws out of
   run(): a missing module, a signed-out user, a Gemini timeout,
   or a rate limit each just leaves that stage's slice of the
   Stage 9 report empty/honest ("not available") rather than
   failing the whole pipeline — same "AI is never on the happy
   path" discipline every other AI integration in this app
   already follows.
   ============================================================ */
import { auth } from "./firebase.js";

(function () {
  'use strict';

  var CHAT_ENDPOINT = '/api/chat';
  var TIMEOUT_MS = 15000;

  async function idToken () {
    var u = auth.currentUser;
    if (!u) return null;
    try { return await u.getIdToken(); } catch (e) { return null; }
  }

  /* ============================================================
     Stage 1 — Input Validation
     ============================================================ */
  async function stage1Validate (sheets) {
    var warnings = [];
    if (!sheets || !sheets.length) {
      return { fileType: 'unknown', confidence: 0, level: 'low', warnings: ['No sheets were found in the uploaded file.'] };
    }
    sheets.forEach(function (s) {
      if (!s.rows || !s.rows.length) warnings.push('Sheet "' + (s.name || '?') + '" is empty.');
    });

    var classified = (typeof RetailKnowledge !== 'undefined' && RetailKnowledge.classifyFile)
      ? await RetailKnowledge.classifyFile(sheets)
      : (typeof RetailIntelligence !== 'undefined' ? RetailIntelligence.classifyFileType(sheets) : { fileType: 'unknown', confidence: 0, level: 'low', source: 'none' });

    if (classified.level !== 'high') warnings.push('File type could not be confidently identified (' + classified.fileType + ', ' + classified.level + ' confidence) — column mapping may need manual confirmation.');

    /* Byte-level encoding detection is out of scope here by design:
       this stage operates on already-parsed rows (SheetJS/xlsx has
       already resolved encoding upstream of every tool page). What
       IS checked: whether a usable header row was even found, which
       is the practical symptom of a genuinely corrupt/misencoded
       file reaching this far. */
    var headerFound = sheets.some(function (s) {
      if (typeof RetailImport === 'undefined' || !RetailImport.findHeaderRow || !s.rows || !s.rows.length) return false;
      return RetailImport.findHeaderRow(s.rows).hits > 0;
    });
    if (!headerFound && sheets.some(function (s) { return s.rows && s.rows.length; })) {
      warnings.push('No recognisable header row was found in any sheet — check the file is a genuine export, not a scanned/reformatted copy.');
    }

    return { fileType: classified.fileType, confidence: classified.confidence, level: classified.level, warnings: warnings };
  }

  /* ============================================================
     Stage 2 — Data Understanding (column mapping report)
     ============================================================ */
  function stage2Understand (sheets) {
    if (typeof RetailImport === 'undefined' || !RetailImport.findHeaderRow || !RetailImport.mapColumns) {
      return { mappedFields: [], missingFields: [], headerConfidence: 0, warnings: ['retail-import.js not loaded — column understanding skipped.'] };
    }
    var sheet = sheets && sheets[0];
    if (!sheet || !sheet.rows || !sheet.rows.length) {
      return { mappedFields: [], missingFields: [], headerConfidence: 0, warnings: ['No data to understand.'] };
    }
    var hdr = RetailImport.findHeaderRow(sheet.rows);
    var mapped = RetailImport.mapColumns(sheet.rows, hdr.idx);
    var fieldKeys = Object.keys(mapped.fields || {});
    var CORE = ['style', 'qty', 'mrp'];
    var missing = CORE.filter(function (f) { return !mapped.fields[f]; });
    var warnings = missing.length ? ['Columns not recognised without confirmation: ' + missing.join(', ') + '.'] : [];
    return {
      mappedFields: fieldKeys,
      missingFields: missing,
      headerConfidence: hdr.hits >= 6 ? 1 : hdr.hits / 6,
      warnings: warnings
    };
  }

  /* ============================================================
     Stage 3 — Retail Intelligence (Brand Detection Engine)
     ------------------------------------------------------------
     Skips the call entirely (rule tier AND AI) when there is no
     real sheet data — several callers legitimately have nothing
     to detect from (an aggregate-only "Generate AI Analysis" on a
     tool that never re-parsed the source file) and previously this
     still reached RetailKnowledge.detectRetailer(), which built a
     request with empty headers and sent it to Gemini anyway,
     burning a rate-limit unit on a request the server was always
     going to reject with 400 (headers required). Detected via
     production-readiness audit — this is a real cost/latency bug,
     not a style change.
     ============================================================ */
  async function stage3Intelligence (sheets) {
    var hasData = Array.isArray(sheets) && sheets.some(function (s) { return s && s.rows && s.rows.length; });
    if (!hasData) {
      return { retailer: 'unknown', confidence: 0, level: 'low', mode: 'universal', via: 'no sheet data provided', source: 'none', suggestedName: null };
    }
    if (typeof RetailKnowledge === 'undefined' || !RetailKnowledge.detectRetailer) {
      return { retailer: 'unknown', confidence: 0, level: 'low', mode: 'universal', via: 'RetailKnowledge not loaded', source: 'none', suggestedName: null };
    }
    return RetailKnowledge.detectRetailer(sheets);
  }

  /* ============================================================
     Stage 4 — Data Cleaning
     ------------------------------------------------------------
     Generic, retailer-agnostic, and deliberately shallow: it
     normalises presentation-layer noise (whitespace, case drift
     on labels) and flags structural anomalies, but never
     recomputes a business classification a tool already owns
     (RetailSchema's own stated principle — see retail-schema.js).
     ============================================================ */
  function stage4Clean (canonicalRows) {
    var rows = Array.isArray(canonicalRows) ? canonicalRows : [];
    var notes = [];
    var seen = {};
    var deduped = [];
    var anomalies = 0;

    rows.forEach(function (row) {
      if (!row) return;
      var clean = Object.assign({}, row);
      ['brand', 'category', 'department', 'description', 'colour', 'productFamily'].forEach(function (f) {
        if (typeof clean[f] === 'string') clean[f] = clean[f].trim().replace(/\s+/g, ' ');
      });

      /* exact-duplicate detection — same identity + same numbers,
         the common symptom of a double-pasted export, not a
         legitimate second row. */
      var key = [clean.recordType, clean.styleCode, clean.barcode, clean.storeCode, clean.qty, clean.value].join('|');
      if (seen[key]) return;   // drop the duplicate, keep the first
      seen[key] = 1;

      if (clean.recordType === 'stock' && typeof clean.qty === 'number' && clean.qty < 0) anomalies++;
      if (typeof clean.mrp === 'number' && clean.mrp <= 0 && typeof clean.qty === 'number' && clean.qty > 0) anomalies++;

      deduped.push(clean);
    });

    if (rows.length && deduped.length < rows.length) notes.push((rows.length - deduped.length) + ' exact-duplicate row(s) removed.');
    if (anomalies) notes.push(anomalies + ' row(s) flagged for unusual values (negative stock, zero MRP with stock present) — verify against source.');

    return { cleanedRows: deduped, dataQualityNotes: notes, removedDuplicates: rows.length - deduped.length, anomalyCount: anomalies };
  }

  /* ============================================================
     Stage 5 — Business Analysis
     ------------------------------------------------------------
     Passes through whatever aggregate the calling tool already
     built (the same object it already hands to RetailDecision.
     saveSummary()/RetailInsights.summarize()) — this stage does
     not re-derive it. When RetailDecision is loaded and other
     tools have saved data, folds in cross-tool corroboration.
     ============================================================ */
  function stage5Analyse (aggregateContext) {
    var crossTool = null;
    if (typeof RetailDecision !== 'undefined' && RetailDecision.loadSummaries) {
      try {
        var summaries = RetailDecision.loadSummaries();
        crossTool = RetailDecision.evaluate(summaries);
      } catch (e) { crossTool = null; }
    }
    return { aggregateContext: aggregateContext || null, crossTool: crossTool };
  }

  /* ============================================================
     Stage 6/7 — AI Reasoning + Report narration
     ------------------------------------------------------------
     Reuses /api/chat as-is (auth, rate limit, egress guard,
     "experienced retail consultant" persona all unchanged) —
     asked one fixed, universal question so every tool gets
     comparably-shaped prose back regardless of its domain.
     ============================================================ */
  var UNIVERSAL_QUESTION =
    'Based on everything above, write a short business analysis of this report. Explain WHY the ' +
    'numbers look the way they do, not just what they are, using only the evidence given. Structure ' +
    'your answer as: one-sentence Executive Summary, then 2-4 Key Findings, then 1-2 Business Impact ' +
    'points, then 2-4 Recommendations — each as its own short paragraph or bullet, in that order.';

  var MAX_TOOLCTX_LABELS = 18;   // stay under api/chat.js's MAX_TOOLCTX_LABELS (20), leaving headroom for the two stage4 labels below
  var MAX_LABEL_DEPTH = 2;
  var LONG_DIGIT_RUN_RE = /\d{4,}/g;

  /* Sends only scalar (number/short-string) LEAF values to
     toolContext.labels, never a whole nested object/array
     stringified — that was the root cause of a critical bug found
     in production-readiness review: JSON.stringify-ing an
     aggregate object (e.g. {"value":1234567,...}) almost always
     contains a 4+ digit run, which api/chat.js's egress guard
     (correctly) rejects with a 500 — meaning every tool's AI
     report failed on every call. Arrays (e.g. topCutPiece,
     topShortage — which can carry barcodes/style codes) now
     contribute only their LENGTH as a label, never their
     contents — row-level identifiers never leave the browser
     for this endpoint, matching its own documented Tier 0
     contract. Any string value is still defensively stripped of
     long digit runs (the same '####' replacement pattern already
     used elsewhere in this app, e.g. retail-knowledge.js's
     safeDescription()) as a second layer, not the only one.

     TWO-PASS, PER-FIELD-CAPPED ALLOCATION: a single top-level key
     can contribute at most MAX_LABELS_PER_FIELD labels, AND every
     top-level key is guaranteed at least one before any key gets a
     second. A single depth-first pass with only a per-field cap
     was tried first and found, in production-readiness review, to
     still fail its own goal: with 14 top-level keys in Store
     Review's aggregate and a per-field cap of 4, the first ~4 keys
     (period/comparePeriod/totals/compareTotals) alone reached the
     18-label ceiling, leaving offerMix/weekend/staff/departments/
     festive/brand/sizeCurve at ZERO — exactly the failure this
     mechanism exists to prevent, with the comment on this function
     wrongly claiming it couldn't happen. Fixed by making
     labelsFromContext do PASS 1 (each top-level key gets its first
     natural label only — cap=1) across every key before PASS 2
     (each key gets enriched up to MAX_LABELS_PER_FIELD, if there's
     budget left) even starts — see labelsFromContext below. Still
     fully generic, no per-tool knowledge required. */
  var MAX_LABELS_PER_FIELD = 4;

  function flattenForLabels (val, prefix, labels, depth, fieldBudget) {
    if (Object.keys(labels).length >= MAX_TOOLCTX_LABELS || (fieldBudget && fieldBudget.used >= fieldBudget.max)) return;
    if (val == null || depth > MAX_LABEL_DEPTH) return;
    if (Array.isArray(val)) {
      labels[(prefix || 'items') + 'Count'] = val.length;
      if (fieldBudget) fieldBudget.used++;
      return;
    }
    if (typeof val === 'object') {
      Object.keys(val).forEach(function (k) {
        if (Object.keys(labels).length >= MAX_TOOLCTX_LABELS || (fieldBudget && fieldBudget.used >= fieldBudget.max)) return;
        flattenForLabels(val[k], prefix ? prefix + '.' + k : k, labels, depth + 1, fieldBudget);
      });
      return;
    }
    var key = prefix || 'value';
    if (typeof val === 'number' && isFinite(val)) { labels[key] = val; if (fieldBudget) fieldBudget.used++; return; }
    if (typeof val === 'boolean') { labels[key] = String(val); if (fieldBudget) fieldBudget.used++; return; }
    if (typeof val === 'string') {
      var s = val.trim().replace(LONG_DIGIT_RUN_RE, '####').slice(0, 80);
      if (s) { labels[key] = s; if (fieldBudget) fieldBudget.used++; }
    }
  }

  function labelsFromContext (aggregateContext, stage3, stage4) {
    var labels = {};
    if (stage3 && stage3.retailer) labels.retailer = stage3.retailer;
    if (stage4) {
      labels.duplicatesRemoved = stage4.removedDuplicates || 0;
      labels.anomaliesFlagged = stage4.anomalyCount || 0;
    }
    if (aggregateContext && typeof aggregateContext === 'object') {
      var keys = Object.keys(aggregateContext);
      /* Pass 1 — breadth first: every top-level key gets exactly
         one representative label (its first natural leaf, or a
         count for an array) before any key gets a second. */
      keys.forEach(function (k) {
        if (Object.keys(labels).length >= MAX_TOOLCTX_LABELS) return;
        flattenForLabels(aggregateContext[k], k, labels, 1, { used: 0, max: 1 });
      });
      /* Pass 2 — depth, using whatever budget remains: re-walks
         each key from the top (re-visiting its pass-1 leaf is a
         harmless same-value overwrite, not a new label) so a key
         with more to say can fill in up to MAX_LABELS_PER_FIELD
         total, without ever starving a key that hasn't had its
         turn yet — impossible by construction, since pass 1
         already gave every key its turn. */
      keys.forEach(function (k) {
        if (Object.keys(labels).length >= MAX_TOOLCTX_LABELS) return;
        flattenForLabels(aggregateContext[k], k, labels, 1, { used: 1, max: MAX_LABELS_PER_FIELD });
      });
    }
    return labels;
  }

  /* Converts RetailDecision.evaluate()'s output (Stage 5's
     crossTool) into the exact shape api/chat.js's
     validateDecisionEngine() accepts. Only built when the caller
     didn't already supply one — this closes a gap where Stage 5's
     cross-tool corroboration was computed but never actually
     reached the AI reasoning call. Card lists are capped to 5 —
     api/chat.js REJECTS (400) a longer list rather than truncating
     it, so this must cap before sending, not rely on the server.
     Card titles are real business data (style codes, barcodes,
     staff names — e.g. atRiskFrom() titles a card with the raw
     style code) which routinely contain a 4+ digit run; sanitised
     here with the same '####' replacement used everywhere else in
     this file so this new wiring doesn't reproduce the exact
     digit-run failure fixed in labelsFromContext above. */
  var MAX_CARDS = 5;
  function safeCardLabel (v, maxLen) {
    if (v == null) return v;
    return String(v).trim().replace(LONG_DIGIT_RUN_RE, '####').slice(0, maxLen);
  }
  function cardsForChat (list) {
    return (list || []).slice(0, MAX_CARDS).map(function (c) {
      return {
        title: safeCardLabel(c.title, 60),
        reason: safeCardLabel(c.reason, 150),
        severity: c.severity,
        metricValue: safeCardLabel(c.metricValue, 40)
      };
    });
  }
  function decisionEngineFromCrossTool (crossTool) {
    if (!crossTool) return null;
    return {
      confidenceLevel: crossTool.confidence ? crossTool.confidence.level : null,
      confidenceReason: crossTool.confidence ? safeCardLabel(crossTool.confidence.reason, 150) : null,
      coverageAvailable: (crossTool.coverage && crossTool.coverage.available) || [],
      attention: cardsForChat(crossTool.recommendations && crossTool.recommendations.attention),
      coaching: cardsForChat(crossTool.recommendations && crossTool.recommendations.coaching),
      atRisk: cardsForChat(crossTool.recommendations && crossTool.recommendations.atRisk)
    };
  }

  async function stage6And7Reason (toolName, aggregateContext, stage1, stage3, stage4, stage5, decisionEngineForChat) {
    var token = await idToken();
    if (!token) return { ok: false, reason: 'signed_out' };

    var body = {
      question: UNIVERSAL_QUESTION,
      history: [],
      decisionEngine: decisionEngineForChat || decisionEngineFromCrossTool(stage5 && stage5.crossTool),
      retailIntelligence: stage3 ? {
        fileType: stage1 ? stage1.fileType : null, fileTypeConfidence: stage1 ? stage1.confidence : null,
        retailer: stage3.retailer, retailerConfidence: stage3.confidence, retailerMode: stage3.mode
      } : null,
      retailKnowledge: null,
      toolContext: { toolName: toolName || null, labels: labelsFromContext(aggregateContext, stage3, stage4) }
    };

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    var res;
    try {
      res = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(body)
      });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, reason: 'network' };
    }
    clearTimeout(timer);

    if (!res.ok) {
      if (res.status === 429) return { ok: false, reason: 'rate_limited' };
      if (res.status === 401) return { ok: false, reason: 'signed_out' };
      return { ok: false, reason: 'unavailable' };
    }
    var data;
    try { data = await res.json(); } catch (e) { return { ok: false, reason: 'bad_response' }; }
    if (!data || typeof data.answer !== 'string' || !data.answer.trim()) return { ok: false, reason: 'bad_response' };
    return { ok: true, answer: data.answer, source: 'ai' };
  }

  /* Splits the consultant's structured prose (see UNIVERSAL_QUESTION)
     into the Stage 9 buckets on a best-effort basis. If the model
     didn't follow the requested structure, the whole answer still
     lands in executiveSummary rather than being silently dropped —
     never worse than not asking. */
  var SECTION_RE = /(Executive Summary|Key Findings|Business Impact|Recommendations)\s*:?/i;
  function splitAnswer (answer) {
    var out = { executiveSummary: '', keyFindings: [], businessImpact: [], recommendations: [] };
    var parts = answer.split(SECTION_RE);
    if (parts.length < 2) { out.executiveSummary = answer.trim(); return out; }
    var current = 'executiveSummary';
    if (parts[0].trim()) out.executiveSummary = parts[0].trim();
    for (var i = 1; i < parts.length; i += 2) {
      var heading = (parts[i] || '').toLowerCase();
      var body = (parts[i + 1] || '').trim();
      var bucket = heading.indexOf('executive') === 0 ? 'executiveSummary'
        : heading.indexOf('key') === 0 ? 'keyFindings'
        : heading.indexOf('business') === 0 ? 'businessImpact'
        : heading.indexOf('recommend') === 0 ? 'recommendations' : null;
      if (!bucket) continue;
      if (bucket === 'executiveSummary') { out.executiveSummary = out.executiveSummary || body; continue; }
      out[bucket] = body.split(/\n+|(?:^|\n)[-•]\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return out;
  }

  /* ============================================================
     Stage 9 — Universal Output
     ============================================================ */
  function formatUniversalOutput (stage1, stage3, stage4, stage5, aiResult) {
    var warnings = [].concat(stage1.warnings || [], stage3.retailer === 'unknown' || stage3.retailer == null
      ? ['Retailer could not be confidently identified (' + stage3.level + ' confidence).' + (stage3.suggestedName ? ' AI suggests this may be "' + stage3.suggestedName + '" — not yet a registered retailer; confirm to add it.' : '')]
      : []);

    var confidenceScore = Math.round(((stage1.confidence || 0) * 0.3 + (stage3.confidence || 0) * 0.5 + (aiResult.ok ? 0.2 : 0)) * 100) / 100;

    var split = aiResult.ok ? splitAnswer(aiResult.answer) : { executiveSummary: '', keyFindings: [], businessImpact: [], recommendations: [] };

    /* Deliberately does NOT include split.recommendations here —
       those already render under "Recommendations" (see below);
       concatenating them again duplicated every recommendation on
       screen. nextBestActions stays scoped to deterministic,
       pipeline-level follow-ups the AI's own recommendations don't
       already cover. */
    var nextBestActions = [];
    if (stage3.mode === 'confirm' || stage3.mode === 'universal') nextBestActions.push('Confirm the detected retailer/brand so future uploads skip this step.');
    if (stage4.anomalyCount) nextBestActions.push('Review the ' + stage4.anomalyCount + ' flagged row(s) for data-entry issues before acting on this report.');
    if (!aiResult.ok) nextBestActions.push('AI analysis was unavailable (' + (aiResult.reason || 'unknown') + ') — the deterministic figures above are still reliable on their own.');

    return {
      executiveSummary: split.executiveSummary || (aiResult.ok ? '' : 'AI analysis unavailable this session — see the deterministic figures in this report.'),
      keyFindings: split.keyFindings,
      businessImpact: split.businessImpact,
      recommendations: split.recommendations,
      confidenceScore: confidenceScore,
      warnings: warnings,
      dataQualityNotes: stage4.dataQualityNotes || [],
      aiObservations: aiResult.ok ? [aiResult.answer] : [],
      nextBestActions: nextBestActions,
      source: aiResult.ok ? 'ai' : 'rules',
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * run(input) — the Universal AI Pipeline entry point.
   * @param {Object} input
   * @param {Array<{name:string, rows:Array<Array>}>} input.sheets  raw parsed sheets
   * @param {string} [input.toolName]  e.g. 'Inventory Validity Console'
   * @param {Array}  [input.canonicalRows]  RetailSchema rows, if the tool has them (Stage 4/8 input)
   * @param {Object} [input.aggregateContext]  the tool's own already-built summary object (Stage 5/6 input)
   * @param {Object} [input.decisionEngineForChat]  pre-shaped decisionEngine object for /api/chat, if the
   *        caller already has one from RetailDecision.evaluate() (matches api/chat.js's own validated shape)
   * @returns {Promise<Object>} never throws — every stage degrades independently.
   *   { stage1, stage2, stage3, stage4, stage5, report }
   */
  async function run (input) {
    input = input || {};
    var sheets = input.sheets || [];

    var stage1 = await stage1Validate(sheets);
    var stage2 = stage2Understand(sheets);
    var stage3 = await stage3Intelligence(sheets);
    var stage4 = stage4Clean(input.canonicalRows);
    var stage5 = stage5Analyse(input.aggregateContext);

    var ai = await stage6And7Reason(input.toolName, input.aggregateContext, stage1, stage3, stage4, stage5, input.decisionEngineForChat);
    var report = formatUniversalOutput(stage1, stage3, stage4, stage5, ai);

    return { stage1: stage1, stage2: stage2, stage3: stage3, stage4: stage4, stage5: stage5, report: report };
  }

  window.AIPipeline = { run: run, formatUniversalOutput: formatUniversalOutput };
}());

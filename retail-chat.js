/* =========================================================
   retail-chat.js — Retail AI · Context-Aware AI Assistant
   client (Phase 7 Step E, AI Intelligence Core)
   ---------------------------------------------------------
   ES module (needs `import` — talks to its own endpoint,
   api/chat.js, and needs a fresh Firebase ID token the same way
   retail-insights.js / retail-knowledge.js do):

       <script type="module" src="retail-chat.js"></script>

   WHAT THIS FILE IS
   ---------------------------------------------------------
   ask(question, context) — the one entry point a tool needs.
   Answers like an experienced retail business consultant (the
   persona lives in api/chat.js's prompt, not here), grounded in
   whatever aggregate context the caller supplies: Decision Engine
   output, Retail Intelligence file/retailer detection, Retail
   Knowledge Intelligence's enrichment rollup, and the tool's own
   already-on-screen report context — plus the conversation so
   far, which this module holds in memory for the caller so every
   tool doesn't have to re-implement history management.

   MODULAR BY DESIGN (so future tools automatically benefit)
   ---------------------------------------------------------
   This file has NO knowledge of any specific tool. A calling page
   builds its own context using the four small builder functions
   below (buildDecisionEngineContext, buildRetailIntelligenceContext,
   buildRetailKnowledgeContext, buildToolContext) — each normalises
   and caps whatever real object that tool already has (an
   `evaluate()` result, a `classifyFileType()`/`detectRetailer()`
   result, an `enrichItems()` array, or just a plain label object)
   into the shape api/chat.js's egress guard expects, so no future
   caller needs to hand-roll the exact request schema or its caps.
   Any of the four context pieces may be omitted — ask() and the
   server both treat a missing piece as "not available this
   session," never an error.

   WHAT THIS STEP DOES NOT DO
   ---------------------------------------------------------
   - Does not modify retail-decision.js, retail-schema.js (Phase A,
     locked), retail-intelligence.js (Phase B, locked), or anything
     Steps C/D built (Phase C/D, locked) — all only ever read from
     by the context builders below, never changed.
   - Not wired into any tool page yet — same standalone posture as
     every prior Phase 7 step. Store_Review a1.html's reserved
     #aiOverlay/btnAI stub is a separate, later, explicitly-scoped
     wiring decision, not part of this step.
   - No conversation is persisted anywhere server-side — history
     lives only in this module's in-memory state for the lifetime
     of the page, exactly like retail-decision.js's localStorage
     blackboard never stores anything more sensitive than aggregate
     summaries, except here it's not even localStorage — a page
     refresh clears it.
   ========================================================= */
import { auth } from "./firebase.js";

(function () {
  'use strict';

  var ENDPOINT = '/api/chat';
  var TIMEOUT_MS = 20000;             // chat answers are longer than a one-shot classification; more generous than Steps C/D's 12s
  var MAX_HISTORY_TURNS = 8;
  var MAX_HISTORY_TEXT_LEN = 300;
  var MAX_QUESTION_LEN = 500;

  var history = [];                   // session-scoped, in-memory only — never persisted

  async function idToken () {
    var u = auth.currentUser;
    if (!u) return null;
    try { return await u.getIdToken(); } catch (e) { return null; }
  }

  function pushHistory (role, text) {
    history.push({ role: role, text: String(text == null ? '' : text).slice(0, MAX_HISTORY_TEXT_LEN) });
    if (history.length > MAX_HISTORY_TURNS) history = history.slice(-MAX_HISTORY_TURNS);
  }

  /* ---------- context builders (Decision 2 / requirement 3's four data sources) ---------- */

  /* Global flag is required — without it, String.replace() only
     strips the FIRST digit run in a value. A value carrying two
     separate runs (e.g. a composite style code, or a barcode plus
     a season code in the same field) previously kept its second
     run intact, which api/chat.js's own (correctly stricter) guard
     then rejected with a 500 — a real, currently-live bug found in
     production-readiness review, not something this migration
     introduced but squarely in the same endpoint it touches.
     Replacing with '####' rather than '' also avoids turning an
     all-digit value (e.g. a Jaypore style code, which IS digits)
     into an empty, identity-less label. */
  var DIGIT_RUN_RE = /\d{4,}/g;
  function capLabel (v, max) {
    if (v == null) return null;
    var s = String(v).trim().slice(0, max || 60);
    return s.replace(DIGIT_RUN_RE, '####');   // defensive — these fields originate from retailer data, not user-authored text
  }
  function capNum01 (v) {
    return (typeof v === 'number' && isFinite(v)) ? Math.max(0, Math.min(1, v)) : null;
  }

  /**
   * buildDecisionEngineContext(evaluateResult) — from RetailDecision.evaluate()'s
   * return value (coverage/confidence/recommendations), already the same
   * aggregate data index.html's own panel renders. Caps each category to
   * its top 5 cards (by whatever order evaluate() already sorted them).
   */
  function buildDecisionEngineContext (evaluateResult) {
    if (!evaluateResult) return null;
    var rec = evaluateResult.recommendations || {};
    var capCards = function (list) {
      return (list || []).slice(0, 5).map(function (c) {
        return {
          title: capLabel(c.title, 60),
          reason: capLabel(c.reason, 150),
          severity: (c.severity === 'low' || c.severity === 'medium' || c.severity === 'high') ? c.severity : undefined,
          metricValue: c.metricValue != null ? capLabel(c.metricValue, 40) : undefined
        };
      });
    };
    return {
      confidenceLevel: (evaluateResult.confidence && evaluateResult.confidence.level) || null,
      confidenceReason: evaluateResult.confidence ? capLabel(evaluateResult.confidence.reason, 150) : null,
      coverageAvailable: ((evaluateResult.coverage && evaluateResult.coverage.available) || []).slice(0, 6),
      attention: capCards(rec.attention),
      coaching: capCards(rec.coaching),
      atRisk: capCards(rec.atRisk)
    };
  }

  /**
   * buildRetailIntelligenceContext(fileTypeResult, retailerResult) — from
   * RetailIntelligence.classifyFileType()/detectRetailer() (Phase B) or
   * RetailKnowledge.classifyFile()/detectRetailer() (Phase C, same shape).
   */
  function buildRetailIntelligenceContext (fileTypeResult, retailerResult) {
    if (!fileTypeResult && !retailerResult) return null;
    var out = {};
    if (fileTypeResult) {
      out.fileType = capLabel(fileTypeResult.fileType, 30);
      out.fileTypeConfidence = capNum01(fileTypeResult.confidence);
    }
    if (retailerResult) {
      out.retailer = capLabel(retailerResult.retailer, 30);
      out.retailerConfidence = capNum01(retailerResult.confidence);
      if (retailerResult.mode === 'auto' || retailerResult.mode === 'confirm' || retailerResult.mode === 'universal') {
        out.retailerMode = retailerResult.mode;
      }
    }
    return out;
  }

  /**
   * buildRetailKnowledgeContext(enrichedRows) — from RetailKnowledge.
   * enrichItems()'s return value (Phase D). Deliberately reduces the raw
   * per-item array down to a ROLLUP (counts + top-5 category/brand/family
   * labels) — sending individual items here would leak Tier 2 data into
   * this Tier 0 endpoint; api/chat.js's validator enforces this shape too,
   * this function just makes it easy to build correctly.
   */
  function buildRetailKnowledgeContext (enrichedRows) {
    if (!enrichedRows || !enrichedRows.length) return null;
    var byCategory = {}, byBrand = {}, byFamily = {}, enrichedCount = 0;
    var bump = function (map, key) { if (key) map[key] = (map[key] || 0) + 1; };
    enrichedRows.forEach(function (r) {
      if (!r || !r.intelligence || r.intelligence.source !== 'ai') return;
      enrichedCount++;
      bump(byCategory, r.category);
      bump(byBrand, r.brand);
      bump(byFamily, r.productFamily);
    });
    if (!enrichedCount) return null;
    var top5 = function (map) {
      return Object.keys(map)
        .map(function (k) { return { key: capLabel(k, 60), count: map[k] }; })
        .sort(function (a, b) { return b.count - a.count; })
        .slice(0, 5);
    };
    return {
      enrichedCount: enrichedCount,
      topCategories: top5(byCategory),
      topBrands: top5(byBrand),
      topProductFamilies: top5(byFamily)
    };
  }

  /**
   * buildToolContext(toolName, labels) — wraps whatever small aggregate
   * label object a tool already has (e.g. Store Review's own AI_CONTEXT
   * totals) into the capped shape api/chat.js expects. `labels` should be
   * a flat object of short strings/numbers already safe to show on
   * screen — the same standard every other AI feature in this app already
   * holds its context to.
   */
  function buildToolContext (toolName, labels) {
    var out = { toolName: capLabel(toolName, 40), labels: {} };
    if (labels) {
      Object.keys(labels).slice(0, 20).forEach(function (k) {
        var v = labels[k];
        out.labels[k] = (typeof v === 'number' && isFinite(v)) ? v : capLabel(v, 80);
      });
    }
    return out;
  }

  /**
   * ask(question, context) — always resolves, never throws.
   * @param {string} question
   * @param {Object} [context]
   * @param {Object} [context.decisionEngine]     from buildDecisionEngineContext()
   * @param {Object} [context.retailIntelligence] from buildRetailIntelligenceContext()
   * @param {Object} [context.retailKnowledge]    from buildRetailKnowledgeContext()
   * @param {Object} [context.toolContext]        from buildToolContext()
   * @returns {Promise<{ok:true, answer:string, source:'ai'} | {ok:false, reason:string}>}
   *   reason: 'invalid_question'|'signed_out'|'rate_limited'|'unavailable'|'network'|'bad_response'
   *   Same typed-failure-reason pattern as retail-insights.js, since (like
   *   a missing AI summary) there is no equally-good non-AI fallback for a
   *   missing chat answer.
   */
  async function ask (question, context) {
    question = String(question == null ? '' : question).trim();
    if (!question) return { ok: false, reason: 'invalid_question' };
    if (question.length > MAX_QUESTION_LEN) question = question.slice(0, MAX_QUESTION_LEN);

    var token;
    try { token = await idToken(); } catch (e) { token = null; }
    if (!token) return { ok: false, reason: 'signed_out' };

    var body = {
      question: question,
      history: history.slice(),
      decisionEngine: (context && context.decisionEngine) || null,
      retailIntelligence: (context && context.retailIntelligence) || null,
      retailKnowledge: (context && context.retailKnowledge) || null,
      toolContext: (context && context.toolContext) || null
    };

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    var res;
    try {
      res = await fetch(ENDPOINT, {
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
    if (!data || typeof data.answer !== 'string' || !data.answer) return { ok: false, reason: 'bad_response' };

    pushHistory('user', question);
    pushHistory('assistant', data.answer);
    return { ok: true, answer: data.answer, source: 'ai' };
  }

  function clearHistory () { history = []; }
  function getHistory () { return history.slice(); }

  window.RetailChat = {
    ask: ask,
    clearHistory: clearHistory,
    getHistory: getHistory,
    buildDecisionEngineContext: buildDecisionEngineContext,
    buildRetailIntelligenceContext: buildRetailIntelligenceContext,
    buildRetailKnowledgeContext: buildRetailKnowledgeContext,
    buildToolContext: buildToolContext
  };
}());

/* =========================================================
   api/chat.js — Retail AI · Context-Aware AI Assistant endpoint
   ---------------------------------------------------------
   Vercel serverless function. Auth, rate limiting and the
   Gemini call itself now live in ./_lib/ai-core.js (Universal
   AI Pipeline core, shared by every AI endpoint) — this file
   keeps only what's genuinely specific to this task: its
   request shape, its egress guard, its "retail consultant"
   prompt, and its response sanitiser. Request/response shapes,
   status codes, rate limits and env vars are unchanged from
   before this refactor.

   WHAT THIS IS
   ---------------------------------------------------------
   The AI tier behind retail-chat.js's ask(question, context).
   Answers a manager's question grounded ONLY in already-
   aggregated data: the Decision Engine's own output
   (RetailDecision.evaluate()), Retail Intelligence's file/
   retailer classification, a Retail Knowledge Intelligence
   enrichment ROLLUP (never raw enriched items, see
   retailKnowledge validation below), whatever small aggregate
   context the calling tool already built (toolContext), and the
   conversation so far. Answers with the voice of an experienced
   retail business consultant, not a generic chatbot.

   AI DATA POLICY — this endpoint's privacy boundary is
   genuinely different from every other AI endpoint in this app:
     - `question` and `history[].text` are the user's OWN typed
       words — free text, length-capped, nothing else.
     - Every OTHER field (decisionEngine / retailIntelligence /
       retailKnowledge / toolContext) originates from retailer
       business data, even in already-aggregated form, and is
       validated accordingly: allowlisted shape, length-capped
       strings, long-digit-run rejection.
     - retailKnowledge is EXPLICITLY a rollup (counts + top-N
       category/brand/family labels), never the raw per-item
       output of api/retail-knowledge.js's task:'enrich-items'.
     - No conversation is ever persisted server-side.

   ENV VARS (identical to the other three AI endpoints):
     GEMINI_API_KEY   required
     GEMINI_MODEL     optional, default gemini-2.5-flash-lite
     FIREBASE_PROJECT optional, default retail-ai-2c674
   ========================================================= */
'use strict';

const core = require('./_lib/ai-core');

/* ---------- limits (unchanged) ---------- */
const MAX_QUESTION_LEN   = 500;
const MAX_HISTORY_TURNS  = 8;
const MAX_HISTORY_LEN    = 300;
const MAX_CARDS          = 5;
const MAX_CARD_TITLE_LEN = 60;
const MAX_CARD_TEXT_LEN  = 150;
const MAX_CARD_METRIC_LEN = 40;
const MAX_COVERAGE_TOOLS = 6;
const MAX_LABEL_LEN      = 60;
const MAX_ROLLUP_ITEMS   = 5;
const MAX_TOOLCTX_LABELS = 20;
const MAX_TOOLCTX_LABEL_LEN = 80;
const MAX_BODY_BYTES     = 20 * 1024;
const GEMINI_TIMEOUT     = 12000;
const rateLimited = core.makeRateLimiter(30, 150);   // unchanged — more generous than one-shot endpoints

/* =========================================================
   1. Egress guard
   ========================================================= */
function checkFreeText(v, field, maxLen) {
  if (typeof v !== 'string') throw new Error(field + ' must be a string');
  if (v.length > maxLen) throw new Error(field + ' too long');
  return v;
}
/* Unlike checkFreeText, this is for fields that originate from
   RETAILER data (even aggregated) rather than the user's own
   words — those get the digit-run guard too. IMPORTANT: only the
   digit-run check is a genuine egress-guard trip (500) — a
   malformed type/length is an ordinary client bug (400), matching
   this endpoint's original, pre-refactor behaviour. core.checkLabel
   prefixes every failure with EGRESS GUARD (correct for
   api/summarize.js, whose original code did the same) but doing
   that here silently turned every malformed toolContext/decision
   card field into a false-alarm 500 instead of a 400 — found in
   production-readiness review, fixed by composing checkFreeText
   (unprefixed) with a separately-prefixed digit-run check instead
   of delegating the whole thing to core.checkLabel. */
function checkLabel(v, field, maxLen) {
  checkFreeText(v, field, maxLen);
  if (core.DIGIT_RUN_RE_4.test(v)) throw new Error('EGRESS GUARD: ' + field + ' looks like raw data (long digit run)');
  return v;
}
function checkNum01(v, field) { return core.checkNum01(v, field); }
/* Also originally unprefixed on this endpoint (unlike
   api/summarize.js's own checkNum, which was and still is
   EGRESS-GUARD-prefixed) — see the note on checkLabel above for
   why this can't delegate straight to core.checkNum here. */
function checkNum(v, field) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !isFinite(v)) throw new Error(field + ' must be a finite number');
  return v;
}

function validateHistory(history) {
  if (history === undefined || history === null) return [];
  if (!Array.isArray(history)) throw new Error('history must be an array');
  if (history.length > MAX_HISTORY_TURNS) throw new Error('history too long');
  return history.map((h) => {
    if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error('history entry must be an object');
    if (h.role !== 'user' && h.role !== 'assistant') throw new Error('bad history role');
    return { role: h.role, text: checkFreeText(h.text || '', 'history.text', MAX_HISTORY_LEN) };
  });
}

function validateCardList(list, field) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(field + ' must be an array');
  if (list.length > MAX_CARDS) throw new Error(field + ' too long');
  return list.map((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(field + ' entry must be an object');
    const allowed = ['title', 'reason', 'severity', 'metricValue'];
    for (const k of Object.keys(c)) if (!allowed.includes(k)) throw new Error('unexpected field in ' + field + ': ' + k);
    const out = {};
    if (c.title != null) out.title = checkLabel(c.title, field + '.title', MAX_CARD_TITLE_LEN);
    if (c.reason != null) out.reason = checkLabel(c.reason, field + '.reason', MAX_CARD_TEXT_LEN);
    if (c.severity != null) {
      if (!['low', 'medium', 'high'].includes(c.severity)) throw new Error('bad severity');
      out.severity = c.severity;
    }
    if (c.metricValue != null) out.metricValue = checkLabel(String(c.metricValue), field + '.metricValue', MAX_CARD_METRIC_LEN);
    return out;
  });
}

function validateDecisionEngine(d) {
  if (d === undefined || d === null) return null;
  if (typeof d !== 'object' || Array.isArray(d)) throw new Error('decisionEngine must be an object');
  const allowed = ['confidenceLevel', 'confidenceReason', 'coverageAvailable', 'attention', 'coaching', 'atRisk'];
  for (const k of Object.keys(d)) if (!allowed.includes(k)) throw new Error('unexpected field in decisionEngine: ' + k);

  let confidenceLevel = null;
  if (d.confidenceLevel != null) {
    if (!['high', 'medium', 'low', 'none'].includes(d.confidenceLevel)) throw new Error('bad confidenceLevel');
    confidenceLevel = d.confidenceLevel;
  }
  let confidenceReason = null;
  if (d.confidenceReason != null) confidenceReason = checkLabel(d.confidenceReason, 'decisionEngine.confidenceReason', MAX_CARD_TEXT_LEN);

  let coverageAvailable = [];
  if (d.coverageAvailable != null) {
    if (!Array.isArray(d.coverageAvailable)) throw new Error('coverageAvailable must be an array');
    if (d.coverageAvailable.length > MAX_COVERAGE_TOOLS) throw new Error('coverageAvailable too long');
    coverageAvailable = d.coverageAvailable.map((t) => checkLabel(t, 'coverageAvailable[]', MAX_LABEL_LEN));
  }

  return {
    confidenceLevel,
    confidenceReason,
    coverageAvailable,
    attention: validateCardList(d.attention, 'decisionEngine.attention'),
    coaching: validateCardList(d.coaching, 'decisionEngine.coaching'),
    atRisk: validateCardList(d.atRisk, 'decisionEngine.atRisk')
  };
}

function validateRetailIntelligence(ri) {
  if (ri === undefined || ri === null) return null;
  if (typeof ri !== 'object' || Array.isArray(ri)) throw new Error('retailIntelligence must be an object');
  const allowed = ['fileType', 'fileTypeConfidence', 'retailer', 'retailerConfidence', 'retailerMode'];
  for (const k of Object.keys(ri)) if (!allowed.includes(k)) throw new Error('unexpected field in retailIntelligence: ' + k);
  const out = {};
  if (ri.fileType != null) out.fileType = checkLabel(ri.fileType, 'retailIntelligence.fileType', MAX_LABEL_LEN);
  out.fileTypeConfidence = checkNum01(ri.fileTypeConfidence, 'retailIntelligence.fileTypeConfidence');
  if (ri.retailer != null) out.retailer = checkLabel(ri.retailer, 'retailIntelligence.retailer', MAX_LABEL_LEN);
  out.retailerConfidence = checkNum01(ri.retailerConfidence, 'retailIntelligence.retailerConfidence');
  if (ri.retailerMode != null) {
    if (!['auto', 'confirm', 'universal'].includes(ri.retailerMode)) throw new Error('bad retailerMode');
    out.retailerMode = ri.retailerMode;
  }
  return out;
}

function validateRollup(list, field) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(field + ' must be an array');
  if (list.length > MAX_ROLLUP_ITEMS) throw new Error(field + ' too long');
  return list.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(field + ' entry must be an object');
    const allowed = ['key', 'count'];
    for (const k of Object.keys(r)) if (!allowed.includes(k)) throw new Error('unexpected field in ' + field + ': ' + k);
    return { key: checkLabel(r.key, field + '.key', MAX_LABEL_LEN), count: checkNum(r.count, field + '.count') };
  });
}

/* retailKnowledge must be a ROLLUP (counts + top-N labels) —
   never the raw per-item enrichItems() output. */
function validateRetailKnowledge(rk) {
  if (rk === undefined || rk === null) return null;
  if (typeof rk !== 'object' || Array.isArray(rk)) throw new Error('retailKnowledge must be an object');
  const allowed = ['enrichedCount', 'topCategories', 'topBrands', 'topProductFamilies'];
  for (const k of Object.keys(rk)) if (!allowed.includes(k)) throw new Error('unexpected field in retailKnowledge: ' + k);
  return {
    enrichedCount: checkNum(rk.enrichedCount, 'retailKnowledge.enrichedCount'),
    topCategories: validateRollup(rk.topCategories, 'retailKnowledge.topCategories'),
    topBrands: validateRollup(rk.topBrands, 'retailKnowledge.topBrands'),
    topProductFamilies: validateRollup(rk.topProductFamilies, 'retailKnowledge.topProductFamilies')
  };
}

function validateToolContext(tc) {
  if (tc === undefined || tc === null) return null;
  if (typeof tc !== 'object' || Array.isArray(tc)) throw new Error('toolContext must be an object');
  const allowed = ['toolName', 'labels'];
  for (const k of Object.keys(tc)) if (!allowed.includes(k)) throw new Error('unexpected field in toolContext: ' + k);
  const out = { toolName: tc.toolName != null ? checkLabel(tc.toolName, 'toolContext.toolName', MAX_LABEL_LEN) : null, labels: {} };
  if (tc.labels != null) {
    if (typeof tc.labels !== 'object' || Array.isArray(tc.labels)) throw new Error('toolContext.labels must be an object');
    const keys = Object.keys(tc.labels);
    if (keys.length > MAX_TOOLCTX_LABELS) throw new Error('toolContext.labels too long');
    keys.forEach((k) => {
      const v = tc.labels[k];
      if (typeof v === 'number') { out.labels[k] = checkNum(v, 'toolContext.labels.' + k); }
      else { out.labels[k] = checkLabel(String(v), 'toolContext.labels.' + k, MAX_TOOLCTX_LABEL_LEN); }
    });
  }
  return out;
}

function validateBody(body) {
  const allowed = ['question', 'history', 'decisionEngine', 'retailIntelligence', 'retailKnowledge', 'toolContext'];
  for (const k of Object.keys(body || {})) {
    if (!allowed.includes(k)) throw new Error('unexpected field: ' + k);
  }
  const question = checkFreeText(body.question, 'question', MAX_QUESTION_LEN);
  if (!question.trim()) throw new Error('question required');

  return {
    question,
    history: validateHistory(body.history),
    decisionEngine: validateDecisionEngine(body.decisionEngine),
    retailIntelligence: validateRetailIntelligence(body.retailIntelligence),
    retailKnowledge: validateRetailKnowledge(body.retailKnowledge),
    toolContext: validateToolContext(body.toolContext)
  };
}

/* =========================================================
   2. Gemini — the "experienced retail business consultant"
   persona lives entirely in this prompt.
   ========================================================= */
function fmtCards(list) {
  if (!list || !list.length) return '  (none)';
  return list.map(c => {
    const bits = [];
    if (c.title) bits.push(c.title);
    if (c.severity) bits.push('severity=' + c.severity);
    if (c.metricValue) bits.push(c.metricValue);
    if (c.reason) bits.push('— ' + c.reason);
    return '  - ' + bits.join(' · ');
  }).join('\n');
}
function fmtRollup(list) {
  if (!list || !list.length) return '(none)';
  return list.map(r => r.key + ' (' + r.count + ')').join(', ');
}

function buildPrompt(d) {
  const parts = [
    'You are an experienced retail business consultant embedded inside Retail AI, a suite of',
    'tools built for Indian fashion-retail store and area managers. You are NOT a generic AI',
    'chatbot — you speak like a knowledgeable colleague who has spent years on the shop floor',
    'and in merchandising reviews: direct, specific, and always grounded in the real numbers',
    'you are given below, never in generic advice.',
    '',
    'Hard rules:',
    '- Use ONLY the data given below. Never invent a number, a name, a product, or a fact that',
    '  is not present. If the available data cannot answer the question, say so plainly and',
    '  name what report or upload would answer it — do not guess.',
    '- Currency is INR — use the ₹ symbol and Indian digit grouping (e.g. ₹1,23,456).',
    '- Reference specific figures, categories, brands, or recommendation titles from the context',
    '  when they are relevant to the question.',
    '- Keep answers concise and actionable — written for someone reading on the shop floor, not',
    '  a boardroom memo.',
    '- If asked something outside retail operations, merchandising, or sales analysis, politely',
    '  redirect to what you can help with from the available data.',
    ''
  ];

  parts.push('=== Decision Engine (deterministic, rule-based recommendations already computed) ===');
  if (d.decisionEngine) {
    const de = d.decisionEngine;
    parts.push('Confidence: ' + (de.confidenceLevel || 'unknown') + (de.confidenceReason ? ' — ' + de.confidenceReason : ''));
    parts.push('Tools contributing data: ' + (de.coverageAvailable.length ? de.coverageAvailable.join(', ') : '(none yet)'));
    parts.push('Needs Attention:'); parts.push(fmtCards(de.attention));
    parts.push('Staff Coaching:'); parts.push(fmtCards(de.coaching));
    parts.push('Inventory At Risk:'); parts.push(fmtCards(de.atRisk));
  } else {
    parts.push('(not available for this session)');
  }
  parts.push('');

  parts.push('=== Retail Intelligence (file type / retailer detection) ===');
  if (d.retailIntelligence) {
    const ri = d.retailIntelligence;
    parts.push('Detected file type: ' + (ri.fileType || 'unknown') + (ri.fileTypeConfidence != null ? ' (confidence ' + ri.fileTypeConfidence + ')' : ''));
    parts.push('Detected retailer: ' + (ri.retailer || 'unknown') + (ri.retailerConfidence != null ? ' (confidence ' + ri.retailerConfidence + ', ' + (ri.retailerMode || 'n/a') + ')' : ''));
  } else {
    parts.push('(not available for this session)');
  }
  parts.push('');

  parts.push('=== Retail Knowledge Intelligence (AI item enrichment summary) ===');
  if (d.retailKnowledge) {
    const rk = d.retailKnowledge;
    parts.push((rk.enrichedCount || 0) + ' item(s) enriched this session.');
    parts.push('Top categories: ' + fmtRollup(rk.topCategories));
    parts.push('Top brands: ' + fmtRollup(rk.topBrands));
    parts.push('Top product families: ' + fmtRollup(rk.topProductFamilies));
  } else {
    parts.push('(not available for this session)');
  }
  parts.push('');

  parts.push('=== Current tool report context ===');
  if (d.toolContext && (d.toolContext.toolName || Object.keys(d.toolContext.labels || {}).length)) {
    parts.push('Tool: ' + (d.toolContext.toolName || 'unknown'));
    Object.keys(d.toolContext.labels || {}).forEach(k => parts.push('  ' + k + ': ' + d.toolContext.labels[k]));
  } else {
    parts.push('(not available for this session)');
  }
  parts.push('');

  parts.push('=== Conversation so far ===');
  if (d.history.length) {
    d.history.forEach(h => parts.push((h.role === 'user' ? 'Manager' : 'Consultant') + ': ' + h.text));
  } else {
    parts.push('(this is the first message)');
  }
  parts.push('');

  parts.push('Manager: ' + d.question);
  parts.push('');
  parts.push('Respond with JSON only, no markdown, no commentary: {"answer":"your response as plain text"}');

  return parts.join('\n');
}

/* Never trust the model's output shape. */
function sanitise(ai) {
  const answer = typeof (ai && ai.answer) === 'string' ? ai.answer.trim().slice(0, 2000) : '';
  return { answer };
}

/* =========================================================
   3. Handler
   ========================================================= */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-RA-Version', '1');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return core.notConfigured(res, 'api/chat');
  }

  let uid;
  try {
    uid = await core.requireAuth(req);
  } catch (e) {
    return core.unauthorized(res);
  }

  const limited = rateLimited(uid);
  if (limited) {
    return core.rateLimitedResponse(res, limited);
  }

  let input;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
      throw new Error('payload too large');
    }
    input = validateBody(body);
  } catch (e) {
    if (String(e.message).startsWith('EGRESS GUARD')) {
      return core.egressGuardTripped(res, '/api/chat', e.message);
    }
    return core.badRequest(res, e.message);
  }

  try {
    const got = await core.callGeminiCascade(buildPrompt(input), { temperature: 0.4, maxOutputTokens: 500, timeout: GEMINI_TIMEOUT });
    const clean = sanitise(got.ai);
    if (!clean.answer) throw new Error('empty_answer');
    console.log(JSON.stringify({ evt: 'chat', ok: true, model: got.model, qLen: input.question.length, aLen: clean.answer.length }));
    return res.status(200).json({ ...clean, model: got.model, source: 'ai' });
  } catch (e) {
    console.log(JSON.stringify({ evt: 'chat', ok: false, code: e.message, detail: String(e.detail || '').slice(0, 180) }));
    return core.geminiFailure(res, e);
  }
};

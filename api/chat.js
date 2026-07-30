/* =========================================================
   api/chat.js — Retail AI · Context-Aware AI Assistant
   endpoint (Phase 7 Step E, AI Intelligence Core)
   ---------------------------------------------------------
   Vercel serverless function. ZERO npm dependencies. Same
   security skeleton as api/map-schema.js / api/retail-
   knowledge.js / api/summarize.js (Firebase ID token
   verification, no firebase-admin, per-user in-memory rate
   limit, Gemini model cascade, fail-closed egress guard) —
   copied and adapted deliberately, not re-invented.

   WHAT THIS IS
   ---------------------------------------------------------
   The AI tier behind retail-chat.js's ask(question, context).
   Answers a manager's question grounded ONLY in already-
   aggregated data: the Decision Engine's own output
   (RetailDecision.evaluate()), Retail Intelligence's file/
   retailer classification (Phase B/C), a Retail Knowledge
   Intelligence enrichment ROLLUP (Phase D — never raw enriched
   items, see retailKnowledge validation below), whatever small
   aggregate context the calling tool already built (toolContext,
   the same kind of object retail-insights.js already sends
   today), and the conversation so far. Answers with the voice of
   an experienced retail business consultant (see buildPrompt),
   not a generic chatbot.

   AI DATA POLICY (PROJECT_STATUS.md §3.7) — this endpoint's
   privacy boundary is GENUINELY DIFFERENT from every other AI
   endpoint in this app, by necessity, not oversight:
     - `question` and `history[].text` are the user's OWN typed
       words. They are free text and cannot be masked the way
       every other AI call in this app masks retailer business
       data — but they are also not retailer data at all; the
       user is their author, the same way any chat product's user
       controls what they type. Length-capped, nothing else.
     - Every OTHER field (decisionEngine / retailIntelligence /
       retailKnowledge / toolContext) DOES originate from retailer
       business data, even in already-aggregated form, and is
       validated accordingly: allowlisted shape, length-capped
       strings, and — because these fields could in principle be
       used to smuggle something that shouldn't be here — the same
       long-digit-run rejection (DIGIT_RUN_RE) api/summarize.js
       already applies to its own Tier 0 labels today.
     - retailKnowledge is EXPLICITLY a rollup (counts + top-N
       category/brand/family labels), never the raw per-item
       output of api/retail-knowledge.js's task:'enrich-items' —
       sending individual enriched items here would be Tier 2 data
       leaking into a Tier 0 endpoint. The validator below enforces
       this shape, not just documents it.
     - No conversation is ever persisted server-side. `history` is
       supplied by the client on every request (retail-chat.js
       holds it in memory only) and never written to any store.

   ENV VARS (identical to the other three AI endpoints):
     GEMINI_API_KEY   required
     GEMINI_MODEL     optional, default gemini-2.5-flash-lite
     FIREBASE_PROJECT optional, default retail-ai-2c674
   ========================================================= */
'use strict';

const crypto = require('crypto');

const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash'
].filter(Boolean);
const PROJECT_ID = process.env.FIREBASE_PROJECT || 'retail-ai-2c674';
const CERT_URL   = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/* ---------- limits ---------- */
const MAX_QUESTION_LEN   = 500;
const MAX_HISTORY_TURNS  = 8;
const MAX_HISTORY_LEN    = 300;
const MAX_CARDS          = 5;     // per Decision Engine category
const MAX_CARD_TITLE_LEN = 60;
const MAX_CARD_TEXT_LEN  = 150;
const MAX_CARD_METRIC_LEN = 40;
const MAX_COVERAGE_TOOLS = 6;
const MAX_LABEL_LEN      = 60;
const MAX_ROLLUP_ITEMS   = 5;
const MAX_TOOLCTX_LABELS = 20;
const MAX_TOOLCTX_LABEL_LEN = 80;
const MAX_BODY_BYTES     = 20 * 1024;   // generous for aggregates, same ceiling class as api/summarize.js — cannot hold row-level data
const PER_USER_HOUR      = 30;          // more generous than one-shot endpoints — natural conversation is multiple messages per session
const PER_USER_DAY       = 150;
const GEMINI_TIMEOUT     = 12000;

/* =========================================================
   1. Egress guard
   ========================================================= */
const DIGIT_RUN_RE = /\d{4,}/;   // same heuristic api/summarize.js and api/retail-knowledge.js's enrich-items already use

function checkFreeText(v, field, maxLen) {
  if (typeof v !== 'string') throw new Error(field + ' must be a string');
  if (v.length > maxLen) throw new Error(field + ' too long');
  return v;
}
/* Unlike checkFreeText, this is for fields that originate from
   RETAILER data (even aggregated) rather than the user's own
   words — those get the digit-run guard too. */
function checkLabel(v, field, maxLen) {
  checkFreeText(v, field, maxLen);
  if (DIGIT_RUN_RE.test(v)) throw new Error('EGRESS GUARD: ' + field + ' looks like raw data (long digit run)');
  return v;
}
function checkNum01(v, field) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1) throw new Error(field + ' must be a number 0-1');
  return v;
}
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
   never the raw per-item enrichItems() output. This is enforced
   by shape, not just by convention: there is no field here an
   individual item's style code, barcode, or description could
   travel through. */
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
   2. Firebase ID token verification — identical to the other
   three AI endpoints.
   ========================================================= */
let certCache = { keys: null, expires: 0 };

async function googleCerts() {
  const now = Date.now();
  if (certCache.keys && now < certCache.expires) return certCache.keys;
  const res = await fetch(CERT_URL);
  if (!res.ok) throw new Error('cert fetch failed');
  const keys = await res.json();
  const cc = res.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  certCache = { keys, expires: now + (m ? +m[1] * 1000 : 3600000) };
  return keys;
}

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function verifyIdToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const header  = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));

  if (header.alg !== 'RS256') throw new Error('bad alg');
  if (!header.kid)            throw new Error('no kid');

  const certs = await googleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('unknown kid');

  const pubKey = new crypto.X509Certificate(pem).publicKey;
  const ok = crypto.createVerify('RSA-SHA256')
    .update(parts[0] + '.' + parts[1])
    .verify(pubKey, b64urlToBuf(parts[2]));
  if (!ok) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error('bad aud');
  if (payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) throw new Error('bad iss');
  if (!payload.sub) throw new Error('no sub');
  if (payload.exp <= now) throw new Error('expired');
  if (payload.iat > now + 300) throw new Error('issued in future');

  return payload.sub;
}

/* =========================================================
   3. Rate limit — own independent bucket, tighter cadence than
   the one-shot endpoints (natural conversation is multiple
   messages per session) but still bounded.
   ========================================================= */
const hits = new Map();

function rateLimited(uid) {
  const now = Date.now();
  const rec = hits.get(uid) || [];
  const fresh = rec.filter(t => now - t < 86400000);
  const lastHour = fresh.filter(t => now - t < 3600000);
  if (lastHour.length >= PER_USER_HOUR) return 'hour';
  if (fresh.length >= PER_USER_DAY)     return 'day';
  fresh.push(now);
  hits.set(uid, fresh);
  if (hits.size > 5000) hits.clear();
  return null;
}

/* =========================================================
   4. Gemini — the "experienced retail business consultant"
   persona lives entirely in this prompt. No other endpoint in
   this app free-answers in natural language; every other one
   returns a fixed JSON shape it fills in. This one still asks
   for JSON ({"answer":"..."}) for parsing safety, but the VALUE
   is prose, not structured data.
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

async function callGeminiCascade(prompt) {
  let lastErr;
  for (const m of MODEL_CANDIDATES) {
    try {
      return { ai: await callGemini(prompt, m), model: m };
    } catch (e) {
      lastErr = e;
      if (e.status !== 404) throw e;
    }
  }
  throw lastErr;
}

async function callGemini(prompt, model) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(model) + ':generateContent';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 500,
          responseMimeType: 'application/json'
        }
      })
    });

    const text = await res.text();
    if (!res.ok) {
      const err = new Error('gemini_' + res.status);
      err.status = res.status;
      err.quota = res.status === 429;
      err.detail = String(text || '').slice(0, 180);
      throw err;
    }
    const data = JSON.parse(text);
    const out = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const raw = out.map(p => p.text || '').join('').trim();
    if (!raw) throw new Error('empty_response');
    return JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ''));
  } finally {
    clearTimeout(timer);
  }
}

/* Never trust the model's output shape. */
function sanitise(ai) {
  const answer = typeof (ai && ai.answer) === 'string' ? ai.answer.trim().slice(0, 2000) : '';
  return { answer };
}

/* =========================================================
   5. Handler
   ========================================================= */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-RA-Version', '1');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('[api/chat] GEMINI_API_KEY is not set in this environment — AI requests cannot be served.');
    return res.status(503).json({ error: 'ai_not_configured' });
  }

  let uid;
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new Error('no bearer');
    uid = await verifyIdToken(h.slice(7));
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const limited = rateLimited(uid);
  if (limited) {
    return res.status(429).json({ error: 'rate_limited', window: limited });
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
      console.error('EGRESS GUARD TRIPPED on /api/chat — blocked. ' + e.message);
      return res.status(500).json({ error: 'egress_guard' });
    }
    return res.status(400).json({ error: 'bad_request', detail: e.message });
  }

  try {
    const got = await callGeminiCascade(buildPrompt(input));
    const clean = sanitise(got.ai);
    if (!clean.answer) throw new Error('empty_answer');
    console.log(JSON.stringify({ evt: 'chat', ok: true, model: got.model, qLen: input.question.length, aLen: clean.answer.length }));
    return res.status(200).json({ ...clean, model: got.model, source: 'ai' });
  } catch (e) {
    console.log(JSON.stringify({ evt: 'chat', ok: false, code: e.message, detail: String(e.detail || '').slice(0, 180) }));
    return res.status(503).json({
      error: e.quota ? 'ai_quota' : 'ai_unavailable',
      code: String(e.message || '').slice(0, 60),
      detail: String(e.detail || '').slice(0, 180)
    });
  }
};

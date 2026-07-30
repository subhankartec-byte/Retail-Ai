/* =========================================================
   api/_lib/ai-core.js — Retail AI · shared AI service core
   ---------------------------------------------------------
   Universal AI Pipeline, backend layer. Every api/*.js AI
   endpoint (map-schema, summarize, chat, retail-knowledge)
   requires this module instead of re-implementing its own
   Firebase verification, rate limiter, Gemini caller, and
   egress-guard primitives — those four things were previously
   copy-pasted, byte-for-byte identical, across all four files.

   This module intentionally does NOT own request validation,
   prompt text, or response sanitisation — those stay in each
   endpoint file, because they are genuinely task-specific and
   forcing them into one shape would hide real differences
   (e.g. api/chat.js's free-text answer vs. api/map-schema.js's
   fixed field-mapping JSON). What's shared here is exactly the
   part that was ALREADY byte-for-byte identical: transport,
   auth, quota, and the Gemini call itself.

   ZERO npm dependencies, same as every file that uses it.
   Vercel excludes any `_`-prefixed path from routing, so this
   file is never itself deployed as an endpoint.

   ENV VARS (read once per cold start, same across all callers):
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
const GEMINI_TIMEOUT_DEFAULT = 10000;

/* =========================================================
   1. Firebase ID token verification — no firebase-admin.
   Identical to what every one of the four endpoints already
   had; moved here unchanged.
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

/* requireAuth(req) -> uid, or throws a plain Error the caller
   turns into a 401. Kept as a thin wrapper (not baked into a
   full "handle the response" helper) because a couple of
   callers need the uid before deciding which rate-limit bucket
   applies (task-dependent limits). */
async function requireAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new Error('no bearer');
  return verifyIdToken(h.slice(7));
}

/* =========================================================
   2. Rate limiting — same in-memory, per-warm-instance
   algorithm every endpoint already used, now a factory instead
   of four copies. Each caller makes its OWN limiter instance
   with its OWN thresholds, so per-endpoint quotas (e.g. chat's
   more generous 30/hr vs the one-shot endpoints' 20/hr) are
   preserved exactly as they were — this is not a shared bucket
   across endpoints, each endpoint keeps its independent quota.
   ========================================================= */
function makeRateLimiter(perHour, perDay) {
  const hits = new Map();
  return function rateLimited(uid) {
    const now = Date.now();
    const rec = hits.get(uid) || [];
    const fresh = rec.filter(t => now - t < 86400000);
    const lastHour = fresh.filter(t => now - t < 3600000);
    if (lastHour.length >= perHour) return 'hour';
    if (fresh.length >= perDay)     return 'day';
    fresh.push(now);
    hits.set(uid, fresh);
    if (hits.size > 5000) hits.clear();   // crude memory bound, same as before
    return null;
  };
}

/* =========================================================
   3. Gemini — model cascade + single-call transport. Prompt
   text and response parsing/sanitising stay 100% with each
   endpoint; this only owns "send this prompt string, get JSON
   back or throw a normalised error".
   ========================================================= */
async function callGemini(prompt, model, opts) {
  opts = opts || {};
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(model) + ':generateContent';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || GEMINI_TIMEOUT_DEFAULT);

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
          temperature: opts.temperature != null ? opts.temperature : 0,
          maxOutputTokens: opts.maxOutputTokens || 700,
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

/* callGeminiCascade(prompt, opts) -> { ai, model }
   Tries each candidate model in order; only a 404 (model not
   found/renamed) falls through to the next one — any other
   failure (quota, timeout, bad response) is real and should
   surface immediately rather than burn through the whole
   cascade. Identical semantics to what all four endpoints had. */
async function callGeminiCascade(prompt, opts) {
  let lastErr;
  for (const m of MODEL_CANDIDATES) {
    try {
      return { ai: await callGemini(prompt, m, opts), model: m };
    } catch (e) {
      lastErr = e;
      if (e.status !== 404) throw e;
    }
  }
  throw lastErr;
}

/* =========================================================
   4. Egress-guard primitives shared by every endpoint's own
   task-specific validateBody(). The SHAPE each endpoint accepts
   is still defined locally (that's real, task-specific business
   logic) — only these small, previously-duplicated checks move
   here.
   ========================================================= */
const DIGIT_RUN_RE_4 = /\d{4,}/;   // api/summarize.js's/api/chat.js's/enrich-items' heuristic
const DIGIT_RUN_RE_6 = /\d{6,}/;   // api/summarize.js's own group-list heuristic (looser threshold)
const MASKED_RE = /^[#Aa\s.,\-\/()&+_:*'"|\[\]]*$/;   // shape-masked value contract (# digit, A upper, a lower)

function checkLabel(v, field, maxLen, digitRunRe) {
  if (typeof v !== 'string') throw new Error('EGRESS GUARD: ' + field + ' must be a string');
  if (v.length > maxLen) throw new Error('EGRESS GUARD: ' + field + ' too long');
  if ((digitRunRe || DIGIT_RUN_RE_4).test(v)) throw new Error('EGRESS GUARD: ' + field + ' looks like raw data (long digit run)');
  return v;
}
function checkNum(v, field) {
  if (typeof v !== 'number' || !isFinite(v)) throw new Error('EGRESS GUARD: ' + field + ' must be a finite number');
  return v;
}
function checkNum01(v, field) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1) throw new Error(field + ' must be a number 0-1');
  return v;
}
/* Shape-masked value check (headers/samples style: # / A / a only,
   never a raw digit). Used by map-schema/retail-knowledge's Tier 1
   sample masking. */
function assertMaskedValue(v, field) {
  if (typeof v !== 'string') throw new Error((field || 'value') + ' must be a string');
  if (/[0-9]/.test(v)) throw new Error('EGRESS GUARD: unmasked digit in ' + (field || 'value'));
  if (!MASKED_RE.test(v)) throw new Error('EGRESS GUARD: unmasked characters in ' + (field || 'value'));
  return v;
}

/* =========================================================
   5. Response helpers — the repeated "GEMINI_API_KEY missing /
   auth failed / rate limited / egress guard tripped / gemini
   call failed" response shapes, previously written out by hand
   in every handler.
   ========================================================= */
function notConfigured(res, tag) {
  console.error('[' + tag + '] GEMINI_API_KEY is not set in this environment — AI requests cannot be served.');
  return res.status(503).json({ error: 'ai_not_configured' });
}
function unauthorized(res) {
  return res.status(401).json({ error: 'unauthorized' });
}
function rateLimitedResponse(res, window) {
  return res.status(429).json({ error: 'rate_limited', window });
}
function egressGuardTripped(res, tag, message) {
  console.error('EGRESS GUARD TRIPPED on ' + tag + ' — blocked. ' + message);
  return res.status(500).json({ error: 'egress_guard' });
}
function badRequest(res, detail) {
  return res.status(400).json({ error: 'bad_request', detail });
}
function geminiFailure(res, e) {
  return res.status(503).json({
    error: e.quota ? 'ai_quota' : 'ai_unavailable',
    code: String(e.message || '').slice(0, 60),
    detail: String(e.detail || '').slice(0, 180)
  });
}

module.exports = {
  MODEL_CANDIDATES, PROJECT_ID,
  verifyIdToken, requireAuth,
  makeRateLimiter,
  callGemini, callGeminiCascade,
  DIGIT_RUN_RE_4, DIGIT_RUN_RE_6, MASKED_RE,
  checkLabel, checkNum, checkNum01, assertMaskedValue,
  notConfigured, unauthorized, rateLimitedResponse, egressGuardTripped, badRequest, geminiFailure
};

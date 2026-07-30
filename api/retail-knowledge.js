/* =========================================================
   api/retail-knowledge.js — Retail AI · Retail Knowledge
   Intelligence endpoint (Phase 7, AI Intelligence Core)
   ---------------------------------------------------------
   Vercel serverless function. ZERO npm dependencies. Same
   security skeleton as api/map-schema.js / api/summarize.js
   (Firebase ID token verification, no firebase-admin, per-user
   in-memory rate limit, Gemini model cascade, fail-closed egress
   guard) — copied and adapted deliberately, not re-invented, so
   this endpoint is auditable against already-reviewed code.

   Step C (LOCKED, 2026-07-29) implements task:'detect-retailer' —
   the AI fallback tier of Decision 1 (AI-Assisted Retailer
   Detection), called by retail-knowledge.js (client) only when
   retail-intelligence.js's deterministic rule tier can't reach
   high confidence on its own. Its request/prompt/sanitise
   functions below are unmodified since Step C — Step D only adds
   new, separate functions alongside them, never edits them.

   Step D (this addition) implements task:'enrich-items' — Retail
   Knowledge Intelligence's item-level reasoning (Decision 2):
   given a deduplicated batch of distinct items, infer brand /
   category / gender / product family / pricing tier by reasoning
   JOINTLY over every available field at once (style-code shape +
   real product description + masked price shape + already-known
   colour/size/brand), never one field in isolation. Every field
   is independently confidence-gated; below threshold it's omitted
   entirely, never a forced guess — same discipline as Step C's
   retailer detection.

   AI DATA POLICY (PROJECT_STATUS.md §3.7) — TWO tiers on this one
   endpoint, one per task:
     task:'detect-retailer' — Tier 1 (structural metadata) only:
       column HEADER NAMES, masked value SHAPES ("####.##", "A###"),
       a short list of CANDIDATE retailer keys, an optional
       ruleHint. Never a row, barcode, price, or per-style sample.
     task:'enrich-items' — Tier 2 (deduplicated, capped item
       subset), the first use of this tier in the app:
         - a masked STYLE-CODE SHAPE (never the real code)
         - the item's real PRODUCT DESCRIPTION, sent as text, NOT
           shape-masked — deliberately, see the design note in
           validateEnrichItemsBody() below for why, and what
           safety net replaces masking for this one field
         - a masked PRICE SHAPE (never the real price)
         - already-known colour/size/brand as short plain labels
           (same sensitivity as a department or staff name, which
           api/summarize.js already sends unmasked today)
       Deduplicated to one entry per distinct style (never a full
       row list), hard-capped batch size, never a barcode/EAN,
       never anything tied to an individual transaction or
       customer.
   Masking happens in the browser (retail-assist.js's maskValue(),
   reused via buildSamples() for task:'detect-retailer'; a
   dedicated helper in retail-knowledge.js for task:'enrich-items').
   The guards below re-check server-side and fail closed for both.

   ENV VARS (identical to the other two AI endpoints):
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
const MAX_HEADERS       = 200;
const MAX_HEADER_LEN    = 100;
const MAX_SAMPLES       = 5;
const MAX_CANDIDATES    = 20;
const MAX_CANDIDATE_LEN = 40;
const MAX_BODY_BYTES    = 8 * 1024;      // task:'detect-retailer' ceiling — same as api/map-schema.js, Tier 1 only
const PER_USER_HOUR     = 20;
const PER_USER_DAY      = 100;
const GEMINI_TIMEOUT    = 10000;

/* task:'enrich-items' (Phase D) limits. A larger body ceiling than
   Tier 1's — Tier 2 legitimately carries real description text,
   not just header shapes — but still tightly bounded by both a
   per-item count cap and a hard byte ceiling together. */
const MAX_ITEMS           = 40;
const MAX_ITEM_KEY_LEN    = 40;
const MAX_ITEM_CODE_LEN   = 40;   // styleCode / priceShape (masked shapes)
const MAX_ITEM_DESC_LEN   = 80;   // real description text
const MAX_ITEM_LABEL_LEN  = 30;   // colour / size / knownBrand
const MAX_ENRICH_BODY_BYTES = 16 * 1024;
const DIGIT_RUN_RE = /\d{4,}/;    // same long-digit-run heuristic api/summarize.js already uses for Tier 0 labels

/* =========================================================
   1. Egress guard — identical masking contract to
   api/map-schema.js's assertMasked(), plus a candidates/ruleHint
   check specific to this task.
   ========================================================= */
const MASKED_RE = /^[#Aa\s.,\-\/()&+_:*'"|\[\]]*$/;

function assertMasked(samples) {
  if (!Array.isArray(samples)) throw new Error('samples must be an array');
  if (samples.length > MAX_SAMPLES) throw new Error('too many samples');
  for (const row of samples) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('sample row must be an object');
    }
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (typeof v !== 'string') throw new Error('sample value must be a string');
      if (v.length > 40)         throw new Error('sample value too long');
      if (/[0-9]/.test(v))       throw new Error('EGRESS GUARD: unmasked digit in sample');
      if (!MASKED_RE.test(v))    throw new Error('EGRESS GUARD: unmasked characters in sample');
    }
  }
}

function validateDetectRetailerBody(body) {
  const allowed = ['task', 'headers', 'samples', 'candidates', 'ruleHint', 'filename', 'sheetName'];
  for (const k of Object.keys(body || {})) {
    if (!allowed.includes(k)) throw new Error('unexpected field: ' + k);
  }
  if (body.task !== 'detect-retailer') throw new Error('unexpected task');

  const headers = body.headers;
  if (!Array.isArray(headers) || headers.length === 0) throw new Error('headers required');
  if (headers.length > MAX_HEADERS) throw new Error('too many headers');
  for (const h of headers) {
    if (typeof h !== 'string') throw new Error('header must be a string');
    if (h.length > MAX_HEADER_LEN) throw new Error('header too long');
  }
  assertMasked(body.samples || []);

  const candidates = body.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('candidates required');
  if (candidates.length > MAX_CANDIDATES) throw new Error('too many candidates');
  for (const c of candidates) {
    if (typeof c !== 'string' || !c.length || c.length > MAX_CANDIDATE_LEN || !/^[A-Za-z0-9_-]+$/.test(c)) {
      throw new Error('EGRESS GUARD: bad candidate value');
    }
  }

  let ruleHint = null;
  if (body.ruleHint !== undefined && body.ruleHint !== null) {
    const rh = body.ruleHint;
    if (typeof rh !== 'object' || Array.isArray(rh)) throw new Error('bad ruleHint');
    if (rh.retailer !== undefined && rh.retailer !== null) {
      if (typeof rh.retailer !== 'string' || !candidates.includes(rh.retailer)) throw new Error('bad ruleHint.retailer');
    }
    if (rh.confidence !== undefined && rh.confidence !== null) {
      if (typeof rh.confidence !== 'number' || !isFinite(rh.confidence) || rh.confidence < 0 || rh.confidence > 1) {
        throw new Error('bad ruleHint.confidence');
      }
    }
    ruleHint = { retailer: rh.retailer || null, confidence: typeof rh.confidence === 'number' ? rh.confidence : null };
  }

  return {
    headers,
    samples: body.samples || [],
    candidates,
    ruleHint,
    filename: typeof body.filename === 'string' ? body.filename.slice(0, 120) : '',
    sheetName: typeof body.sheetName === 'string' ? body.sheetName.slice(0, 60) : ''
  };
}

/* =========================================================
   1b. Egress guard — task:'enrich-items' (Phase D)
   ---------------------------------------------------------
   DESIGN NOTE — why descriptions are NOT shape-masked here:
   Tier 1's mask (digit->#, upper->A, lower->a) is built for
   STRUCTURAL classification, where only a value's shape carries
   signal (e.g. is this column a price or a barcode). A product
   description's entire value to this task is its WORDS ("Floral
   Maxi Dress") — shape-masking it would destroy exactly the
   signal this task needs, while contributing no privacy benefit
   AI Data Policy actually cares about: a description is product
   CATALOG text (the same words a retailer already publishes on
   its own storefront), not a barcode, not a price, not tied to
   any one transaction or customer. It is deliberately treated as
   Tier 2's one exception to shape-masking, with a different,
   more appropriate safety net instead: a hard length cap, and
   DIGIT_RUN_RE rejection of anything containing a 4+ digit run —
   the same heuristic api/summarize.js already uses to catch a
   barcode/phone/EAN that shouldn't be there. styleCode and
   priceShape are NOT descriptions — they carry no semantic text
   value, so they stay Tier-1-style shape-masked, same as always.
   ========================================================= */
function assertNoDigitRun(s, field) {
  if (DIGIT_RUN_RE.test(s)) throw new Error('EGRESS GUARD: ' + field + ' looks like raw data (long digit run)');
}
function assertMaskedShape(s, field) {
  if (/[0-9]/.test(s)) throw new Error('EGRESS GUARD: unmasked digit in ' + field);
  if (!MASKED_RE.test(s)) throw new Error('EGRESS GUARD: unmasked characters in ' + field);
}

function validateEnrichItemsBody(body) {
  const allowed = ['task', 'items'];
  for (const k of Object.keys(body || {})) {
    if (!allowed.includes(k)) throw new Error('unexpected field: ' + k);
  }
  if (body.task !== 'enrich-items') throw new Error('unexpected task');

  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) throw new Error('items required');
  if (items.length > MAX_ITEMS) throw new Error('too many items');

  const seenKeys = new Set();
  const clean = items.map((it) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error('item must be an object');
    const itemAllowed = ['key', 'styleCode', 'description', 'priceShape', 'colour', 'size', 'knownBrand'];
    for (const k of Object.keys(it)) {
      if (!itemAllowed.includes(k)) throw new Error('unexpected item field: ' + k);
    }

    if (typeof it.key !== 'string' || !it.key || it.key.length > MAX_ITEM_KEY_LEN || !/^[A-Za-z0-9_-]+$/.test(it.key)) {
      throw new Error('EGRESS GUARD: bad item key');
    }
    if (seenKeys.has(it.key)) throw new Error('duplicate item key');
    seenKeys.add(it.key);

    const styleCode = typeof it.styleCode === 'string' ? it.styleCode : '';
    if (styleCode.length > MAX_ITEM_CODE_LEN) throw new Error('styleCode too long');
    if (styleCode) assertMaskedShape(styleCode, 'styleCode');

    const description = typeof it.description === 'string' ? it.description : '';
    if (description.length > MAX_ITEM_DESC_LEN) throw new Error('description too long');
    if (description) assertNoDigitRun(description, 'description');

    const priceShape = typeof it.priceShape === 'string' ? it.priceShape : '';
    if (priceShape.length > MAX_ITEM_CODE_LEN) throw new Error('priceShape too long');
    if (priceShape) assertMaskedShape(priceShape, 'priceShape');

    const label = (v, field) => {
      const s = typeof v === 'string' ? v : '';
      if (s.length > MAX_ITEM_LABEL_LEN) throw new Error(field + ' too long');
      if (s) assertNoDigitRun(s, field);
      return s;
    };
    const colour = label(it.colour, 'colour');
    const size = label(it.size, 'size');
    const knownBrand = label(it.knownBrand, 'knownBrand');

    return { key: it.key, styleCode, description, priceShape, colour, size, knownBrand };
  });

  return { items: clean };
}

/* =========================================================
   2. Firebase ID token verification — identical to the other
   two AI endpoints (no firebase-admin, RS256 against Google's
   public certs).
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
   3. Rate limit — own independent bucket, same shape as the
   other two endpoints (each AI endpoint in this repo has always
   had its own in-memory limiter, not a shared one).
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
   4. Gemini — task:'detect-retailer' (unchanged since Step C)
   ---------------------------------------------------------
   Candidate retailer keys come from the REQUEST (ultimately
   RetailProfiles.PROFILES client-side), not hardcoded here —
   adding a future retailer needs no change to this file, only a
   longer candidates list from the caller. This is the concrete
   payoff of Phase B's signature-registry generalisation carried
   through to the AI tier.
   ========================================================= */
function buildPrompt(input) {
  return [
    'You identify which retailer a masked retail data file most likely belongs to,',
    'for an Indian fashion-retail operation.',
    '',
    'You are given ONLY column names and masked value shapes.',
    'In the shapes: # = a digit, A = an uppercase letter, a = a lowercase letter.',
    'You will never see real data.',
    '',
    'Candidate retailers — choose exactly one key from this list, or "unknown" if',
    'none fit confidently:',
    input.candidates.map(c => '  ' + c).join('\n'),
    '',
    input.ruleHint && input.ruleHint.retailer
      ? ('A separate deterministic, rule-based check weakly suggests "' + input.ruleHint.retailer +
         '" (confidence ' + input.ruleHint.confidence + '). You may agree, disagree, or say "unknown" — ' +
         'use your own judgement from the columns and shapes below, this is only a hint.')
      : 'No rule-based hint is available for this file.',
    '',
    'File: ' + (input.filename || '(unknown)'),
    'Sheet: ' + (input.sheetName || '(unknown)'),
    '',
    'Columns (index | header | masked shapes):',
    input.headers.map((h, i) => {
      const shapes = input.samples
        .map(s => s[String(i)])
        .filter(Boolean)
        .slice(0, 3)
        .join(' , ');
      return '  ' + i + ' | ' + (h || '(blank)') + ' | ' + (shapes || '(empty)');
    }).join('\n'),
    '',
    'Respond with JSON only, no markdown, no commentary:',
    '{"retailer":"<one of the candidate keys, or unknown>","confidence":0.0}'
  ].join('\n');
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
          temperature: 0,
          maxOutputTokens: 300,
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

/* Never trust the model's output shape. retailer must be one of the
   exact candidates the caller sent (or "unknown") — never anything
   the model invented. "unknown" is never reported as high
   confidence, since there is nothing to be confident about. */
function sanitise(ai, candidates) {
  let retailer = String((ai && ai.retailer) || 'unknown');
  if (retailer !== 'unknown' && !candidates.includes(retailer)) retailer = 'unknown';

  let confidence = Number(ai && ai.confidence);
  if (!isFinite(confidence) || confidence < 0 || confidence > 1) confidence = 0.5;
  if (retailer === 'unknown') confidence = Math.min(confidence, 0.5);

  return { retailer: retailer === 'unknown' ? null : retailer, confidence };
}

/* =========================================================
   4b. Gemini — task:'enrich-items' (Phase D)
   ---------------------------------------------------------
   One prompt reasons about the WHOLE deduplicated batch at once,
   and for each item reasons JOINTLY over every field given for
   that item (Decision 2) rather than inferring one field from one
   source — the model is explicitly told to use all of them
   together, not pick a single strongest signal.
   ========================================================= */
const ENRICH_TARGET_FIELDS = ['brand', 'category', 'gender', 'productFamily', 'pricingTier'];

function buildEnrichPrompt(input) {
  return [
    'You are a retail merchandising expert for an Indian fashion-retail operation.',
    'For each item below, infer these fields by reasoning JOINTLY over every field',
    'given for that item together (style-code shape, description, price shape,',
    'colour, size, known brand) — never from a single field in isolation:',
    '',
    '  brand         - the brand/label this item most likely belongs to',
    '  category      - product category (e.g. Dress, Shirt, Trousers, Saree, Footwear, Accessory)',
    '  gender        - Men | Women | Kids | Unisex',
    '  productFamily - a short product family/style descriptor (e.g. "Maxi Dress", "Slim Fit Shirt")',
    '  pricingTier   - Value | Mid | Premium (relative price positioning)',
    '',
    'styleCode and priceShape are MASKED SHAPES ONLY (# = digit, A = uppercase,',
    'a = lowercase letter) — you will never see the real code or price, only its',
    'shape and rough magnitude. description IS the real product-catalog text.',
    'colour / size / knownBrand, where present, are already-known plain labels —',
    'use them as corroborating context, not a data-mapping target.',
    '',
    'If a field cannot be confidently inferred for an item, OMIT that field',
    'entirely for that item rather than guessing. confidence is 0.0-1.0, your',
    'honest certainty for that one field.',
    '',
    'Items (key | styleCode shape | description | price shape | colour | size | known brand):',
    input.items.map((it) => [
      it.key, it.styleCode || '(none)', it.description || '(none)', it.priceShape || '(none)',
      it.colour || '(none)', it.size || '(none)', it.knownBrand || '(none)'
    ].join(' | ')).join('\n'),
    '',
    'Respond with JSON only, no markdown, no commentary — one entry per item key,',
    'omitting any field (and its *Confidence) you are not confident about:',
    '{"items":[{"key":"<key>","brand":"...","brandConfidence":0.0,"category":"...","categoryConfidence":0.0,' +
      '"gender":"...","genderConfidence":0.0,"productFamily":"...","productFamilyConfidence":0.0,' +
      '"pricingTier":"...","pricingTierConfidence":0.0}]}'
  ].join('\n');
}

/* Never trust the model's output shape or invented keys. Only
   items whose key was actually in the request survive; only the
   five known target fields (+ their *Confidence) are read off
   each; string fields are length-capped the same as the request
   side; confidences are clamped 0-1 and a field without a valid
   confidence is dropped entirely rather than assumed. */
function sanitiseEnrich(ai, validKeys) {
  const validSet = new Set(validKeys);
  const rawItems = Array.isArray(ai && ai.items) ? ai.items : [];
  const items = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const key = String(raw.key || '');
    if (!validSet.has(key)) continue;

    const out = { key };
    for (const f of ENRICH_TARGET_FIELDS) {
      const v = raw[f];
      const cf = raw[f + 'Confidence'];
      if (typeof v !== 'string' || !v.trim()) continue;
      let confidence = Number(cf);
      if (!isFinite(confidence) || confidence < 0 || confidence > 1) continue;   // no valid confidence -> drop the field, never assume one
      out[f] = v.trim().slice(0, 40);
      out[f + 'Confidence'] = confidence;
    }
    items.push(out);
  }
  return { items };
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
    console.error('[api/retail-knowledge] GEMINI_API_KEY is not set in this environment — AI requests cannot be served.');
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

  /* Peek at task before choosing which validator/byte-ceiling
     applies — task:'enrich-items' (Phase D) gets the larger Tier 2
     ceiling; everything else (including no task at all, which is
     invalid here — this endpoint, unlike api/map-schema.js, has no
     legacy default task to preserve) uses task:'detect-retailer's
     original Tier 1 ceiling, unchanged since Step C. */
  let earlyTask;
  try {
    const peek = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    earlyTask = peek && peek.task;
  } catch (e) {
    earlyTask = undefined;
  }
  const isEnrich = earlyTask === 'enrich-items';
  const byteCeiling = isEnrich ? MAX_ENRICH_BODY_BYTES : MAX_BODY_BYTES;

  let input;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (Buffer.byteLength(JSON.stringify(body)) > byteCeiling) {
      throw new Error('payload too large');
    }
    input = isEnrich ? validateEnrichItemsBody(body) : validateDetectRetailerBody(body);
  } catch (e) {
    if (String(e.message).startsWith('EGRESS GUARD')) {
      console.error('EGRESS GUARD TRIPPED on /api/retail-knowledge — blocked. ' + e.message);
      return res.status(500).json({ error: 'egress_guard' });
    }
    return res.status(400).json({ error: 'bad_request', detail: e.message });
  }

  if (isEnrich) {
    try {
      const got = await callGeminiCascade(buildEnrichPrompt(input));
      const clean = sanitiseEnrich(got.ai, input.items.map(it => it.key));
      console.log(JSON.stringify({
        evt: 'enrich-items', ok: true, model: got.model,
        requested: input.items.length, returned: clean.items.length
      }));
      return res.status(200).json({ ...clean, model: got.model, source: 'ai' });
    } catch (e) {
      console.log(JSON.stringify({
        evt: 'enrich-items', ok: false, code: e.message,
        detail: String(e.detail || '').slice(0, 180)
      }));
      return res.status(503).json({
        error: e.quota ? 'ai_quota' : 'ai_unavailable',
        code: String(e.message || '').slice(0, 60),
        detail: String(e.detail || '').slice(0, 180)
      });
    }
  }

  try {
    const got = await callGeminiCascade(buildPrompt(input));
    const clean = sanitise(got.ai, input.candidates);
    console.log(JSON.stringify({
      evt: 'detect-retailer', ok: true, model: got.model,
      retailer: clean.retailer, conf: clean.confidence
    }));
    return res.status(200).json({ ...clean, model: got.model, source: 'ai' });
  } catch (e) {
    console.log(JSON.stringify({
      evt: 'detect-retailer', ok: false, code: e.message,
      detail: String(e.detail || '').slice(0, 180)
    }));
    return res.status(503).json({
      error: e.quota ? 'ai_quota' : 'ai_unavailable',
      code: String(e.message || '').slice(0, 60),
      detail: String(e.detail || '').slice(0, 180)
    });
  }
};

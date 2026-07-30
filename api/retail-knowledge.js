/* =========================================================
   api/retail-knowledge.js — Retail AI · Retail Knowledge
   Intelligence endpoint (Universal AI Pipeline, Stage 3/4 —
   Retail Intelligence)
   ---------------------------------------------------------
   Vercel serverless function. Auth, rate limiting and the
   Gemini call itself now live in ./_lib/ai-core.js (shared by
   every AI endpoint) — this file keeps only what's genuinely
   specific to its two tasks: request shape, egress guards,
   prompts, and response sanitisers.

   task:'detect-retailer' implements the AI fallback tier of
   the Brand Detection Engine (Layers 1-2 are deterministic —
   retail-intelligence.js — and only reach this endpoint when
   they're not already high-confidence). Candidate retailer keys
   come from the REQUEST (ultimately RetailProfiles.PROFILES
   client-side), never hardcoded here — adding a future retailer
   needs no change to this file.

   OPEN-VOCABULARY DETECTION (Universal AI Pipeline requirement):
   the model is no longer hard-blocked from ever naming a brand
   outside the candidate list. When it recognises a retailer that
   ISN'T already registered, that comes back as a distinctly
   typed, capped-confidence `suggestedName` — never silently
   promoted to `retailer` (which stays reserved for an exact,
   already-registered candidate match). Callers must never treat
   an unregistered suggestion as a confirmed identification; it
   exists to surface "add this retailer" opportunities to a
   human via the existing manual-confirm UI, not to auto-apply
   branding/behaviour for a retailer nobody has vetted.

   task:'enrich-items' implements item-level reasoning (brand /
   category / gender / product family / pricing tier), unchanged
   from before this refactor.

   AI DATA POLICY — TWO tiers on this one endpoint, one per task:
     task:'detect-retailer' — Tier 1 (structural metadata) only:
       column HEADER NAMES, masked value SHAPES, a short list of
       CANDIDATE retailer keys, an optional ruleHint, and now
       optional CONTENT LABELS — short, already-categorical
       values (e.g. distinct Department/Category/Division/World
       column values actually seen in the file, deduplicated and
       capped) sent as plain labels, the same sensitivity class
       api/summarize.js already sends unmasked today (a
       department name, not a row). Still never a row, barcode,
       price, per-style sample, or free-text product description.
     task:'enrich-items' — Tier 2, unchanged: deduplicated item
       subset, real product descriptions (not shape-masked, see
       the design note below), masked style/price shapes.
   Masking happens in the BROWSER. The guards below re-check
   server-side and fail closed for both.

   ENV VARS (identical to the other three AI endpoints):
     GEMINI_API_KEY   required
     GEMINI_MODEL     optional, default gemini-2.5-flash-lite
     FIREBASE_PROJECT optional, default retail-ai-2c674
   ========================================================= */
'use strict';

const core = require('./_lib/ai-core');

/* ---------- limits (unchanged) ---------- */
const MAX_HEADERS       = 200;
const MAX_HEADER_LEN    = 100;
const MAX_SAMPLES       = 5;
const MAX_CANDIDATES    = 20;
const MAX_CANDIDATE_LEN = 40;
const MAX_BODY_BYTES    = 8 * 1024;
const GEMINI_TIMEOUT    = 10000;

const MAX_ITEMS           = 40;
const MAX_ITEM_KEY_LEN    = 40;
const MAX_ITEM_CODE_LEN   = 40;
const MAX_ITEM_DESC_LEN   = 80;
const MAX_ITEM_LABEL_LEN  = 30;
const MAX_ENRICH_BODY_BYTES = 16 * 1024;

/* Content labels — new for the Universal AI Pipeline's Stage 3
   "content signals" (description/category/department/division),
   folded into the AI tier rather than a separate hand-authored
   keyword layer (see retail-intelligence.js's header comment for
   why). These are already-categorical values, not free text. */
const MAX_CONTENT_LABELS     = 20;
const MAX_CONTENT_LABEL_LEN  = 40;

const rateLimited = core.makeRateLimiter(20, 100);   // unchanged, one bucket for this endpoint (both tasks)

/* =========================================================
   1. Egress guard — task:'detect-retailer'
   ========================================================= */
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
      core.assertMaskedValue(v, 'sample.' + k);
    }
  }
}

function validateContentLabels(labels) {
  if (labels === undefined || labels === null) return [];
  if (!Array.isArray(labels)) throw new Error('contentLabels must be an array');
  if (labels.length > MAX_CONTENT_LABELS) throw new Error('too many contentLabels');
  const seen = new Set();
  const out = [];
  for (const l of labels) {
    const v = core.checkLabel(String(l), 'contentLabels[]', MAX_CONTENT_LABEL_LEN, core.DIGIT_RUN_RE_4);
    if (!v.trim() || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function validateDetectRetailerBody(body) {
  const allowed = ['task', 'headers', 'samples', 'candidates', 'ruleHint', 'filename', 'sheetName', 'contentLabels'];
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
    sheetName: typeof body.sheetName === 'string' ? body.sheetName.slice(0, 60) : '',
    contentLabels: validateContentLabels(body.contentLabels)
  };
}

/* =========================================================
   1b. Egress guard — task:'enrich-items' (unchanged)
   ---------------------------------------------------------
   DESIGN NOTE — why descriptions are NOT shape-masked here:
   Tier 1's mask (digit->#, upper->A, lower->a) is built for
   STRUCTURAL classification, where only a value's shape carries
   signal. A product description's entire value to this task is
   its WORDS — shape-masking it would destroy exactly the signal
   this task needs, while contributing no privacy benefit: a
   description is product CATALOG text, not a barcode, not a
   price, not tied to any one transaction or customer. It is
   deliberately treated as Tier 2's one exception to shape-
   masking, with a different safety net instead: a hard length
   cap, and DIGIT_RUN_RE rejection of anything containing a 4+
   digit run — the same heuristic api/summarize.js uses to catch
   a barcode/phone/EAN that shouldn't be there. styleCode and
   priceShape are NOT descriptions — they carry no semantic text
   value, so they stay Tier-1-style shape-masked, same as always.
   ========================================================= */
function assertMaskedShape(s, field) { core.assertMaskedValue(s, field); }

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
    if (description && core.DIGIT_RUN_RE_4.test(description)) throw new Error('EGRESS GUARD: description looks like raw data (long digit run)');

    const priceShape = typeof it.priceShape === 'string' ? it.priceShape : '';
    if (priceShape.length > MAX_ITEM_CODE_LEN) throw new Error('priceShape too long');
    if (priceShape) assertMaskedShape(priceShape, 'priceShape');

    const label = (v, field) => {
      const s = typeof v === 'string' ? v : '';
      if (s.length > MAX_ITEM_LABEL_LEN) throw new Error(field + ' too long');
      if (s && core.DIGIT_RUN_RE_4.test(s)) throw new Error('EGRESS GUARD: ' + field + ' looks like raw data (long digit run)');
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
   2. Gemini — task:'detect-retailer'
   ========================================================= */
function buildPrompt(input) {
  return [
    'You identify which retailer a masked retail data file most likely belongs to,',
    'for an Indian fashion-retail operation.',
    '',
    'You are given ONLY column names, masked value shapes, and (optionally) a short list',
    'of already-categorical content labels (distinct Department/Category/Division/World',
    'values actually seen in the file). In the shapes: # = a digit, A = an uppercase',
    'letter, a = a lowercase letter. You will never see real row data or product',
    'descriptions in this task.',
    '',
    'Candidate retailers — prefer one of these exact keys if it fits:',
    input.candidates.map(c => '  ' + c).join('\n'),
    '',
    'If NONE of the candidates fit, but the columns/shapes/content labels clearly indicate',
    'a REAL, RECOGNISABLE retailer or brand that is simply not in the candidate list yet,',
    'name it in "suggestedName" (a short, real brand/retailer name) instead of forcing a',
    'candidate match — do not invent a plausible-sounding name with no real evidence. If you',
    'have no confident signal either way, use "unknown".',
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
    'Content labels seen in the file (department/category/division/world values):',
    input.contentLabels.length ? input.contentLabels.map(l => '  - ' + l).join('\n') : '  (none provided)',
    '',
    'Respond with JSON only, no markdown, no commentary. Exactly one of "retailer" or',
    '"suggestedName" should be set (the other null), or both null for "unknown":',
    '{"retailer":"<one of the candidate keys, or null>","suggestedName":"<a real name not in the candidates, or null>","confidence":0.0}'
  ].join('\n');
}

/* Never trust the model's output shape. "retailer" must be one of
   the exact candidates the caller sent — never anything the model
   invented. A non-candidate name the model is confident about
   comes back as a SEPARATE, capped-confidence, distinctly-typed
   "suggestedName" — registered:false — so a caller can never
   mistake an open-vocabulary guess for a confirmed match. */
const SUGGESTED_NAME_RE = /^[A-Za-z0-9 &.'\-]+$/;
const MAX_SUGGESTED_NAME_LEN = 40;

function sanitise(ai, candidates) {
  let retailer = ai && ai.retailer != null ? String(ai.retailer) : null;
  if (retailer && !candidates.includes(retailer)) retailer = null;

  let confidence = Number(ai && ai.confidence);
  if (!isFinite(confidence) || confidence < 0 || confidence > 1) confidence = 0.5;

  if (retailer) {
    return { retailer, suggestedName: null, confidence, registered: true };
  }

  let suggestedName = ai && ai.suggestedName != null ? String(ai.suggestedName).trim() : '';
  if (suggestedName.length > MAX_SUGGESTED_NAME_LEN) suggestedName = suggestedName.slice(0, MAX_SUGGESTED_NAME_LEN);
  if (!suggestedName || !SUGGESTED_NAME_RE.test(suggestedName) || core.DIGIT_RUN_RE_4.test(suggestedName)) {
    suggestedName = '';
  }

  if (!suggestedName) {
    return { retailer: null, suggestedName: null, confidence: Math.min(confidence, 0.5), registered: false };
  }
  /* Open-vocabulary suggestions are hard-capped below what a
     registered match could ever report — nothing downstream can
     mistake "AI thinks this might be X" for "this is X". */
  return { retailer: null, suggestedName, confidence: Math.min(confidence, 0.6), registered: false };
}

/* =========================================================
   2b. Gemini — task:'enrich-items' (unchanged)
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
      if (!isFinite(confidence) || confidence < 0 || confidence > 1) continue;
      out[f] = v.trim().slice(0, 40);
      out[f + 'Confidence'] = confidence;
    }
    items.push(out);
  }
  return { items };
}

/* =========================================================
   3. Handler
   ========================================================= */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-RA-Version', '2');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return core.notConfigured(res, 'api/retail-knowledge');
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
      return core.egressGuardTripped(res, '/api/retail-knowledge', e.message);
    }
    return core.badRequest(res, e.message);
  }

  const geminiOpts = { temperature: 0, maxOutputTokens: 300, timeout: GEMINI_TIMEOUT };

  if (isEnrich) {
    try {
      const got = await core.callGeminiCascade(buildEnrichPrompt(input), geminiOpts);
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
      return core.geminiFailure(res, e);
    }
  }

  try {
    const got = await core.callGeminiCascade(buildPrompt(input), geminiOpts);
    const clean = sanitise(got.ai, input.candidates);
    console.log(JSON.stringify({
      evt: 'detect-retailer', ok: true, model: got.model,
      retailer: clean.retailer, suggested: clean.suggestedName, conf: clean.confidence
    }));
    return res.status(200).json({ ...clean, model: got.model, source: 'ai' });
  } catch (e) {
    console.log(JSON.stringify({
      evt: 'detect-retailer', ok: false, code: e.message,
      detail: String(e.detail || '').slice(0, 180)
    }));
    return core.geminiFailure(res, e);
  }
};

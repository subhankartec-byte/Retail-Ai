/* =========================================================
   api/map-schema.js — Retail AI · AI column-mapping endpoint
   ---------------------------------------------------------
   Vercel serverless function. Runs only when retail-import.js
   cannot confidently read a file. Falls back to the manual
   mapping modal on ANY failure.

   Auth, rate limiting, and the Gemini call itself now live in
   ./_lib/ai-core.js (Universal AI Pipeline core, shared by every
   AI endpoint) — this file keeps only what's genuinely specific
   to column mapping: its request shape, its egress guard, its
   three prompts (map / classify / brands), and its response
   sanitisers. Request/response shapes, status codes, rate
   limits and env vars are all unchanged from before this
   refactor.

   WHAT THIS SENDS TO GOOGLE:
     - column header names        ("Retail Price", "SOH Qty")
     - masked sample shapes       ("####.##", "A###")
   WHAT IT NEVER SENDS:
     - a single row of data, barcode, price, or store value.
   The masking happens in the BROWSER (retail-assist.js).
   assertMasked() below re-checks it server-side and throws.

   ENV VARS (set in Vercel dashboard, never in code):
     GEMINI_API_KEY   required
     GEMINI_MODEL     optional, default gemini-2.5-flash-lite
     FIREBASE_PROJECT optional, default retail-ai-2c674
   ========================================================= */
'use strict';

const core = require('./_lib/ai-core');

/* Fields retail-import.js knows how to use. Must stay in sync. */
const TARGET_FIELDS = [
  'store', 'brand', 'ean', 'style', 'variant', 'size', 'sizeGrid',
  'qty', 'mrp', 'value', 'world', 'desc', 'dept', 'season'
];
const HOUSES = ['w', 'aurelia', 'jaypore', 'unknown'];

/* ---------- limits (unchanged) ---------- */
const MAX_HEADERS      = 200;
const MAX_HEADER_LEN   = 100;
const MAX_SAMPLES      = 5;
const MAX_BODY_BYTES   = 8 * 1024;
const GEMINI_TIMEOUT   = 10000;
const rateLimited = core.makeRateLimiter(20, 100);   // PER_USER_HOUR, PER_USER_DAY — unchanged

/* =========================================================
   1. Egress guard — the privacy promise, as code
   ---------------------------------------------------------
   After masking: digits -> #, A-Z -> A, a-z -> a.
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

function validateBody(body) {
  const allowed = ['headers', 'samples', 'filename', 'sheetName', 'fingerprint', 'task'];
  for (const k of Object.keys(body || {})) {
    if (!allowed.includes(k)) throw new Error('unexpected field: ' + k);
  }
  if (body.task !== undefined && body.task !== 'classify') throw new Error('unexpected task');
  const headers = body.headers;
  if (!Array.isArray(headers) || headers.length === 0) throw new Error('headers required');
  if (headers.length > MAX_HEADERS) throw new Error('too many headers');
  for (const h of headers) {
    if (typeof h !== 'string') throw new Error('header must be a string');
    if (h.length > MAX_HEADER_LEN) throw new Error('header too long');
  }
  assertMasked(body.samples || []);
  return {
    headers,
    samples: body.samples || [],
    filename: typeof body.filename === 'string' ? body.filename.slice(0, 120) : '',
    sheetName: typeof body.sheetName === 'string' ? body.sheetName.slice(0, 60) : '',
    task: body.task === 'classify' ? 'classify' : 'map'
  };
}

/* =========================================================
   2. Gemini — task: map (default)
   ========================================================= */
function buildPrompt(input) {
  return [
    'You map spreadsheet column headers from Indian fashion-retail stock reports',
    '(SAP / SOH exports) onto a fixed internal schema.',
    '',
    'You are given ONLY column names and masked value shapes.',
    'In the shapes: # = a digit, A = an uppercase letter, a = a lowercase letter.',
    'You will never see real data. Infer from the header name and the shape.',
    '',
    'Target fields (map each to the 0-based column index, or omit if absent):',
    '  store    - store / plant / site code            e.g. shape "A###"',
    '  brand    - brand code or name',
    '  ean      - EAN / barcode                        e.g. shape "#############"',
    '  style    - style / article / material code',
    '  variant  - variant code',
    '  size     - size label (S, M, L, XL, FS)         e.g. shape "A" or "AA"',
    '  sizeGrid - size grid code (A54, A32)            e.g. shape "A##"',
    '  qty      - stock on hand quantity               e.g. shape "#"',
    '  mrp      - MRP / retail price / RSP             e.g. shape "####.##"',
    '  value    - stock value / amount',
    '  world    - world / category',
    '  desc     - material or item description',
    '  dept     - department',
    '  season   - season',
    '',
    'Rules:',
    '- NEVER map a blocked-stock column to qty. Prefer unrestricted / SOH qty.',
    '- If two columns look like size, the one with shape "A##" is sizeGrid.',
    '- Brand house: "w" (W / Wishful / Folksong), "aurelia" (AU / Elleven),',
    '  "jaypore" (has World + LOB Desc + Divison, no brand column), else "unknown".',
    '- Omit a field entirely rather than guessing wildly.',
    '- confidence: 0.0-1.0, your honest certainty in the whole mapping.',
    '',
    'File: ' + (input.filename || '(unknown)'),
    'Sheet: ' + (input.sheetName || '(unknown)'),
    '',
    'Columns (index | header | masked shapes):',
    columnDump(input),
    '',
    'Respond with JSON only, no markdown, no commentary:',
    '{"house":"w|aurelia|jaypore|unknown","fields":{"qty":7,"mrp":5},"confidence":0.0}'
  ].join('\n');
}

function columnDump(input) {
  return input.headers.map((h, i) => {
    const shapes = input.samples
      .map(s => s[String(i)])
      .filter(Boolean)
      .slice(0, 3)
      .join(' , ');
    return '  ' + i + ' | ' + (h || '(blank)') + ' | ' + (shapes || '(empty)');
  }).join('\n');
}

/* =========================================================
   2b. Gemini — task: classify (Phase 7 Step C, file-TYPE only)
   ========================================================= */
const FILE_TYPE_VALUES = ['soh', 'sales', 'mb51', 'grn', 'ist', 'storeMaster', 'waybillTemplate', 'unknown'];

function buildClassifyPrompt(input) {
  return [
    'You classify the TYPE of a retail data file (SAP / SOH / POS exports from an',
    'Indian fashion-retail operation) from its column layout alone.',
    '',
    'You are given ONLY column names and masked value shapes.',
    'In the shapes: # = a digit, A = an uppercase letter, a = a lowercase letter.',
    'You will never see real data.',
    '',
    'Classify into exactly one fileType:',
    '  soh             - stock-on-hand / inventory export (style, size, qty, MRP, brand)',
    '  sales           - POS bill-wise sales export (bill number, salesman, quantity, value)',
    '  mb51            - SAP MB51 goods-movement export (supplying plant, movement type, reference)',
    '  grn             - goods-receipt-note report (PO number, from/to location)',
    '  ist             - inter-store-transfer list (donor store, receiver store, style)',
    '  storeMaster     - store directory / master (store code, address, pincode)',
    '  waybillTemplate - a courier waybill template, not a data export at all',
    '  unknown         - none of the above fit confidently; do not force a guess',
    '',
    'File: ' + (input.filename || '(unknown)'),
    'Sheet: ' + (input.sheetName || '(unknown)'),
    '',
    'Columns (index | header | masked shapes):',
    columnDump(input),
    '',
    'Respond with JSON only, no markdown, no commentary:',
    '{"fileType":"soh|sales|mb51|grn|ist|storeMaster|waybillTemplate|unknown","confidence":0.0}'
  ].join('\n');
}

function sanitiseClassify(ai) {
  let fileType = String((ai && ai.fileType) || 'unknown');
  if (!FILE_TYPE_VALUES.includes(fileType)) {
    const hit = FILE_TYPE_VALUES.find(v => v.toLowerCase() === fileType.toLowerCase());
    fileType = hit || 'unknown';
  }
  let confidence = Number(ai && ai.confidence);
  if (!isFinite(confidence) || confidence < 0 || confidence > 1) confidence = 0.5;
  return { fileType, confidence };
}

/* Never trust the model's output shape. */
function sanitise(ai, headerCount) {
  const fields = {};
  const src = (ai && ai.fields) || {};
  for (const f of TARGET_FIELDS) {
    const i = src[f];
    if (Number.isInteger(i) && i >= 0 && i < headerCount) fields[f] = i;
  }
  const used = new Set();
  for (const f of Object.keys(fields)) {           // one column, one field
    if (used.has(fields[f])) delete fields[f];
    else used.add(fields[f]);
  }
  let house = String((ai && ai.house) || 'unknown').toLowerCase();
  if (!HOUSES.includes(house)) house = 'unknown';

  let confidence = Number(ai && ai.confidence);
  if (!isFinite(confidence) || confidence < 0 || confidence > 1) confidence = 0.5;

  return { house: house === 'unknown' ? null : house, fields, confidence };
}

/* =========================================================
   3. Handler
   ========================================================= */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-RA-Version', '3');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return core.notConfigured(res, 'api/map-schema');
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

  /* ---- task: brands ------------------------------------------------
     Classify unknown brand codes into a site family, silently.
     Tokens arrive digit-masked (# = digit); the guard enforces it. */
  {
    let early = null;
    try {
      early = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (e) { early = null; }
    if (early && early.task === 'brands') {
      let toks;
      try {
        if (!Array.isArray(early.brands)) throw new Error('brands_required');
        toks = [...new Set(early.brands.map(x => String(x || '').trim()).filter(Boolean))].slice(0, 15);
        if (!toks.length) throw new Error('brands_required');
        for (const t of toks) {
          if (t.length > 24 || /[0-9]/.test(t) || !/^[A-Za-z#][A-Za-z#&.,'\/\- ]*$/.test(t)) {
            throw new Error('egress_guard_brand');
          }
        }
      } catch (e) {
        return res.status(e.message === 'egress_guard_brand' ? 403 : 400).json({ error: e.message });
      }
      try {
        const prompt =
          'You classify apparel brand codes from an Indian retail stock file into site families:\n' +
          '"w" = W for Woman / W / Wishful / Folksong / W Prive (ladies western and fusion wear)\n' +
          '"aurelia" = Aurelia / Elleven (ladies ethnic wear)\n' +
          '"jaypore" = Jaypore (artisanal apparel, crafts, jewellery)\n' +
          'Use "none" when a code does not clearly belong to any family. "#" stands for a digit.\n' +
          'Reply ONLY with JSON {"routes":{"<code>":"w|aurelia|jaypore|none"}} covering every code.\n' +
          'Codes: ' + JSON.stringify(toks);
        const got = await core.callGeminiCascade(prompt, { temperature: 0, maxOutputTokens: 900, timeout: GEMINI_TIMEOUT });
        const okv = { w: 1, aurelia: 1, jaypore: 1, none: 1 };
        const raw = (got.ai && got.ai.routes) ? got.ai.routes : (got.ai || {});
        const routes = {};
        for (const t of toks) {
          const v = String(raw[t] || 'none').toLowerCase();
          routes[t] = okv[v] ? v : 'none';
        }
        console.log(JSON.stringify({ evt: 'brands', ok: true, model: got.model, n: toks.length }));
        return res.status(200).json({ routes, model: got.model, source: 'ai' });
      } catch (e) {
        console.log(JSON.stringify({ evt: 'brands', ok: false, code: e.message }));
        return res.status(503).json({
          error: e.quota ? 'ai_quota' : 'ai_unavailable',
          code: String(e.message || '').slice(0, 60)
        });
      }
    }
  }

  /* body + egress guard */
  let input;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
      throw new Error('payload too large');
    }
    input = validateBody(body);
  } catch (e) {
    if (String(e.message).startsWith('EGRESS GUARD')) {
      console.error('EGRESS GUARD TRIPPED — masking regression. Blocked.');
      return res.status(500).json({ error: 'egress_guard' });
    }
    return core.badRequest(res, e.message);
  }

  /* ai */
  const isClassify = input.task === 'classify';
  try {
    const got = await core.callGeminiCascade(
      isClassify ? buildClassifyPrompt(input) : buildPrompt(input),
      { temperature: 0, maxOutputTokens: 900, timeout: GEMINI_TIMEOUT }
    );
    const clean = isClassify ? sanitiseClassify(got.ai) : sanitise(got.ai, input.headers.length);
    console.log(JSON.stringify(isClassify
      ? { evt: 'classify', ok: true, model: got.model, cols: input.headers.length, fileType: clean.fileType, conf: clean.confidence }
      : { evt: 'map', ok: true, model: got.model, cols: input.headers.length, mapped: Object.keys(clean.fields).length, conf: clean.confidence }
    ));
    return res.status(200).json({ ...clean, model: got.model, source: 'ai' });
  } catch (e) {
    console.log(JSON.stringify({
      evt: isClassify ? 'classify' : 'map', ok: false, code: e.message,
      detail: String(e.detail || '').slice(0, 180)
    }));
    return core.geminiFailure(res, e);
  }
};

/* =========================================================
   api/map-schema.js — Retail AI · AI column-mapping endpoint
   ---------------------------------------------------------
   Vercel serverless function. ZERO npm dependencies.
   Runs only when retail-import.js cannot confidently read a
   file. Falls back to the manual mapping modal on ANY failure.

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

const crypto = require('crypto');

/* Model cascade: try each until one answers. Google renames models
   often; the -latest aliases track the newest, dated ids are backup. */
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash'
].filter(Boolean);
const PROJECT_ID = process.env.FIREBASE_PROJECT || 'retail-ai-2c674';
const CERT_URL   = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/* Fields retail-import.js knows how to use. Must stay in sync. */
const TARGET_FIELDS = [
  'store', 'brand', 'ean', 'style', 'variant', 'size', 'sizeGrid',
  'qty', 'mrp', 'value', 'world', 'desc', 'dept', 'season'
];
const HOUSES = ['w', 'aurelia', 'jaypore', 'unknown'];

/* ---------- limits ---------- */
const MAX_HEADERS      = 200;
const MAX_HEADER_LEN   = 100;
const MAX_SAMPLES      = 5;
const MAX_BODY_BYTES   = 8 * 1024;      // 8KB cannot hold a 50k-row file
const PER_USER_HOUR    = 20;
const PER_USER_DAY     = 100;
const GEMINI_TIMEOUT   = 10000;

/* =========================================================
   1. Egress guard — the privacy promise, as code
   ---------------------------------------------------------
   After masking: digits -> #, A-Z -> A, a-z -> a.
   So a real value ("8901234567890", "Navy Blue", "W417")
   CANNOT pass this test. If it does throw, masking regressed
   and we must fail loudly rather than leak.
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

function validateBody(body) {
  const allowed = ['headers', 'samples', 'filename', 'sheetName', 'fingerprint'];
  for (const k of Object.keys(body || {})) {
    if (!allowed.includes(k)) throw new Error('unexpected field: ' + k);
  }
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
    sheetName: typeof body.sheetName === 'string' ? body.sheetName.slice(0, 60) : ''
  };
}

/* =========================================================
   2. Firebase ID token verification — no firebase-admin
   ---------------------------------------------------------
   Verifies the RS256 signature against Google's public certs.
   Needs only the PUBLIC project id. No service-account secret.
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
   3. Rate limit
   ---------------------------------------------------------
   In-memory, per warm instance. Not perfect across instances,
   but it stops the real risk: a retry loop in a client build.
   The hard ceiling is Gemini's own free-tier quota, which
   cannot generate a bill. Fallback is always the manual modal.
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
  if (hits.size > 5000) hits.clear();          // crude memory bound
  return null;
}

/* =========================================================
   4. Gemini
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
    '{"house":"w|aurelia|jaypore|unknown","fields":{"qty":7,"mrp":5},"confidence":0.0}'
  ].join('\n');
}

async function callGeminiCascade(prompt) {
  let lastErr;
  for (const m of MODEL_CANDIDATES) {
    try {
      return { ai: await callGemini(prompt, m), model: m };
    } catch (e) {
      lastErr = e;
      if (e.status !== 404) throw e;   /* only model-not-found falls through */
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
          maxOutputTokens: 900,
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
   5. Handler
   ========================================================= */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-RA-Version', '3');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'ai_not_configured' });
  }

  /* auth */
  let uid;
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new Error('no bearer');
    uid = await verifyIdToken(h.slice(7));
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  /* rate limit */
  const limited = rateLimited(uid);
  if (limited) {
    return res.status(429).json({ error: 'rate_limited', window: limited });
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
        const got = await callGeminiCascade(prompt);
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
    return res.status(400).json({ error: 'bad_request', detail: e.message });
  }

  /* ai */
  try {
    const got = await callGeminiCascade(buildPrompt(input));
    const clean = sanitise(got.ai, input.headers.length);
    console.log(JSON.stringify({
      evt: 'map', ok: true, model: got.model,
      cols: input.headers.length,
      mapped: Object.keys(clean.fields).length,
      conf: clean.confidence
    }));
    return res.status(200).json({ ...clean, model: got.model, source: 'ai' });
  } catch (e) {
    console.log(JSON.stringify({
      evt: 'map', ok: false, code: e.message,
      detail: String(e.detail || '').slice(0, 180)
    }));
    /* code/detail are Google's public error text — never the key */
    return res.status(503).json({
      error: e.quota ? 'ai_quota' : 'ai_unavailable',
      code: String(e.message || '').slice(0, 60),
      detail: String(e.detail || '').slice(0, 180)
    });
  }
};

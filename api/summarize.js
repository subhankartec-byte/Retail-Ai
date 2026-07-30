/* =========================================================
   api/summarize.js — Retail AI · AI executive-summary endpoint
   ---------------------------------------------------------
   Vercel serverless function. ZERO npm dependencies.
   Same security architecture as api/map-schema.js: Firebase ID
   token required, in-memory per-user rate limit, egress guard
   on the request body before it ever reaches Gemini.

   WHAT THIS SENDS TO GOOGLE:
     - already-aggregated business metrics the manager can already
       see on screen: period totals, per-staff / per-department /
       per-brand / per-size-bucket rollups (name + qty + value).
   WHAT IT NEVER SENDS:
     - a single POS row, bill number, barcode, customer, or
       anything not already a group total in the UI.
   validateBody() below enforces this shape server-side and
   rejects anything that looks like raw/row-level data, even if
   the client were ever compromised or modified.

   ENV VARS (set in Vercel dashboard, never in code):
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
const MAX_BODY_BYTES  = 20 * 1024;   // generous for aggregates, cannot hold row-level data
const MAX_NAME_LEN    = 60;
const MAX_STAFF       = 30;
const MAX_DEPARTMENTS = 30;
const MAX_FESTIVE     = 15;
const MAX_BRANDS      = 15;
const MAX_SIZES       = 30;
const PER_USER_HOUR   = 20;
const PER_USER_DAY    = 100;
const GEMINI_TIMEOUT  = 12000;

/* =========================================================
   1. Egress guard — the privacy promise, as code
   ---------------------------------------------------------
   Every "name" field must be a short label, never a long run of
   digits (which would indicate a barcode/phone/EAN slipped in
   instead of a staff/department/brand/size label). Every metric
   must be a finite number. Unknown top-level keys are rejected
   outright, and every list is capped — a real aggregate view
   never has hundreds of departments or thousands of "staff".
   ========================================================= */
const DIGIT_RUN_RE = /\d{6,}/;

function checkLabel(v, field) {
  if (typeof v !== 'string') throw new Error('EGRESS GUARD: ' + field + ' must be a string');
  if (v.length > MAX_NAME_LEN) throw new Error('EGRESS GUARD: ' + field + ' too long');
  if (DIGIT_RUN_RE.test(v)) throw new Error('EGRESS GUARD: ' + field + ' looks like raw data (long digit run)');
}
function checkNum(v, field) {
  if (typeof v !== 'number' || !isFinite(v)) throw new Error('EGRESS GUARD: ' + field + ' must be a finite number');
}
function checkNumOrNull(v, field) {
  if (v === null || v === undefined) return;
  checkNum(v, field);
}

function checkTotals(t, label) {
  if (!t || typeof t !== 'object') throw new Error(label + ' required');
  ['value', 'bills', 'qty', 'atv', 'upt', 'asp'].forEach(k => checkNum(t[k], label + '.' + k));
}

function checkGroupList(list, field, max, labelField) {
  if (!Array.isArray(list)) throw new Error(field + ' must be an array');
  if (list.length > max) throw new Error(field + ' too long');
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(field + ' row must be an object');
    checkLabel(row[labelField], field + '.' + labelField);
    checkNum(row.qty, field + '.qty');
    checkNum(row.value, field + '.value');
    if (Object.prototype.hasOwnProperty.call(row, 'bills')) checkNum(row.bills, field + '.bills');
    if (Object.prototype.hasOwnProperty.call(row, 'abv')) checkNum(row.abv, field + '.abv');
  }
}

function validateBody(body) {
  const allowed = [
    'currency', 'period', 'comparePeriod', 'billRule',
    'totals', 'compareTotals', 'discountPctOnMrp', 'offerMix', 'weekend',
    'staff', 'departments', 'festive', 'brand', 'sizeCurve'
  ];
  if (!body || typeof body !== 'object') throw new Error('body required');
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new Error('unexpected field: ' + k);
  }

  if (body.currency !== 'INR') throw new Error('unexpected currency');

  if (!body.period || typeof body.period.label !== 'string' || body.period.label.length > 80) {
    throw new Error('period.label required');
  }
  checkNum(body.period.days, 'period.days');

  if (body.comparePeriod !== null) {
    if (typeof body.comparePeriod.label !== 'string' || body.comparePeriod.label.length > 80) {
      throw new Error('comparePeriod.label invalid');
    }
    checkNum(body.comparePeriod.days, 'comparePeriod.days');
  }

  if (!['net0', 'noret', 'distinct'].includes(body.billRule)) throw new Error('bad billRule');

  checkTotals(body.totals, 'totals');
  if (body.compareTotals !== null) checkTotals(body.compareTotals, 'compareTotals');

  checkNumOrNull(body.discountPctOnMrp, 'discountPctOnMrp');

  if (!body.offerMix || typeof body.offerMix !== 'object') throw new Error('offerMix required');
  checkNum(body.offerMix.onOfferValue, 'offerMix.onOfferValue');
  checkNum(body.offerMix.fullPriceValue, 'offerMix.fullPriceValue');

  if (!body.weekend || typeof body.weekend !== 'object') throw new Error('weekend required');
  checkNum(body.weekend.value, 'weekend.value');
  checkNum(body.weekend.shareOfPeriod, 'weekend.shareOfPeriod');

  checkGroupList(body.staff || [], 'staff', MAX_STAFF, 'name');
  checkGroupList(body.departments || [], 'departments', MAX_DEPARTMENTS, 'dept');
  checkGroupList(body.festive || [], 'festive', MAX_FESTIVE, 'segment');
  if (body.brand !== null) checkGroupList(body.brand || [], 'brand', MAX_BRANDS, 'brand');
  if (!Array.isArray(body.sizeCurve)) throw new Error('sizeCurve must be an array');
  if (body.sizeCurve.length > MAX_SIZES) throw new Error('sizeCurve too long');
  for (const row of body.sizeCurve) {
    checkLabel(row.size, 'sizeCurve.size');
    checkNum(row.qty, 'sizeCurve.qty');
  }

  return body;
}

/* =========================================================
   2. Firebase ID token verification — identical to map-schema.js
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
   3. Rate limit — identical shape to map-schema.js
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
   4. Gemini
   ========================================================= */
function fmtGroup(list, labelField) {
  if (!list || !list.length) return '(none)';
  return list.map(r => {
    const bits = [labelField + '=' + r[labelField], 'qty=' + r.qty, 'value=' + r.value];
    if (r.bills !== undefined) bits.push('bills=' + r.bills);
    if (r.abv !== undefined) bits.push('abv=' + r.abv);
    return '  - ' + bits.join(', ');
  }).join('\n');
}

function buildPrompt(d) {
  const cmp = d.compareTotals
    ? 'Prior period (' + d.comparePeriod.label + ', ' + d.comparePeriod.days + ' days): ' + JSON.stringify(d.compareTotals)
    : 'No prior period selected for comparison.';
  return [
    'You are a retail business analyst writing a short executive summary for a store',
    'manager of an Indian fashion retail chain. Currency is INR — use the ₹ symbol and',
    'Indian digit grouping (e.g. ₹1,23,456). Use ONLY the numbers given below — never invent',
    'or estimate a figure that is not present. If something cannot be answered from this data,',
    'do not mention it rather than guessing.',
    '',
    'Write for someone busy on the shop floor: concrete, specific, and actionable. Call out',
    'named staff, departments, brands or sizes by name when the data supports it (e.g. name the',
    'specific person with the lowest average bill value if coaching is warranted).',
    '',
    'Current period (' + d.period.label + ', ' + d.period.days + ' days): ' + JSON.stringify(d.totals),
    cmp,
    'Bill counting rule: ' + d.billRule,
    'Discount on MRP: ' + (d.discountPctOnMrp == null ? 'n/a' : d.discountPctOnMrp + '%'),
    'On-offer vs full-price value: ' + JSON.stringify(d.offerMix),
    'Weekend (Fri-Sun) value: ₹' + d.weekend.value + ', ' + d.weekend.shareOfPeriod + '% of period',
    '',
    'Staff performance (name, qty, value, bills, abv=avg bill value):',
    fmtGroup(d.staff, 'name'),
    '',
    'Departments (dept, qty, value):',
    fmtGroup(d.departments, 'dept'),
    '',
    'Festive vs non-festive (segment, qty, value):',
    fmtGroup(d.festive, 'segment'),
    '',
    'Brand mix (brand, qty, value):',
    d.brand ? fmtGroup(d.brand, 'brand') : '(no brand data — SOH/item master not loaded)',
    '',
    'Size curve (size, qty):',
    (d.sizeCurve && d.sizeCurve.length) ? d.sizeCurve.map(r => '  - ' + r.size + ': ' + r.qty).join('\n') : '(none)',
    '',
    'Respond with JSON only, no markdown, no commentary:',
    '{"headline":"one sentence, the single most important takeaway","bullets":["3 to 5 short, specific, actionable bullet points"]}'
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
          temperature: 0.3,
          maxOutputTokens: 700,
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
  const headline = typeof (ai && ai.headline) === 'string' ? ai.headline.slice(0, 240) : '';
  let bullets = Array.isArray(ai && ai.bullets) ? ai.bullets : [];
  bullets = bullets
    .filter(b => typeof b === 'string' && b.trim())
    .map(b => b.slice(0, 240))
    .slice(0, 6);
  return { headline, bullets };
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
    console.error('[api/summarize] GEMINI_API_KEY is not set in this environment — AI requests cannot be served.');
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
      console.error('EGRESS GUARD TRIPPED on /api/summarize — blocked. ' + e.message);
      return res.status(500).json({ error: 'egress_guard' });
    }
    return res.status(400).json({ error: 'bad_request', detail: e.message });
  }

  try {
    const got = await callGeminiCascade(buildPrompt(input));
    const clean = sanitise(got.ai);
    console.log(JSON.stringify({ evt: 'summarize', ok: true, model: got.model, bullets: clean.bullets.length }));
    return res.status(200).json({ ...clean, model: got.model, source: 'ai' });
  } catch (e) {
    console.log(JSON.stringify({ evt: 'summarize', ok: false, code: e.message, detail: String(e.detail || '').slice(0, 180) }));
    return res.status(503).json({
      error: e.quota ? 'ai_quota' : 'ai_unavailable',
      code: String(e.message || '').slice(0, 60),
      detail: String(e.detail || '').slice(0, 180)
    });
  }
};

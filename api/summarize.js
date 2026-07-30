/* =========================================================
   api/summarize.js — Retail AI · AI executive-summary endpoint
   ---------------------------------------------------------
   Vercel serverless function. Auth, rate limiting and the
   Gemini call itself now live in ./_lib/ai-core.js (Universal
   AI Pipeline core, shared by every AI endpoint) — this file
   keeps only what's genuinely specific to this task: its
   request shape, its egress guard, its prompt, and its
   response sanitiser. Request/response shapes, status codes,
   rate limits and env vars are unchanged from before this
   refactor.

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

const core = require('./_lib/ai-core');

/* ---------- limits (unchanged) ---------- */
const MAX_NAME_LEN    = 60;
const MAX_STAFF       = 30;
const MAX_DEPARTMENTS = 30;
const MAX_FESTIVE     = 15;
const MAX_BRANDS      = 15;
const MAX_SIZES       = 30;
const MAX_BODY_BYTES  = 20 * 1024;
const GEMINI_TIMEOUT  = 12000;
const rateLimited = core.makeRateLimiter(20, 100);   // unchanged

/* =========================================================
   1. Egress guard — the privacy promise, as code
   ========================================================= */
function checkLabel(v, field) { return core.checkLabel(v, field, MAX_NAME_LEN, core.DIGIT_RUN_RE_6); }
function checkNum(v, field) { return core.checkNum(v, field); }
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
   2. Gemini
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
   3. Handler
   ========================================================= */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-RA-Version', '1');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return core.notConfigured(res, 'api/summarize');
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
      return core.egressGuardTripped(res, '/api/summarize', e.message);
    }
    return core.badRequest(res, e.message);
  }

  try {
    const got = await core.callGeminiCascade(buildPrompt(input), { temperature: 0.3, maxOutputTokens: 700, timeout: GEMINI_TIMEOUT });
    const clean = sanitise(got.ai);
    console.log(JSON.stringify({ evt: 'summarize', ok: true, model: got.model, bullets: clean.bullets.length }));
    return res.status(200).json({ ...clean, model: got.model, source: 'ai' });
  } catch (e) {
    console.log(JSON.stringify({ evt: 'summarize', ok: false, code: e.message, detail: String(e.detail || '').slice(0, 180) }));
    return core.geminiFailure(res, e);
  }
};

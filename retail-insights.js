/* =========================================================
   retail-insights.js — Retail AI · AI executive summary (Tier 1)
   ---------------------------------------------------------
   Include on tool pages that want it:

       <script type="module" src="retail-insights.js"></script>

   Same architecture as retail-assist.js: server-side proxy
   (api/summarize.js), Firebase-auth-gated, never blocks the
   page on failure. The caller builds an ALREADY-AGGREGATED
   context object (period totals, per-staff / per-department /
   per-brand / per-size rollups — nothing row-level) and this
   module just ships it and hands back the result.

   Optional by design: if this file or the endpoint is absent,
   blocked, or the network is down, summarize() resolves to
   null and the caller shows its own fallback message. AI is
   never on the happy path of any report.
   ========================================================= */
import { auth } from "./firebase.js";

(function () {
  'use strict';

  var ENDPOINT   = '/api/summarize';
  var TIMEOUT_MS = 15000;

  async function idToken () {
    var u = auth.currentUser;
    if (!u) return null;
    try { return await u.getIdToken(); } catch (e) { return null; }
  }

  /* summarize(context) -> always resolves, never throws.
     Success: { ok:true, headline, bullets, source:'ai' }
     Failure: { ok:false, reason: 'signed_out'|'rate_limited'|'unavailable'|'network'|'bad_response' }
     Unlike retail-assist.js's suggest(), failures are not fully silent:
     there is no equally-good non-AI fallback for a summary, so the
     caller gets enough to show a useful message (e.g. "try again in
     an hour") instead of a generic failure. */
  async function summarize (context) {
    var token;
    try { token = await idToken(); } catch (e) { token = null; }
    if (!token) return { ok: false, reason: 'signed_out' };

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    var res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(context)
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
    if (!data || !Array.isArray(data.bullets) || !data.bullets.length) {
      return { ok: false, reason: 'bad_response' };
    }
    return { ok: true, headline: data.headline || '', bullets: data.bullets, source: 'ai' };
  }

  window.RetailInsights = { summarize: summarize };
}());

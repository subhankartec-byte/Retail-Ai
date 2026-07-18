/* =========================================================
   retail-assist.js — Retail AI · AI mapping assist (Phase 5)
   ---------------------------------------------------------
   Include on tool pages AFTER retail-mapping.js:

       <script src="retail-mapping.js"></script>
       <script type="module" src="retail-assist.js"></script>

   Optional by design. If this file is absent, blocked, or the
   network is down, retail-mapping.js falls straight through to
   the manual modal and every tool keeps working. AI is never
   on the happy path.

   ---------------------------------------------------------
   PRIVACY — the whole point of this file
   ---------------------------------------------------------
   Only two things ever leave the browser:
     1. column HEADER NAMES   "Retail Price", "SOH Qty"
     2. masked value SHAPES   "####.##", "A###"

   Masking runs HERE, before the request is built, so real
   values never travel:
       8901234567890  ->  #############
       2499.00        ->  ####.##
       W417           ->  A###
       Navy Blue      ->  Aaaa Aaaa

   No row, barcode, price, quantity or store value is ever
   sent. The server re-checks this and refuses to forward
   anything that still contains a digit.
   ========================================================= */
import { auth } from "./firebase.js";

(function () {
  'use strict';

  var ENDPOINT      = '/api/map-schema';
  var MAX_BODY      = 7000;      // stay under the server's 8KB ceiling
  var MAX_VAL_LEN   = 20;
  var SAMPLE_ROWS   = 3;
  var SCAN_ROWS     = 200;       // how far down to look for a non-empty cell
  var MIN_CONF      = 0.6;       // below this we don't even offer it
  var TIMEOUT_MS    = 12000;

  /* ---------- masking ---------- */
  var ALLOWED = /[^#Aa\s.,\-\/()&+_:*'"|\[\]]/g;

  function maskValue (v) {
    return String(v == null ? '' : v).trim().slice(0, MAX_VAL_LEN)
      .replace(/[0-9]/g, '#')
      .replace(/[A-Z]/g, 'A')
      .replace(/[a-z]/g, 'a')
      .replace(ALLOWED, '*');
  }

  /* Belt and braces: never let an unmasked value out, even if
     maskValue is ever broken by a future edit. */
  function safeMask (v) {
    var m = maskValue(v);
    if (/[0-9]/.test(m)) return '';
    return m;
  }

  function buildSamples (rows2D, headerIdx, colCount, nRows) {
    var out = [];
    var limit = Math.min(rows2D.length, headerIdx + 1 + SCAN_ROWS);
    for (var r = headerIdx + 1; r < limit && out.length < nRows; r++) {
      var row = rows2D[r] || [];
      var obj = {}, any = false;
      for (var c = 0; c < colCount; c++) {
        var raw = row[c];
        if (raw == null || String(raw).trim() === '') continue;
        var m = safeMask(raw);
        if (!m) continue;
        obj[String(c)] = m;
        any = true;
      }
      if (any) out.push(obj);
    }
    return out;
  }

  /* ---------- request ---------- */
  function buildBody (rows2D, result) {
    var headers = (result.mapping.headers || []).map(function (h) {
      return String(h == null ? '' : h).slice(0, 100);
    });
    var headerIdx = result.headerIndex || 0;

    for (var n = SAMPLE_ROWS; n >= 0; n--) {
      var body = {
        headers: headers,
        samples: buildSamples(rows2D, headerIdx, headers.length, n),
        filename: '',
        sheetName: ''
      };
      var json = JSON.stringify(body);
      if (json.length <= MAX_BODY) return body;
    }
    return null;   // headers alone too big — give up, use the modal
  }

  async function idToken () {
    var u = auth.currentUser;
    if (!u) return null;
    try { return await u.getIdToken(); } catch (e) { return null; }
  }

  /* ---------- public API ---------- */
  /* suggest(rows2D, importResult)
     -> { house, fields, confidence, source:'ai' }  on success
     -> null                                        on any failure
     Never throws. Never blocks. */
  async function suggest (rows2D, result) {
    try {
      var token = await idToken();
      if (!token) return null;                 // signed out — modal handles it

      var body = buildBody(rows2D, result);
      if (!body) return null;

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
          body: JSON.stringify(body)
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) return null;                // 401/429/503 -> modal

      var data = await res.json();
      if (!data || !data.fields) return null;
      if (typeof data.confidence === 'number' && data.confidence < MIN_CONF) return null;

      /* Only fields retail-import.js understands, only valid indices. */
      var headerCount = (result.mapping.headers || []).length;
      var fields = {};
      for (var f in data.fields) {
        var i = data.fields[f];
        if (typeof i === 'number' && i >= 0 && i < headerCount && i === Math.floor(i)) {
          fields[f] = i;
        }
      }
      if (!Object.keys(fields).length) return null;

      return {
        house: data.house || null,
        fields: fields,
        confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
        source: 'ai'
      };
    } catch (e) {
      return null;                             // silence is correct here
    }
  }

  window.RetailAssist = {
    suggest: suggest,
    maskValue: maskValue,
    _buildBody: buildBody               /* exposed for tests only */
  };
}());

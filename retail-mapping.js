/* ============================================================
   retail-mapping.js — Mapping confirmation + fingerprint memory
   (Phase 4)
   ------------------------------------------------------------
   Pure JS, zero dependencies. Browser: window.RetailMapping.
   Node (tests): module.exports (UI paths degrade gracefully).
   - fingerprintOf(headers): stable id for a file format
   - load / save / forget: localStorage memory per fingerprint
   - confirm(rows2D, importResult, opts): Promise<{house, fields,
     source}> — memory first, then auto if confident, else modal.
   opts.mode: 'house' (house question only) | 'full' (columns too)
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RetailMapping = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var LS_PREFIX = 'retailai.map.v1.';
var norm = function (s) {
  return String(s === null || s === undefined ? '' : s)
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
};

function fingerprintOf (headers) {
  var joined = (headers || []).map(norm).join('\u0001');
  var h = 5381;
  for (var i = 0; i < joined.length; i++) h = ((h << 5) + h + joined.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16) + '-' + (headers || []).length;
}

function lsGet (k) { try { return (typeof localStorage !== 'undefined') ? localStorage.getItem(k) : null; } catch (e) { return null; } }
function lsSet (k, v) { try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (e) {} }
function lsDel (k) { try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); } catch (e) {} }

function load (fp, headersCheck) {
  var raw = lsGet(LS_PREFIX + fp);
  if (!raw) return null;
  try {
    var d = JSON.parse(raw);
    if (headersCheck && d.headers &&
        d.headers.join('\u0001') !== headersCheck.map(norm).join('\u0001')) return null;
    return d;
  } catch (e) { return null; }
}
function save (fp, headers, data) {
  var d = { v: 1, headers: (headers || []).map(norm),
            house: data.house || null, fields: data.fields || null,
            savedAt: new Date().toISOString() };
  lsSet(LS_PREFIX + fp, JSON.stringify(d));
  return d;
}
function forget (fp) { lsDel(LS_PREFIX + fp); }

function idxMap (fields) {
  var out = {};
  for (var f in fields) if (fields[f]) out[f] = fields[f].index;
  return out;
}

/* ---------- modal UI ---------- */
var FIELD_LABELS = [
  ['store', 'Store / Plant'], ['brand', 'Brand'], ['ean', 'EAN / Barcode'],
  ['style', 'Style Code'], ['variant', 'Variant'], ['size', 'Size'],
  ['sizeGrid', 'Size Grid'], ['qty', 'SOH Qty'], ['mrp', 'MRP'],
  ['value', 'Value'], ['world', 'World / Category']
];
var CSS = '.rai-map-ovl{position:fixed;inset:0;background:rgba(6,12,24,.72);backdrop-filter:blur(3px);' +
  'z-index:99999;display:flex;align-items:center;justify-content:center;padding:14px;font-family:system-ui,Segoe UI,Roboto,sans-serif}' +
  '.rai-map-box{background:#0d1b2e;border:1px solid #c9a22755;border-radius:14px;max-width:520px;width:100%;' +
  'max-height:88vh;overflow:auto;padding:20px;color:#e8edf5;box-shadow:0 18px 60px rgba(0,0,0,.55)}' +
  '.rai-map-box h3{margin:0 0 4px;color:#c9a227;font-size:17px;letter-spacing:.4px}' +
  '.rai-map-sub{font-size:12px;color:#9fb0c8;margin:0 0 14px}' +
  '.rai-map-row{margin:0 0 12px}.rai-map-row label{display:block;font-size:11px;letter-spacing:.6px;' +
  'text-transform:uppercase;color:#9fb0c8;margin:0 0 4px}' +
  '.rai-map-row select{width:100%;background:#132741;color:#e8edf5;border:1px solid #2a4368;' +
  'border-radius:8px;padding:9px 10px;font-size:14px}' +
  '.rai-map-row.rai-warn select{border-color:#c9a227}' +
  '.rai-map-smp{font-size:11px;color:#7d8fa9;margin:3px 0 0;min-height:14px;word-break:break-all}' +
  '.rai-map-btns{display:flex;gap:10px;margin-top:16px}' +
  '.rai-map-btns button{flex:1;border:none;border-radius:9px;padding:11px 12px;font-size:14px;font-weight:600;cursor:pointer}' +
  '.rai-map-go{background:linear-gradient(135deg,#c9a227,#e6c65a);color:#14213b}' +
  '.rai-map-skip{background:#1a2c47;color:#c7d3e6;border:1px solid #2a4368!important}';

function sampleVals (rows2D, headerIdx, col, n) {
  var out = [], r = headerIdx + 1, lim = Math.min(rows2D.length, headerIdx + 400);
  while (out.length < (n || 3) && r < lim) {
    var v = (rows2D[r] || [])[col];
    v = v === null || v === undefined ? '' : String(v).trim();
    if (v) out.push(v.length > 18 ? v.slice(0, 18) + '…' : v);
    r++;
  }
  return out.join(' · ');
}

function houseOptions () {
  var RP = (typeof window !== 'undefined') && window.RetailProfiles;
  var list = [['w', 'W BRAND'], ['aurelia', 'AURELIA'], ['jaypore', 'JAYPORE']];
  if (RP && RP.PROFILES) list = Object.keys(RP.PROFILES)
    .filter(function (k) { return k !== 'unknown'; })
    .map(function (k) { return [k, RP.PROFILES[k].displayName || k.toUpperCase()]; });
  return list;
}

function showModal (rows2D, result, opts) {
  return new Promise(function (resolve) {
    var doc = document;
    if (!doc.getElementById('rai-map-css')) {
      var st = doc.createElement('style'); st.id = 'rai-map-css'; st.textContent = CSS;
      doc.head.appendChild(st);
    }
    var headers = result.mapping.headers, fields = result.mapping.fields || {};
    var headerIdx = result.headerIndex || 0;
    var mode = (opts && opts.mode) || 'full';
    var ovl = doc.createElement('div'); ovl.className = 'rai-map-ovl';
    var box = doc.createElement('div'); box.className = 'rai-map-box';
    box.innerHTML = '<h3>Confirm file mapping</h3>' +
      '<p class="rai-map-sub">' + headers.filter(function(h){return String(h).trim();}).length +
      ' columns found. This choice is remembered for this file format.</p>';

    /* house selector */
    var hRow = doc.createElement('div'); hRow.className = 'rai-map-row';
    hRow.innerHTML = '<label>Brand house</label>';
    var hSel = doc.createElement('select');
    houseOptions().forEach(function (o) {
      var op = doc.createElement('option'); op.value = o[0]; op.textContent = o[1]; hSel.appendChild(op);
    });
    var opU = doc.createElement('option'); opU.value = ''; opU.textContent = 'Not sure / other';
    hSel.appendChild(opU);
    hSel.value = (result.house && result.house !== 'unknown') ? result.house : '';
    hRow.appendChild(hSel); box.appendChild(hRow);

    /* column selectors */
    var selMap = {};
    if (mode === 'full') {
      var reasons = (result.confirmReasons || []).join(' ');
      FIELD_LABELS.forEach(function (fl) {
        var f = fl[0], row = doc.createElement('div');
        row.className = 'rai-map-row' + (reasons.indexOf(f === 'qty' ? 'quantity' : f) !== -1 ? ' rai-warn' : '');
        row.innerHTML = '<label>' + fl[1] + '</label>';
        var sel = doc.createElement('select');
        var none = doc.createElement('option'); none.value = '-1'; none.textContent = '— not present —';
        sel.appendChild(none);
        headers.forEach(function (h, i) {
          if (!String(h).trim()) return;
          var op = doc.createElement('option'); op.value = String(i);
          op.textContent = String.fromCharCode(65 + (i % 26)) + (i > 25 ? Math.floor(i / 26) : '') + ' — ' + h;
          sel.appendChild(op);
        });
        sel.value = fields[f] ? String(fields[f].index) : '-1';
        var smp = doc.createElement('div'); smp.className = 'rai-map-smp';
        var upd = function () {
          var i = parseInt(sel.value, 10);
          smp.textContent = i >= 0 ? sampleVals(rows2D, headerIdx, i, 3) : '';
        };
        sel.addEventListener('change', upd); upd();
        row.appendChild(sel); row.appendChild(smp);
        box.appendChild(row); selMap[f] = sel;
      });
    }

    var btns = doc.createElement('div'); btns.className = 'rai-map-btns';
    var go = doc.createElement('button'); go.className = 'rai-map-go'; go.textContent = 'Use & remember';
    var skip = doc.createElement('button'); skip.className = 'rai-map-skip'; skip.textContent = 'Skip';
    btns.appendChild(skip); btns.appendChild(go); box.appendChild(btns);
    ovl.appendChild(box); doc.body.appendChild(ovl);

    var done = function (res) { try { ovl.remove(); } catch (e) {} resolve(res); };
    skip.addEventListener('click', function () {
      done({ house: result.house === 'unknown' ? null : result.house,
             fields: idxMap(fields), source: 'skip' });
    });
    go.addEventListener('click', function () {
      var out = { house: hSel.value || null, fields: idxMap(fields), source: 'user' };
      if (mode === 'full') {
        out.fields = {};
        for (var f in selMap) {
          var i = parseInt(selMap[f].value, 10);
          if (i >= 0) out.fields[f] = i;
        }
      }
      var fp = fingerprintOf(headers);
      save(fp, headers, out);
      done(out);
    });
    ovl.addEventListener('keydown', function (e) { if (e.key === 'Escape') skip.click(); });
  });
}

function confirm (rows2D, result, opts) {
  opts = opts || {};
  var headers = result.mapping.headers;
  var fp = fingerprintOf(headers);
  var saved = load(fp, headers);
  if (saved && !opts.force) {
    return Promise.resolve({ house: saved.house, fields: saved.fields, source: 'memory' });
  }
  if (!result.needsConfirmation && !opts.always) {
    return Promise.resolve({ house: result.house, fields: idxMap(result.mapping.fields), source: 'auto' });
  }
  if (typeof document === 'undefined' || !document.body) {
    return Promise.resolve({ house: result.house, fields: idxMap(result.mapping.fields), source: 'auto-nodom' });
  }
  return showModal(rows2D, result, opts);
}

return { fingerprintOf: fingerprintOf, load: load, save: save, forget: forget,
         confirm: confirm, idxMap: idxMap, LS_PREFIX: LS_PREFIX };
}));

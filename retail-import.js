/* ============================================================
   retail-import.js — Universal SOH import engine (Phase 2)
   ------------------------------------------------------------
   Pure JS, zero dependencies. Browser: window.RetailImport.
   Node (tests): module.exports.
   Input : rows2D — array of arrays (SheetJS sheet_to_json
           {header:1, raw:true, defval:''} or TSV split).
   Output: { house, houseVia, headerIndex, mapping, rows,
             styles, ignored, gridMap, stats, warnings,
             needsConfirmation, confirmReasons }
   Locked rules (July 2026):
   - Row is merchandise if ANY of EAN / Style Code / Variant.
   - Style key = Style Code, else Variant minus size suffix
     (all-digit variants are style codes as-is — Jaypore).
   - Size = label col first; else grid code mapped via learned
     map (per-style majority, then global); else raw grid;
     both blank => Free Size.
   - Free Size = FS / WFS / blank. S-M, L-XL, PS, PLUS = real.
   - Ignore: Jaypore World=OTHERS; W brand HO. Never by MRP.
   - House from brand column when present, never plant prefix;
     Jaypore (no brand col) via header fingerprint.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RetailImport = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ---------- tiny helpers ---------- */
var S = function (v) { return (v === null || v === undefined) ? '' : String(v).trim(); };
var norm = function (s) { return S(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
var NUM = function (v) { var n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };

var GRID_RE = /^a\d{1,3}$/i;                                /* A54, A32 ... */
var SCI_RE  = /\d\.?\d*e\+\d+/i;                            /* 8.90547E+12  */
var DIGITS_RE = /^\d+$/;
var FREE_SET = { fs:1, wfs:1, free:1, 'free size':1, freesize:1, os:1, 'one size':1, onesize:1 };
var LABEL_RE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-8]xl|ps|pm|pl|plus|s[-\/]m|m[-\/]l|l[-\/]xl|xl[-\/]xxl|\d{1,3}(\.5)?|eu[- ]?\d{2}|uk[- ]?\d{1,2}|us[- ]?\d{1,2})$/i;

/* Synonyms are pre-normalised. Order = priority (index 0 wins). */
var FIELDS = {
  store:   ['plant', 'site', 'store code', 'store', 'branch', 'outlet', 'plnt'],
  ean:     ['ean', 'ean code', 'barcode', 'bar code'],
  size:    ['size', 'size desc', 'size description'],
  style:   ['style code', 'style', 'article code', 'article', 'article no', 'material', 'item code', 'sku', 'style no'],
  variant: ['variant', 'variant code'],
  mrp:     ['mrp', 'rsp', 'retail price', 'list price', 'tag price'],
  qty:     ['soh qty', 'soh quantity', 'soh without blocked stk', 'qty', 'quantity', 'soh', 'closing stock', 'stock qty', 'free stock', 'unrestricted'],
  value:   ['value', 'soh value', 'stock value', 'amount'],
  brand:   ['brand', 'brand name', 'brand code'],
  world:   ['world'],
  lob:     ['lob desc', 'lob'],
  division:['divison', 'division'],            /* SAP misspelling ships first */
  dept:    ['retek dept', 'department', 'dept', 'mc hier 5'],
  group:   ['retek group'],
  klass:   ['retek class'],
  subclass:['retek subclass', 'retek sub class'],
  desc:    ['material description', 'item description', 'style name', 'description'],
  season:  ['seasonct', 'season'],
  story:   ['story name'],
  stloc:   ['st loc', 'storage location'],
  sleeve:  ['sleeve']
};
var BLOCKED_QTY = { 'soh blocked stock':1, 'blocked stock':1, 'blocked':1 };
var W_BRANDS  = { w:1, wi:1, fs:1, ho:1, wishful:1, folksong:1, 'w brand':1, wforwoman:1 };
var AU_BRANDS = { au:1, el:1, aurelia:1, elleven:1, shopforaurelia:1 };

/* ---------- header row detection ---------- */
function findHeaderRow (rows2D, maxScan) {
  maxScan = Math.min(maxScan || 25, rows2D.length);
  var best = { idx: 0, hits: -1 };
  for (var r = 0; r < maxScan; r++) {
    var row = rows2D[r] || [], hits = 0;
    for (var c = 0; c < row.length; c++) {
      var h = norm(row[c]);
      if (!h) continue;
      for (var f in FIELDS) {
        if (FIELDS[f].indexOf(h) !== -1) { hits++; break; }
      }
    }
    if (hits > best.hits) best = { idx: r, hits: hits };
    if (hits >= 6) return { idx: r, hits: hits };      /* confident early exit */
  }
  return best;
}

/* ---------- column mapping ---------- */
function sampleCol (rows2D, start, idx, cap) {
  var out = [], n = Math.min(rows2D.length, start + (cap || 5000));
  for (var r = start; r < n; r++) {
    var v = S((rows2D[r] || [])[idx]);
    if (v) out.push(v);
  }
  return out;
}

function mapColumns (rows2D, headerIdx) {
  var headers = (rows2D[headerIdx] || []).map(S);
  var H = headers.map(norm);
  var cand = {};                                 /* field -> [{i,p,exact}] */
  H.forEach(function (h, i) {
    if (!h) return;
    for (var f in FIELDS) {
      if (f === 'qty' && BLOCKED_QTY[h]) continue;     /* never map blocked stock */
      var syns = FIELDS[f], done = false;
      for (var p = 0; p < syns.length && !done; p++) {
        if (h === syns[p]) { (cand[f] = cand[f] || []).push({ i: i, p: p, exact: true }); done = true; }
        else if (syns[p].length >= 4 && h.indexOf(syns[p]) !== -1) { (cand[f] = cand[f] || []).push({ i: i, p: p + 100, exact: false }); done = true; }
      }
    }
  });

  var used = {}, out = {}, warnings = [];
  var take = function (f, c, method) {
    out[f] = { index: c.i, header: headers[c.i], method: method };
    used[c.i] = 1;
  };

  /* duplicate Size columns -> content decides label vs grid */
  var sizeExact = (cand.size || []).filter(function (x) { return x.exact; });
  if (sizeExact.length >= 2) {
    var scored = sizeExact.map(function (x) {
      var vals = sampleCol(rows2D, headerIdx + 1, x.i, 4000), g = 0, l = 0;
      vals.forEach(function (v) {
        if (GRID_RE.test(v)) g++;
        else if (LABEL_RE.test(v) || FREE_SET[norm(v)]) l++;
      });
      var n = vals.length || 1;
      return { i: x.i, grid: g / n, label: l / n };
    });
    scored.sort(function (a, b) { return b.label - a.label; });
    var labelCol = scored[0];
    var gridCol = scored.slice(1).sort(function (a, b) { return b.grid - a.grid; })[0];
    take('size', { i: labelCol.i }, 'content:label');
    take('sizeGrid', { i: gridCol.i }, 'content:grid');
    delete cand.size;
  }

  var assign = function (exactOnly) {
    for (var f in FIELDS) {
      if (out[f]) continue;
      var list = (cand[f] || []).filter(function (x) { return !used[x.i] && (!exactOnly || x.exact); });
      list.sort(function (a, b) { return a.p - b.p || a.i - b.i; });
      if (list.length) take(f, list[0], list[0].exact ? 'exact' : 'contains');
    }
  };
  assign(true); assign(false);

  /* single size column that is mostly grid codes -> warn (map can't be learned) */
  if (out.size && !out.sizeGrid) {
    var vals = sampleCol(rows2D, headerIdx + 1, out.size.index, 2000), g2 = 0;
    vals.forEach(function (v) { if (GRID_RE.test(v)) g2++; });
    if (vals.length && g2 / vals.length > 0.5) warnings.push('Size column contains mostly grid codes and no label column exists; sizes will pass through unmapped.');
  }
  return { headers: headers, fields: out, warnings: warnings };
}

/* ---------- house detection ---------- */
function detectHouse (rows2D, headerIdx, fields) {
  if (fields.brand) {
    var wc = 0, ac = 0, oc = 0, idx = fields.brand.index;
    var n = Math.min(rows2D.length, headerIdx + 1 + 8000);
    for (var r = headerIdx + 1; r < n; r++) {
      var b = norm((rows2D[r] || [])[idx]);
      if (!b) continue;
      if (W_BRANDS[b]) wc++; else if (AU_BRANDS[b]) ac++; else oc++;
    }
    if (wc + ac > 0 && wc + ac >= oc) {
      return { house: ac > wc ? 'aurelia' : 'w', via: 'brand column (' + (ac > wc ? ac : wc) + ' rows)' };
    }
  }
  if (fields.world && fields.lob && fields.division) {
    return { house: 'jaypore', via: 'header fingerprint (World + LOB Desc + Divison)' };
  }
  return { house: 'unknown', via: 'no brand column, no known fingerprint' };
}

/* ---------- style key ---------- */
function styleKeyOf (style, variant, label, grid) {
  if (style) return style;
  var v = variant;
  if (!v) return '';
  if (DIGITS_RE.test(v)) return v;               /* Jaypore: digit variant IS the style */
  var cands = [label, grid], vu = v.toUpperCase();
  for (var k = 0; k < cands.length; k++) {
    var s = S(cands[k]).toUpperCase();
    if (s && vu.length > s.length && vu.slice(-s.length) === s) {
      return v.slice(0, v.length - s.length).replace(/[-_\s]+$/, '');
    }
  }
  return v;
}

/* ---------- main ---------- */
function importSOH (rows2D, opts) {
  opts = opts || {};
  var minRun = opts.minRun || 3;

  var hdr = findHeaderRow(rows2D);
  var headerIdx = hdr.idx;
  var mapped = mapColumns(rows2D, headerIdx);
  var F = mapped.fields;
  if (opts.mapOverride) {                          /* Phase 4: user-confirmed mapping wins */
    for (var of_ in opts.mapOverride) {
      var oi = opts.mapOverride[of_];
      if (oi === -1 || oi === null || oi === undefined) delete F[of_];
      else F[of_] = { index: oi, header: S((rows2D[headerIdx] || [])[oi]), method: 'override' };
    }
  }
  var houseInfo = opts.houseOverride
    ? { house: opts.houseOverride, via: 'user override' }
    : detectHouse(rows2D, headerIdx, F);
  var house = houseInfo.house;

  var gi = function (f) { return F[f] ? F[f].index : -1; };
  var iStore = gi('store'), iEan = gi('ean'), iStyle = gi('style'), iVar = gi('variant'),
      iSize = gi('size'), iGrid = gi('sizeGrid'), iQty = gi('qty'), iMrp = gi('mrp'),
      iVal = gi('value'), iBrand = gi('brand'), iWorld = gi('world'), iDesc = gi('desc'),
      iDept = gi('dept'), iSeason = gi('season');

  var ignored = {}, ign = function (k) { ignored[k] = (ignored[k] || 0) + 1; };
  var keep = [], eanCorrupt = 0, totalData = 0;

  /* pass 1: filter + raw capture + provisional style key */
  for (var r = headerIdx + 1; r < rows2D.length; r++) {
    var row = rows2D[r] || [];
    var any = false;
    for (var c = 0; c < row.length; c++) if (S(row[c]) !== '') { any = true; break; }
    if (!any) continue;
    totalData++;
    var g = function (i) { return i >= 0 ? S(row[i]) : ''; };

    var world = g(iWorld), brand = g(iBrand);
    if (house === 'jaypore' && world.toUpperCase() === 'OTHERS') { ign('consumable-others'); continue; }
    if (house === 'w' && norm(brand) === 'ho') { ign('consumable-ho'); continue; }

    var ean = g(iEan), style = g(iStyle), variant = g(iVar);
    if (!ean && !style && !variant) { ign('no-identifier'); continue; }
    if (SCI_RE.test(ean)) eanCorrupt++;

    var label = g(iSize), grid = g(iGrid);
    keep.push({
      store: g(iStore), brand: brand, ean: ean,
      styleCode: style, variant: variant,
      styleKey: styleKeyOf(style, variant, label, grid),
      sizeLabel: label, sizeGrid: grid,
      qty: NUM(g(iQty)), mrp: NUM(g(iMrp)), value: NUM(g(iVal)),
      world: world, desc: g(iDesc), dept: g(iDept), season: g(iSeason)
    });
  }

  /* pass 2: learn grid -> label maps (per-style, then global) */
  var perStyle = {}, globalMap = {};
  var bump = function (o, k, lab) { var m = o[k] = o[k] || {}; m[lab] = (m[lab] || 0) + 1; };
  keep.forEach(function (x) {
    if (x.sizeLabel && x.sizeGrid && x.sizeLabel !== x.sizeGrid && GRID_RE.test(x.sizeGrid)) {
      bump(perStyle[x.styleKey] = perStyle[x.styleKey] || {}, x.sizeGrid, x.sizeLabel);
      bump(globalMap, x.sizeGrid, x.sizeLabel);
    }
  });
  var top = function (counter) {
    var best = null, bn = -1;
    for (var k in counter) if (counter[k] > bn) { bn = counter[k]; best = k; }
    return best;
  };
  var globalTop = {}, ambiguous = [];
  for (var gcode in globalMap) {
    globalTop[gcode] = top(globalMap[gcode]);
    if (Object.keys(globalMap[gcode]).length > 1) ambiguous.push(gcode);
  }

  /* pass 3: resolve sizes */
  keep.forEach(function (x) {
    var resolved;
    if (x.sizeLabel) resolved = x.sizeLabel;
    else if (x.sizeGrid) {
      var ps = perStyle[x.styleKey];
      resolved = (ps && ps[x.sizeGrid] && top(ps[x.sizeGrid])) || globalTop[x.sizeGrid] || x.sizeGrid;
    } else resolved = '';
    x.sizeResolved = resolved;
    x.sizeType = (resolved === '' || FREE_SET[norm(resolved)]) ? 'free' : 'real';
  });

  /* styles aggregation + classification */
  var styles = new Map();
  keep.forEach(function (x) {
    var s = styles.get(x.styleKey);
    if (!s) { s = { sizes: new Set(), hasFree: false, qty: 0, mrpMax: 0, rows: 0 }; styles.set(x.styleKey, s); }
    if (x.sizeType === 'real') s.sizes.add(x.sizeResolved.toUpperCase()); else s.hasFree = true;
    s.qty += x.qty; s.rows++;
    if (x.mrp > s.mrpMax) s.mrpMax = x.mrp;
  });
  styles.forEach(function (s) {
    var n = s.sizes.size;
    s.cls = n >= minRun ? 'Valid' : (n >= 1 ? 'Cut Piece' : 'Free Size');
  });

  /* confidence */
  var confirmReasons = [];
  if (!F.qty) confirmReasons.push('quantity column not found');
  if (!F.style && !F.variant) confirmReasons.push('no style/variant column');
  if (!F.size && !F.sizeGrid) confirmReasons.push('no size column');
  if (house === 'unknown') confirmReasons.push('brand house could not be detected');

  return {
    house: house, houseVia: houseInfo.via,
    headerIndex: headerIdx,
    mapping: { headers: mapped.headers, fields: F },
    rows: keep, styles: styles, ignored: ignored,
    gridMap: { global: globalTop, ambiguous: ambiguous },
    stats: {
      totalDataRows: totalData, kept: keep.length,
      eanCorrupt: eanCorrupt,
      styleCount: styles.size,
      freeRows: keep.filter(function (x) { return x.sizeType === 'free'; }).length
    },
    warnings: mapped.warnings,
    needsConfirmation: confirmReasons.length > 0,
    confirmReasons: confirmReasons
  };
}

return { importSOH: importSOH, findHeaderRow: findHeaderRow, mapColumns: mapColumns,
         detectHouse: detectHouse, styleKeyOf: styleKeyOf, norm: norm, FIELDS: FIELDS };
}));

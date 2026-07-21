/* ============================================================
   retail-profiles.js — Brand-house profiles as data (Phase 3)
   ------------------------------------------------------------
   Pure JS, zero dependencies. Browser: window.RetailProfiles.
   Node (tests): module.exports.
   Profiles drive: report title prefixes, product-search URLs,
   size sort order, free-size codes, dual-size-column display.
   No brand name renders in any UI until a file is uploaded and
   its house detected (see retail-import.js).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RetailProfiles = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var PROFILES = {
  w: {
    key: 'w', fam: 'w',
    displayName: 'W BRAND', reportPrefix: 'W BRAND \u2014 ',
    brands: ['W', 'WI', 'FS', 'HO', 'WISHFUL', 'FOLKSONG', 'W BRAND', 'WFORWOMAN'],
    domain: 'wforwoman.com',
    search: 'https://www.wforwoman.com/pages/search?q=',
    freeCodes: ['WFS', 'FS'],
    dualSizeColumns: false
  },
  aurelia: {
    key: 'aurelia', fam: 'au',
    displayName: 'AURELIA', reportPrefix: 'AURELIA \u2014 ',
    brands: ['AU', 'EL', 'AURELIA', 'ELLEVEN', 'SHOPFORAURELIA'],
    domain: 'shopforaurelia.com',
    search: 'https://www.shopforaurelia.com/pages/search?q=',
    freeCodes: ['WFS', 'FS'],
    dualSizeColumns: false
  },
  jaypore: {
    key: 'jaypore', fam: 'jp',
    displayName: 'JAYPORE', reportPrefix: 'JAYPORE \u2014 ',
    brands: [],                       /* no brand column in Jaypore SOH */
    domain: 'jaypore.com',
    search: 'https://www.jaypore.com/c/search?search_query=',
    searchSuffix: '&page=1&hs=main',
    freeCodes: ['FS', 'WFS', ''],     /* blank size = free (sarees, dupattas, jewellery) */
    dualSizeColumns: true             /* Size (resolved) + Size Grid (raw) in reports */
  },
  unknown: {
    key: 'unknown', fam: 'un',
    displayName: '', reportPrefix: '',
    brands: [], domain: '', search: null,
    freeCodes: ['WFS', 'FS'],
    dualSizeColumns: false
  }
};

/* brand code -> profile (built once) */
var BRAND_TO_PROFILE = {};
Object.keys(PROFILES).forEach(function (k) {
  PROFILES[k].brands.forEach(function (b) { BRAND_TO_PROFILE[b] = PROFILES[k]; });
});

function get (houseOrFam) {
  var k = String(houseOrFam || '').toLowerCase();
  if (PROFILES[k]) return PROFILES[k];
  for (var p in PROFILES) if (PROFILES[p].fam === k) return PROFILES[p];
  return PROFILES.unknown;
}
function familyOfBrand (brandCode) {
  var p = BRAND_TO_PROFILE[String(brandCode || '').trim().toUpperCase()];
  return p ? p.fam : 'un';
}
function searchUrl (houseOrFam, style) {
  var p = get(houseOrFam);
  if (!p.search) return '';
  return p.search + encodeURIComponent(style) + (p.searchSuffix || '');
}
function domain (houseOrFam) { return get(houseOrFam).domain || ''; }
function routable () {
  return Object.keys(PROFILES)
    .map(function (k) { return PROFILES[k]; })
    .filter(function (p) { return !!p.search; })
    .map(function (p) { return { fam: p.fam, key: p.key, domain: p.domain }; });
}

/* ---------- size ordering (shared canonical) ---------- */
var SIZE_ORDER = ['XXS','XS','S','S-M','S/M','M','M-L','M/L','L','L-XL','L/XL',
                  'XL','XL-XXL','XXL','XXXL','2XL','3XL','4XL','5XL','6XL','7XL','8XL',
                  'PS','PM','PL','PLUS'];
var SIZE_IDX = {};
SIZE_ORDER.forEach(function (s, i) { SIZE_IDX[s] = i; });

function sizeSortKey (houseOrFam, size) {
  var p = get(houseOrFam);
  var s = String(size || '').trim().toUpperCase();
  if (s === '' || p.freeCodes.indexOf(s) !== -1) return 9000;      /* free size last */
  if (SIZE_IDX[s] !== undefined) return SIZE_IDX[s];
  var m;
  if ((m = s.match(/^EU[- ]?(\d{2})$/)))  return 2000 + (+m[1]);
  if ((m = s.match(/^UK[- ]?(\d{1,2})$/))) return 2500 + (+m[1]);
  if ((m = s.match(/^US[- ]?(\d{1,2})$/))) return 2600 + (+m[1]);
  if ((m = s.match(/^\d{1,3}(\.\d)?$/)))   return 1000 + parseFloat(s);
  return 5000 + (s.charCodeAt(0) || 0);                            /* stable-ish tail */
}

return { get: get, familyOfBrand: familyOfBrand, searchUrl: searchUrl,
         domain: domain, routable: routable, sizeSortKey: sizeSortKey,
         PROFILES: PROFILES, SIZE_ORDER: SIZE_ORDER };
}));

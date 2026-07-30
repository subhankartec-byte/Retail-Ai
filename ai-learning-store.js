/* ============================================================
   ai-learning-store.js — Retail AI · Universal AI Pipeline,
   Stage 8 (Learning)
   ------------------------------------------------------------
   Pure JS, zero dependencies. Browser: window.AILearningStore.
   Node (tests): module.exports.

   WHAT THIS FILE IS
   ------------------------------------------------------------
   A small, storage-provider-agnostic key/value store for things
   the platform has LEARNED and a human has VALIDATED — a
   retailer's style-code shape signature, a confirmed column
   mapping, a brand-column code extension. Every record carries
   {value, confidence, source, timestamp, validated} — never just
   a bare value — so a caller can always tell not just WHAT was
   learned but how much to trust it and where it came from.

   Never allow a single AI guess to become trusted automatically:
   this store has no "write straight from an AI response" path.
   record() takes a `validated` flag explicitly; callers decide
   when something is trustworthy enough to persist (typically:
   a human accepted it via the existing manual-confirm UI, or a
   deterministic rule/high-confidence brand-column match produced
   it directly). AI-only, unconfirmed suggestions belong in
   memory/UI state, never in this store.

   STORAGE ABSTRACTION
   ------------------------------------------------------------
   Every operation goes through a `provider` — an object with
   {get(key), set(key, value), remove(key), keys(prefix)}. Only
   ONE provider is used at a time; migrating from localStorage to
   Firestore (or anything else) later means writing one new
   provider object with that same four-method shape and changing
   the single `use()` call site — nothing in this file, and
   nothing in any of its callers (retail-intelligence.js,
   ai-pipeline.js), needs to change.

   RECORD SHAPE
   ------------------------------------------------------------
   {
     value:      any,                 // the learned thing itself
     confidence: number,               // 0-1, how sure we are
     source:     'brand-column'|'header-fingerprint'|'manual-confirm'|'ai',
     timestamp:  string (ISO),
     validated:  boolean               // true only once a human or a
                                        // deterministic rule confirmed it
   }
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AILearningStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var LS_PREFIX = 'retailai.learn.v1.';

/* ---------- default provider: localStorage ---------- */
var localStorageProvider = {
  get: function (key) {
    try {
      if (typeof localStorage === 'undefined') return null;
      var raw = localStorage.getItem(LS_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },
  set: function (key, value) {
    try {
      if (typeof localStorage === 'undefined') return false;
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  },
  remove: function (key) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.removeItem(LS_PREFIX + key);
    } catch (e) {}
  },
  keys: function (prefix) {
    try {
      if (typeof localStorage === 'undefined') return [];
      var out = [];
      var full = LS_PREFIX + (prefix || '');
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(full) === 0) out.push(k.slice(LS_PREFIX.length));
      }
      return out;
    } catch (e) { return []; }
  }
};

var currentProvider = localStorageProvider;

/* use(provider) — swap the storage backend. A future Firestore
   provider implements the same four methods (get/set/remove/keys
   — async-returning promises is fine too, every call site here
   already tolerates a provider returning either a value or a
   Promise, since callers use the result with `await`/`.then`-
   agnostic plain access only where the default sync provider is
   in play; a promise-based provider is a valid future upgrade
   that would additionally need call sites to `await` — documented
   here rather than silently assumed). */
function use(provider) {
  if (provider && typeof provider.get === 'function' && typeof provider.set === 'function') {
    currentProvider = provider;
  }
}
function reset() { currentProvider = localStorageProvider; }

/* ---------- key namespacing ---------- */
/* kind: 'retailerSignature' | 'columnMapping' | 'brandCode' | ... —
   caller-defined, this store doesn't enumerate kinds itself. */
function keyOf(kind, key) { return kind + '.' + key; }

/* ---------- public API ---------- */
function get(kind, key) {
  return currentProvider.get(keyOf(kind, key));
}

/* record(kind, key, value, meta) — the only write path.
   meta.validated must be explicitly true for anything an AI
   produced on its own; a deterministic rule match (e.g. Layer 2's
   brand-column majority vote) may set validated:true directly,
   since it's not a guess. */
function record(kind, key, value, meta) {
  meta = meta || {};
  var entry = {
    value: value,
    confidence: typeof meta.confidence === 'number' ? Math.max(0, Math.min(1, meta.confidence)) : 0,
    source: meta.source || 'unknown',
    timestamp: new Date().toISOString(),
    validated: meta.validated === true
  };
  return currentProvider.set(keyOf(kind, key), entry) ? entry : null;
}

function forget(kind, key) { currentProvider.remove(keyOf(kind, key)); }

/* list(kind) -> [{key, ...record}] — every stored entry of one
   kind. Used by Layer 1's matcher to scan learned signatures. */
function list(kind) {
  var keys = currentProvider.keys(kind + '.');
  return keys.map(function (k) {
    var entry = currentProvider.get(k);
    return entry ? Object.assign({ key: k.slice((kind + '.').length) }, entry) : null;
  }).filter(Boolean);
}

/* recordIfBetter — convenience for the common "only overwrite a
   learned signature if this is more confident, or the existing
   one was never validated" pattern, so callers don't each
   reimplement the comparison. */
function recordIfBetter(kind, key, value, meta) {
  var existing = get(kind, key);
  if (existing && existing.validated && (existing.confidence || 0) >= (meta && meta.confidence || 0)) {
    return existing;   // keep the stronger, already-validated entry
  }
  return record(kind, key, value, meta);
}

return {
  use: use, reset: reset,
  get: get, record: record, recordIfBetter: recordIfBetter, forget: forget, list: list,
  LS_PREFIX: LS_PREFIX
};
}));

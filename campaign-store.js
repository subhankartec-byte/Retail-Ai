/* =========================================================
   campaign-store.js — Retail AI · Campaign Firestore data layer
   ---------------------------------------------------------
   The only file that talks to Firestore for the AI Customer
   Campaign Builder's manager/staff split-and-share feature.
   Schema (see firestore.rules for the matching security model):

     campaigns/{campaignId}
       ownerId, retailer, store, messageTemplate, createdAt,
       campaignExpiresAt, status: "active"|"completed"|"revoked"
       Readable/writable only by its owner (the signed-in manager).

     campaigns/{campaignId}/assignments/{token}
       One doc per staff split. `token` (the document ID) is a
       client-generated, cryptographically random string — the
       ONLY credential a staff member needs. `messageTemplate` is
       duplicated here (not read from the parent campaign doc) so
       an unauthenticated staff device never needs campaign-level
       read access at all.
       label, active, createdAt, expiresAt, messageTemplate

     campaigns/{campaignId}/assignments/{token}/customers/{idx}
       idx, name, sal, local, e164, valid, sets[], kurtas[],
       mobileStatus: "pending"|"completed"|"skipped"|"failed",
       updatedAt
       Staff may update ONLY mobileStatus/updatedAt on a doc they
       can already read (enforced by firestore.rules, not just by
       this file being the only caller).

   Every write here is additive to the platform: nothing in this
   file touches users/{uid} (auth-guard.js's domain) or any other
   existing collection.
   ========================================================= */
import { db, auth } from "./firebase.js";
import {
  collection, doc, setDoc, getDoc, getDocs, updateDoc,
  onSnapshot, serverTimestamp, writeBatch, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h, per product requirement
const WRITE_CHUNK = 400; // stay well under Firestore's 500-write batch cap

function mkToken() {
  var bytes = new Uint8Array(16);
  (crypto || window.crypto).getRandomValues(bytes);
  var bin = "";
  bytes.forEach(function (b) { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function requireUser() {
  var user = auth.currentUser;
  if (!user) throw new Error("not-signed-in");
  return user;
}

function pickOnly(p) { return { code: p.code || "", name: p.name || "", link: p.link || "" }; }

/* ---------- campaigns ---------- */

async function createCampaign(meta) {
  var user = requireUser();
  var ref = doc(collection(db, "campaigns"));
  await setDoc(ref, {
    ownerId: user.uid,
    retailer: (meta && meta.retailer) || "",
    store: (meta && meta.store) || "",
    messageTemplate: (meta && meta.messageTemplate) || {},
    createdAt: serverTimestamp(),
    campaignExpiresAt: (meta && meta.campaignExpiresAt) || null,
    status: "active"
  });
  return ref.id;
}

async function setCampaignStatus(campaignId, status) {
  requireUser();
  await updateDoc(doc(db, "campaigns", campaignId), { status: status });
}

/* ---------- assignments (splits) ---------- */

async function writeCustomers(campaignId, token, customers) {
  for (var start = 0; start < customers.length; start += WRITE_CHUNK) {
    var batch = writeBatch(db);
    customers.slice(start, start + WRITE_CHUNK).forEach(function (c, i) {
      var idx = start + i;
      var ref = doc(db, "campaigns", campaignId, "assignments", token, "customers", String(idx));
      batch.set(ref, {
        idx: idx,
        name: c.name || "", sal: c.sal || "", local: c.local || "", e164: c.e164 || "", valid: !!c.valid,
        sets: (c.sets || []).map(pickOnly), kurtas: (c.kurtas || []).map(pickOnly),
        mobileStatus: c.mobileStatus || "pending",
        updatedAt: serverTimestamp()
      });
    });
    await batch.commit();
  }
}

async function createAssignment(campaignId, opts) {
  requireUser();
  var token = mkToken();
  var ttlMs = (opts && opts.ttlMs) || DEFAULT_TTL_MS;
  var aRef = doc(db, "campaigns", campaignId, "assignments", token);
  await setDoc(aRef, {
    label: (opts && opts.label) || "",
    active: true,
    createdAt: serverTimestamp(),
    expiresAt: new Date(Date.now() + ttlMs),
    messageTemplate: (opts && opts.messageTemplate) || {}
  });
  await writeCustomers(campaignId, token, (opts && opts.customers) || []);
  return { token: token };
}

async function revokeAssignment(campaignId, token) {
  requireUser();
  await updateDoc(doc(db, "campaigns", campaignId, "assignments", token), { active: false });
}

/* Creates a fresh, unrelated link for the same split, preserving
   every customer's current progress, then kills the old link
   immediately. The old URL becomes a dead string — nothing about
   the new token can be derived from it. */
async function regenerateAssignment(campaignId, oldToken) {
  requireUser();
  var oldMetaSnap = await getDoc(doc(db, "campaigns", campaignId, "assignments", oldToken));
  var oldMeta = oldMetaSnap.exists() ? oldMetaSnap.data() : {};
  var customers = await listCustomers(campaignId, oldToken);
  var fresh = await createAssignment(campaignId, {
    label: oldMeta.label || "",
    customers: customers,
    messageTemplate: oldMeta.messageTemplate || {}
  });
  await revokeAssignment(campaignId, oldToken);
  return fresh;
}

async function listAssignments(campaignId) {
  requireUser();
  var snap = await getDocs(collection(db, "campaigns", campaignId, "assignments"));
  return snap.docs.map(function (d) { return Object.assign({ token: d.id }, d.data()); });
}

/* Ends every split in a campaign at once ("Expire campaign"). */
async function endCampaign(campaignId, status) {
  requireUser();
  var assignments = await listAssignments(campaignId);
  await Promise.all(assignments.map(function (a) { return revokeAssignment(campaignId, a.token); }));
  await setCampaignStatus(campaignId, status || "completed");
}

/* Moves every still-pending customer from one split to another,
   deleting them from the source so its own stats/remaining count
   stay accurate. Returns how many customers moved. */
async function reassignPending(campaignId, fromToken, toToken) {
  requireUser();
  var fromCustomers = await listCustomers(campaignId, fromToken);
  var pending = fromCustomers.filter(function (c) { return c.mobileStatus === "pending"; });
  if (!pending.length) return 0;
  var toCustomers = await listCustomers(campaignId, toToken);
  var nextIdx = toCustomers.length ? (Math.max.apply(null, toCustomers.map(function (c) { return c.idx; })) + 1) : 0;
  var batch = writeBatch(db);
  pending.forEach(function (c, i) {
    var newRef = doc(db, "campaigns", campaignId, "assignments", toToken, "customers", String(nextIdx + i));
    batch.set(newRef, {
      idx: nextIdx + i, name: c.name, sal: c.sal, local: c.local, e164: c.e164, valid: c.valid,
      sets: c.sets, kurtas: c.kurtas, mobileStatus: "pending", updatedAt: serverTimestamp()
    });
    var oldRef = doc(db, "campaigns", campaignId, "assignments", fromToken, "customers", String(c.idx));
    batch.delete(oldRef);
  });
  await batch.commit();
  return pending.length;
}

/* Owner or an active/unexpired token holder — Firestore rules
   enforce this, this function just surfaces "no access" as null
   instead of throwing, so callers can show one clean message for
   not-found / expired / revoked alike. */
async function getAssignmentMeta(campaignId, token) {
  try {
    var snap = await getDoc(doc(db, "campaigns", campaignId, "assignments", token));
    if (!snap.exists()) return null;
    return Object.assign({ token: token }, snap.data());
  } catch (e) {
    return null;
  }
}

function watchAssignmentMeta(campaignId, token, callback) {
  return onSnapshot(
    doc(db, "campaigns", campaignId, "assignments", token),
    function (snap) { callback(snap.exists() ? Object.assign({ token: token }, snap.data()) : null); },
    function () { callback(null); }
  );
}

/* ---------- customers ---------- */

async function listCustomers(campaignId, token) {
  var q = query(collection(db, "campaigns", campaignId, "assignments", token, "customers"), orderBy("idx"));
  var snap = await getDocs(q);
  return snap.docs.map(function (d) { return d.data(); });
}

function watchCustomers(campaignId, token, callback) {
  var q = query(collection(db, "campaigns", campaignId, "assignments", token, "customers"), orderBy("idx"));
  return onSnapshot(
    q,
    function (snap) { callback(snap.docs.map(function (d) { return d.data(); })); },
    function () { callback(null); } // permission-denied -> caller treats like "link no longer valid"
  );
}

async function updateCustomerStatus(campaignId, token, idx, status) {
  await updateDoc(
    doc(db, "campaigns", campaignId, "assignments", token, "customers", String(idx)),
    { mobileStatus: status, updatedAt: serverTimestamp() }
  );
}

window.CampaignStore = {
  createCampaign: createCampaign,
  setCampaignStatus: setCampaignStatus,
  createAssignment: createAssignment,
  revokeAssignment: revokeAssignment,
  regenerateAssignment: regenerateAssignment,
  listAssignments: listAssignments,
  endCampaign: endCampaign,
  reassignPending: reassignPending,
  getAssignmentMeta: getAssignmentMeta,
  watchAssignmentMeta: watchAssignmentMeta,
  listCustomers: listCustomers,
  watchCustomers: watchCustomers,
  updateCustomerStatus: updateCustomerStatus,
  isSignedIn: function () { return !!auth.currentUser; }
};

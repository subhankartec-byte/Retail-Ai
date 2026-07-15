/* =========================================================
   auth-guard.js — Retail AI · auth, profile, gating, quota
   ---------------------------------------------------------
   Include ONE line before </body> on EVERY page:

       <script type="module" src="auth-guard.js"></script>

   Behaviour by page type:

   PUBLIC  (index / login / signup / forgot-password)
     - never redirects; the landing page stays browsable
     - signed out : every feature control is gated -> login
     - signed in  : Login->Logout, Get Started->Open Tools,
                    Free plan shows "Free Plan (Active)",
                    profile card bottom-left

   PROTECTED (every tool page)
     - signed out : remembers the page, redirects to login
     - signed in  : profile card + logout + report quota

   Free plan quota: 10 reports/day, 30 reports/month.
   Counters live in Firestore users/{uid}.usage and reset
   automatically when the date / month rolls over.

   NOTE: quota is enforced client-side and is therefore a
   fair-use guard, not a security boundary. Real enforcement
   needs server-side code (Cloud Functions).
   ========================================================= */
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

/* ---------- config ---------- */
const DAILY_LIMIT   = 10;
const MONTHLY_LIMIT = 30;

const PAGE = (location.pathname.split("/").pop() || "index.html").toLowerCase();
const PUBLIC_PAGES = new Set([
  "", "index.html", "login.html", "signup.html", "forgot-password.html"
]);
const IS_PUBLIC   = PUBLIC_PAGES.has(PAGE);
const IS_AUTHPAGE = PAGE === "login.html" || PAGE === "signup.html" || PAGE === "forgot-password.html";

/* ---------- state ---------- */
let currentUser    = null;
let currentProfile = null;
let usageCache     = null;   // { day, dayCount, month, monthCount }
let quotaInstalled = false;

/* ---------- small helpers ---------- */
const todayKey = () => new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
const monthKey = () => new Date().toISOString().slice(0, 7);    // YYYY-MM

function onReady(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

function displayName(user, profile) {
  const n = (profile && (profile.fullName || profile.name)) || user.displayName;
  if (n && String(n).trim()) return String(n).trim();
  return (user.email || "User").split("@")[0];
}

/* =========================================================
   1. Auth state
   ========================================================= */
onAuthStateChanged(auth, async (user) => {
  currentUser = user;

  if (!user) {
    if (!IS_PUBLIC) {
      try {
        sessionStorage.setItem(
          "redirectAfterLogin",
          (location.pathname.split("/").pop() || "index.html") + location.search
        );
      } catch (e) { /* storage unavailable */ }
      location.replace("login.html");
      return;
    }
    removeProfileCard();
    onReady(applySignedOutUI);
    return;
  }

  currentProfile = await loadProfile(user);

  if (currentProfile && currentProfile.approved === false) {
    onReady(() => showToast(
      "Account pending approval",
      "Your account is awaiting approval. Please contact your administrator."
    ));
    if (!IS_PUBLIC) { location.replace("index.html"); return; }
  }

  onReady(() => {
    renderProfileCard(user, currentProfile);
    applySignedInUI();
  });

  if (!IS_PUBLIC) installDownloadQuota();
});

/* =========================================================
   2. Profile in Firestore
   ========================================================= */
async function loadProfile(user) {
  const ref = doc(db, "users", user.uid);
  try {
    const snap = await Promise.race([
      getDoc(ref),
      new Promise((res) => setTimeout(() => res(null), 5000))
    ]);

    if (snap && snap.exists && snap.exists()) {
      const data = snap.data() || {};
      if (data.approved === undefined || data.plan === undefined) {
        const patch = {};
        if (data.approved === undefined) patch.approved = true;
        if (data.plan === undefined) patch.plan = "free";
        setDoc(ref, patch, { merge: true }).catch(() => {});
        Object.assign(data, patch);
      }
      usageCache = normaliseUsage(data.usage);
      return data;
    }

    /* No profile doc yet (e.g. account created before Firestore
       existed) — create a sane default so the UI is correct. */
    const fresh = {
      email: user.email || "",
      fullName: user.displayName || "",
      plan: "free",
      approved: true,
      role: "employee"
    };
    setDoc(ref, fresh, { merge: true }).catch(() => {});
    usageCache = normaliseUsage(null);
    return fresh;
  } catch (e) {
    console.warn("Profile load failed:", e);
    usageCache = normaliseUsage(null);
    return { plan: "free", approved: true, email: user.email || "" };
  }
}

function normaliseUsage(u) {
  const day = todayKey(), month = monthKey();
  if (!u || typeof u !== "object") return { day, dayCount: 0, month, monthCount: 0 };
  return {
    day,
    dayCount:   u.day === day ? (Number(u.dayCount) || 0) : 0,
    month,
    monthCount: u.month === month ? (Number(u.monthCount) || 0) : 0
  };
}

/* =========================================================
   3. Report quota
   ========================================================= */
function isPremium() {
  const p = currentProfile && String(currentProfile.plan || "free").toLowerCase();
  return p === "premium" || p === "pro" || p === "business";
}

/* Synchronous check against the cache — download hooks are sync. */
function quotaBlocked() {
  if (isPremium()) return null;
  if (!usageCache) return null;                       // fail open
  const u = normaliseUsage(usageCache);
  usageCache = u;
  if (u.dayCount >= DAILY_LIMIT) {
    return "You've used all " + DAILY_LIMIT + " reports for today. " +
           "Upgrade to Premium or wait until tomorrow.";
  }
  if (u.monthCount >= MONTHLY_LIMIT) {
    return "You've used all " + MONTHLY_LIMIT + " reports this month. " +
           "Upgrade to Premium or wait until your quota resets.";
  }
  return null;
}

function countReport() {
  if (isPremium() || !currentUser || !usageCache) return;
  const u = normaliseUsage(usageCache);
  u.dayCount   += 1;
  u.monthCount += 1;
  usageCache = u;
  setDoc(doc(db, "users", currentUser.uid), { usage: u }, { merge: true }).catch(() => {});
  updateProfileCardUsage();
}

function installDownloadQuota() {
  if (quotaInstalled) return;
  quotaInstalled = true;

  /* a) <a download> — the main path used by every tool */
  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute && this.hasAttribute("download")) {
      const msg = quotaBlocked();
      if (msg) { showToast("Free plan limit reached", msg); return; }
      countReport();
    }
    return nativeClick.apply(this, arguments);
  };

  /* b) real user clicks on <a download> links already in the DOM */
  document.addEventListener("click", (ev) => {
    const a = ev.target && ev.target.closest && ev.target.closest("a[download]");
    if (!a) return;
    const msg = quotaBlocked();
    if (msg) {
      ev.preventDefault();
      ev.stopPropagation();
      showToast("Free plan limit reached", msg);
      return;
    }
    countReport();
  }, true);

  /* c) legacy msSaveBlob / msSaveOrOpenBlob fallbacks */
  ["msSaveBlob", "msSaveOrOpenBlob"].forEach((fn) => {
    if (typeof navigator[fn] === "function") {
      const orig = navigator[fn].bind(navigator);
      navigator[fn] = function () {
        const msg = quotaBlocked();
        if (msg) { showToast("Free plan limit reached", msg); return false; }
        countReport();
        return orig.apply(null, arguments);
      };
    }
  });
}

/* =========================================================
   4. Gating — signed-out visitors can browse, not use
   ========================================================= */
const TOOL_PAGE_RE = /\.html($|[?#])/i;

function isFeatureControl(el) {
  if (!el) return false;
  if (el.closest("[data-logout], #logoutBtn, #ra-profile-card")) return false;

  /* Auth links are how you sign in — never gate them. */
  const href = el.getAttribute && el.getAttribute("href");
  if (href && /^(login|signup|forgot-password)\.html/i.test(href)) return false;

  if (el.matches(".tool-btn, [data-coming-soon], [data-requires-auth]")) return true;

  /* Any link that opens another page of the app (a tool). */
  if (href && TOOL_PAGE_RE.test(href) && !/^https?:/i.test(href)) return true;

  return false;
}

document.addEventListener("click", (ev) => {
  if (currentUser) return;              // signed in — normal behaviour
  if (IS_AUTHPAGE) return;              // never gate the auth pages

  const el = ev.target && ev.target.closest
    ? ev.target.closest("a, button, .tool-btn, [data-coming-soon]")
    : null;
  if (!isFeatureControl(el)) return;

  ev.preventDefault();
  ev.stopPropagation();

  let target = "index.html";
  const href = el.getAttribute("href");
  if (href && TOOL_PAGE_RE.test(href) && !/^https?:/i.test(href)) target = href;
  try { sessionStorage.setItem("redirectAfterLogin", target); } catch (e) {}
  location.href = "login.html";
}, true);   // capture phase: runs before the page's own handlers

/* =========================================================
   5. Signed-in / signed-out UI on the landing page
   ========================================================= */
function applySignedInUI() {
  document.querySelectorAll('a[href="login.html"]').forEach((link) => {
    if (link.dataset.raBound) return;
    link.dataset.raBound = "1";
    link.textContent = "Logout";
    link.setAttribute("href", "#");
    link.setAttribute("data-logout", "");
  });

  document.querySelectorAll('a[href="signup.html"]').forEach((btn) => {
    btn.textContent = "Open Tools";
    btn.setAttribute("href", "#tools");
  });

  /* Free plan is live for signed-in users — no "coming soon". */
  document.querySelectorAll("[data-free-cta]").forEach((el) => {
    el.textContent = "Free Plan (Active)";
    el.removeAttribute("data-coming-soon");
    el.setAttribute("href", "#tools");
    el.setAttribute("aria-disabled", "false");
  });
}

function applySignedOutUI() {
  document.querySelectorAll("[data-free-cta]").forEach((el) => {
    el.textContent = "Start Free";
    el.removeAttribute("data-coming-soon");
    el.setAttribute("href", "signup.html");
  });
}

/* =========================================================
   6. Profile card (bottom-left)
   ========================================================= */
function removeProfileCard() {
  const el = document.getElementById("ra-profile-card");
  if (el) el.remove();
}

function planLabel() {
  return isPremium() ? "Premium" : "Free Plan (Active)";
}

function usageLabel() {
  if (isPremium() || !usageCache) return "";
  const u = normaliseUsage(usageCache);
  return u.dayCount + "/" + DAILY_LIMIT + " today · " +
         u.monthCount + "/" + MONTHLY_LIMIT + " this month";
}

function updateProfileCardUsage() {
  const el = document.getElementById("ra-profile-usage");
  if (el) el.textContent = usageLabel();
}

function renderProfileCard(user, profile) {
  removeProfileCard();

  const name = displayName(user, profile);
  const card = document.createElement("div");
  card.id = "ra-profile-card";
  card.style.cssText =
    "position:fixed;left:16px;bottom:16px;z-index:2147483000;" +
    "display:flex;align-items:center;gap:11px;" +
    "background:rgba(10,22,51,.96);border:1px solid rgba(212,175,55,.42);" +
    "border-radius:14px;padding:10px 14px;max-width:290px;" +
    "box-shadow:0 8px 26px rgba(0,0,0,.45);" +
    "font-family:Inter,system-ui,-apple-system,sans-serif;" +
    "backdrop-filter:blur(8px)";

  const avatar = document.createElement("div");
  avatar.textContent = (name[0] || "U").toUpperCase();
  avatar.style.cssText =
    "flex:0 0 auto;width:36px;height:36px;border-radius:50%;" +
    "display:flex;align-items:center;justify-content:center;" +
    "background:linear-gradient(135deg,#F2DE9A 0%,#D4AF37 44%,#B8912F 100%);" +
    "color:#0A1633;font-weight:700;font-size:15px;letter-spacing:.02em";

  const text = document.createElement("div");
  text.style.cssText = "min-width:0;line-height:1.32";
  text.innerHTML =
    '<div style="color:#F4F6FB;font-weight:600;font-size:13px;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>' +
    '<div style="color:#9BA7C4;font-size:11px;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>' +
    '<div style="color:#D4AF37;font-size:11px;font-weight:600;margin-top:2px"></div>' +
    '<div id="ra-profile-usage" style="color:#7C89A8;font-size:10px"></div>';
  text.children[0].textContent = name;
  text.children[1].textContent = user.email || "";
  text.children[2].textContent = planLabel();
  text.children[3].textContent = usageLabel();

  const out = document.createElement("button");
  out.type = "button";
  out.setAttribute("data-logout", "");
  out.title = "Log out";
  out.textContent = "⏻";
  out.style.cssText =
    "flex:0 0 auto;margin-left:2px;background:transparent;color:#9BA7C4;" +
    "border:1px solid rgba(155,167,196,.34);border-radius:8px;" +
    "width:28px;height:28px;cursor:pointer;font-size:13px;line-height:1";

  card.appendChild(avatar);
  card.appendChild(text);
  card.appendChild(out);
  document.body.appendChild(card);
}

/* =========================================================
   7. Toast
   ========================================================= */
function showToast(title, body) {
  const old = document.getElementById("ra-toast");
  if (old) old.remove();

  const t = document.createElement("div");
  t.id = "ra-toast";
  t.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);bottom:24px;" +
    "z-index:2147483001;max-width:min(420px,92vw);" +
    "background:rgba(10,22,51,.98);border:1px solid rgba(212,175,55,.5);" +
    "border-radius:12px;padding:13px 17px;" +
    "box-shadow:0 10px 30px rgba(0,0,0,.5);" +
    "font-family:Inter,system-ui,-apple-system,sans-serif";
  t.innerHTML =
    '<div style="color:#D4AF37;font-weight:700;font-size:13px;margin-bottom:3px"></div>' +
    '<div style="color:#C9D2E6;font-size:12px;line-height:1.45"></div>';
  t.children[0].textContent = title;
  t.children[1].textContent = body;
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 6000);
}

/* =========================================================
   8. Logout
   ========================================================= */
export async function logout() {
  try {
    await signOut(auth);
  } catch (e) {
    console.warn("Sign-out error:", e);
  } finally {
    location.replace(IS_PUBLIC ? "index.html" : "login.html");
  }
}

window.logout = logout;

document.addEventListener("click", (event) => {
  const trigger = event.target.closest && event.target.closest("[data-logout], #logoutBtn");
  if (!trigger) return;
  event.preventDefault();
  event.stopPropagation();
  logout();
}, true);

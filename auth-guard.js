/* =========================================================
   auth-guard.js — Retail AI · protected-page guard + logout
   ---------------------------------------------------------
   Include on every page that requires sign-in (index.html
   and any tool page). Add ONE line before </body>:

       <script type="module" src="auth-guard.js"></script>

   What it does:
   1. If the visitor is NOT signed in → remembers which page
      they wanted (sessionStorage, UX only — never auth) and
      redirects to login.html. Auth state itself lives ONLY
      inside Firebase Authentication.
   2. Provides a reusable logout() function. Any element with
      a data-logout attribute (or id="logoutBtn") becomes a
      working logout button automatically:

          <button data-logout>Logout</button>

      You can also call window.logout() from anywhere.
   ========================================================= */
import { auth } from "./firebase.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";

/* ---------- 1. Guard: signed-out visitors go to login ---------- */
onAuthStateChanged(auth, (user) => {
  if (user) {
    injectLogoutChip(); // signed in — page loads normally + Logout button
    return;
  }

  try {
    const here = (location.pathname.split("/").pop() || "index.html") + location.search;
    sessionStorage.setItem("redirectAfterLogin", here);
  } catch (e) { /* storage unavailable — ignore */ }

  location.replace("login.html");
});

/* ---------- 1b. Floating Logout chip on protected pages ---------- */
function injectLogoutChip() {
  const make = () => {
    if (document.getElementById("ra-logout-chip")) return;
    const btn = document.createElement("button");
    btn.id = "ra-logout-chip";
    btn.setAttribute("data-logout", "");
    btn.type = "button";
    btn.textContent = "Logout";
    btn.style.cssText =
      "position:fixed;bottom:18px;right:18px;z-index:2147483000;" +
      "background:#0A1633;color:#D4AF37;border:1px solid rgba(212,175,55,.55);" +
      "border-radius:999px;padding:10px 20px;font:600 14px/1 Inter,system-ui,sans-serif;" +
      "cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.4);letter-spacing:.02em";
    document.body.appendChild(btn);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", make);
  } else {
    make();
  }
}

/* ---------- 2. Reusable logout ---------- */
export async function logout() {
  try {
    await signOut(auth);
  } catch (e) {
    console.warn("Sign-out error:", e);
  } finally {
    location.replace("login.html");
  }
}

/* Expose globally so inline onclick="logout()" also works */
window.logout = logout;

/* Auto-wire any logout trigger on the page */
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-logout], #logoutBtn");
  if (!trigger) return;
  event.preventDefault();
  logout();
});

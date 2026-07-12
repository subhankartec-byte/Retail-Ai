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
  if (user) return; // signed in — page may load normally

  try {
    const here = (location.pathname.split("/").pop() || "index.html") + location.search;
    sessionStorage.setItem("redirectAfterLogin", here);
  } catch (e) { /* storage unavailable — ignore */ }

  location.replace("login.html");
});

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

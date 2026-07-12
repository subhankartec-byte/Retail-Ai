/* =========================================================
   firebase.js — Retail AI · single shared Firebase module
   ---------------------------------------------------------
   Every page imports Firebase from THIS file only:

       import { auth, db } from "./firebase.js";

   Firebase is initialized exactly once, here and only here.
   Never call initializeApp() anywhere else.
   ========================================================= */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

/* Existing Retail AI Firebase configuration — unchanged. */
const firebaseConfig = {
  apiKey: "AIzaSyBOtg8GlsffmCdSlSLff1LjRIYOG2ApeHw",
  authDomain: "retail-ai-2c674.firebaseapp.com",
  projectId: "retail-ai-2c674",
  storageBucket: "retail-ai-2c674.firebasestorage.app",
  messagingSenderId: "459591695672",
  appId: "1:459591695672:web:f276e98941dc38924ad5cd",
  measurementId: "G-N9J4TPW3VF"
};

const app = initializeApp(firebaseConfig);

/* Shared singletons used across all pages */
export const auth = getAuth(app);
export const db   = getFirestore(app);

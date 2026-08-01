/* =========================================================
   campaign-ui.js — Retail AI · shared Campaign Runner helpers
   ---------------------------------------------------------
   Pure, stateless logic behind the "one customer at a time"
   WhatsApp campaign card: message templating, WhatsApp deep
   links, progress stats, ETA formatting, HTML escaping. Used by
   BOTH Smart_WhatsApp_Outreach.html (Mobile Campaign Mode) and
   the standalone staff campaign-runner page, so the message a
   customer receives and the WhatsApp link that sends it are
   built by exactly one implementation, not two.

   No DOM access, no Firestore, no globals besides window.CampaignUI
   — callers own their own rendering and state.
   ========================================================= */
(function (root) {
  "use strict";

  function str(v) { return v == null ? "" : String(v).trim(); }

  function escapeHtml(s) {
    return str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }
  function linkify(s) {
    return escapeHtml(s).replace(/(https?:\/\/[^\s]+)/g, function (m) {
      return '<a href="' + escapeAttr(m) + '" target="_blank" rel="noopener">' + m + "</a>";
    });
  }

  function fillPick(pickTmpl, p, n) {
    return str(pickTmpl)
      .replace(/\{n\}/g, n)
      .replace(/\{name\}/g, p.name)
      .replace(/\{code\}/g, p.code)
      .replace(/\{link\}/g, p.link);
  }

  /* tmpl: {main, pick, offer, store}. Byte-identical logic to this
     tool's original buildMessage()/fillPick() — only the source of
     each value moved from direct DOM reads to explicit parameters,
     so it runs the same on a page with no upload form (the staff
     runner) as on the manager tool. */
  function buildMessage(tmpl, name, sal, picks) {
    var pickTmpl = (tmpl && tmpl.pick) || "{n}) {name}: {link}";
    var block = picks.map(function (p, i) { return fillPick(pickTmpl, p, i + 1); }).join("\n");
    var offer = str(tmpl && tmpl.offer);
    var msg = str(tmpl && tmpl.main)
      .replace(/\{name\}/g, name || "there")
      .replace(/\{salutation\}/g, sal || "")
      .replace(/\{store\}/g, str(tmpl && tmpl.store) || "our store")
      .replace(/\{picks\}/g, block);
    if (offer) msg = msg.replace(/\{offer\}/g, offer);
    else msg = msg.replace(/[^\S\n]*\{offer\}[^\S\n]*/g, "");
    return msg.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /* Always wa.me / api.whatsapp.com / web.whatsapp.com — never a
     custom scheme — so the same link opens correctly on Android
     and iPhone alike. */
  function buildWaUrl(e164, message, endpoint) {
    var ep = endpoint || "web", t = encodeURIComponent(message);
    if (ep === "wa") return "https://wa.me/" + e164 + "?text=" + t;
    if (ep === "api") return "https://api.whatsapp.com/send?phone=" + e164 + "&text=" + t;
    return "https://web.whatsapp.com/send?phone=" + e164 + "&text=" + t;
  }

  /* True on Android/iPhone/iPad/iPod, false on desktop (Windows/Mac/
     Linux). Feature-detection-free by design — WhatsApp's own deep
     links are the only cross-platform-reliable signal, and UA
     sniffing here only chooses WHICH deep link family to use, never
     gates a feature outright. */
  function isMobileDevice() {
    var ua = (navigator.userAgent || navigator.vendor || "") + "";
    return /android/i.test(ua) || /iphone|ipad|ipod/i.test(ua);
  }

  /* Device-aware "Open WhatsApp" target, decided at click time (not
     baked into the stored template/export like buildWaUrl()):
     desktop -> WhatsApp Web (needs a logged-in browser session);
     Android/iPhone -> wa.me, which itself hands off to the installed
     app when present and falls back to WhatsApp Web/install prompt
     when it isn't — the graceful fallback Meta documents for wa.me,
     so no extra whatsapp:// scheme + timeout-detection hack is
     needed (those are unreliable in mobile Safari). */
  function deviceWaUrl(e164, message) {
    var t = encodeURIComponent(message);
    if (isMobileDevice()) return "https://wa.me/" + e164 + "?text=" + t;
    return "https://web.whatsapp.com/send?phone=" + e164 + "&text=" + t;
  }

  /* list items use `mobileStatus`: "pending"|"completed"|"skipped"|"failed" */
  function mcStats(list, completedTimes) {
    var completed = 0, skipped = 0, failed = 0;
    list.forEach(function (g) {
      if (g.mobileStatus === "completed") completed++;
      else if (g.mobileStatus === "skipped") skipped++;
      else if (g.mobileStatus === "failed") failed++;
    });
    var total = list.length, remaining = total - completed - skipped - failed;
    var pct = total ? Math.round((completed / total) * 100) : 0;
    var times = completedTimes || [];
    var avgMs = times.length ? (times.reduce(function (a, b) { return a + b; }, 0) / times.length) : null;
    var etaMs = avgMs != null ? avgMs * remaining : null;
    var resolvedRate = (completed + failed + skipped) ? Math.round((completed / (completed + failed + skipped)) * 100) : 100;
    var score = Math.max(0, Math.min(100, Math.round(pct * 0.7 + resolvedRate * 0.3)));
    return { total: total, completed: completed, skipped: skipped, failed: failed, remaining: remaining, pct: pct, etaMs: etaMs, score: score };
  }

  function mcFmtEta(ms) {
    if (ms == null) return "—";
    var mins = Math.round(ms / 60000);
    if (mins < 1) return "<1 min";
    if (mins < 60) return mins + " min";
    return Math.floor(mins / 60) + "h " + (mins % 60) + "m";
  }

  root.CampaignUI = {
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    linkify: linkify,
    buildMessage: buildMessage,
    buildWaUrl: buildWaUrl,
    isMobileDevice: isMobileDevice,
    deviceWaUrl: deviceWaUrl,
    mcStats: mcStats,
    mcFmtEta: mcFmtEta
  };
})(window);

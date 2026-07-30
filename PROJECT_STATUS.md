
# Retail AI — Project Status

- **Current Phase:** Preparing the first production deployment. Phase 6 (all 5 steps) and Phase 7 Steps A–D are **complete and LOCKED**. Step E (`api/chat.js`/`retail-chat.js`) is complete and wired into Store Review's Ask AI, still awaiting a separate design review/lock (unaffected by being wired in — see §7). Since Phase 7 closed, this session additionally completed: a homepage/UX polish pass (5 issues fixed — see §18.1), Universal Intelligence rolled out to 3 of 6 tools with a proven "confirm, never override" pattern (BlueDart → Inventory Validity Console → Store Review — see §18.2), a Platform Intelligence architectural audit, a data bridge connecting Store Review's Universal Intelligence result into its own Ask AI context (see §18.3), and a two-phase AI production-readiness certification that found the AI code itself sound but never verified against a real Gemini response, fixing two genuine deployment-readiness gaps (missing server-side logging when `GEMINI_API_KEY` is absent; missing `package.json`/`.vercelignore`) — see §18.4. **No AI feature in this codebase has ever completed a real round-trip to Gemini** — this remains the single largest gap before a confident production launch, unchanged by anything done this session; a full Live Gemini Test Plan is recorded at §18.5 for when a real key/deployment exists.
- **Latest Commit:** `44dac98` — "Phase 6 – Recommendation Card model + Inventory Audit / Stock IN-OUT". Everything described above is still uncommitted working-tree change as of this writing — see Repository Status.
- **Last Updated:** 2026-07-30
- **Repository Status:** `main` branch, 10 commits ahead of `origin/main`, **nothing pushed to GitHub yet**. Working tree changes beyond the untracked non-code paths: `SOH_Image_Link_Builder.html` (Phase 6.5 + UX-05 sample-data button), `BlueDart_Etail_Waybill_Builder1.html` (Phase 6.5b + Universal Intelligence), `Store_Review a1.html` (Ask AI → `retail-chat.js` wiring + Universal Intelligence + retailIntelligence context bridge), `Inventory_Validity_Console.html` (Universal Intelligence), `index.html` (UX-01/02/03/04 fixes: hero stat, testimonial attribution, missing Stock IN/OUT tool card, tool-naming consistency), `retail-schema.js`/`retail-intelligence.js` (Phase 7 A/B, **locked**), `api/map-schema.js`/`retail-assist.js` (Phase 7 Step C, **locked**, + AI-certification logging fix), `api/retail-knowledge.js`/`retail-knowledge.js` (Steps C/D, **locked**), `api/chat.js`/`retail-chat.js` (Step E, + AI-certification logging fix), `api/summarize.js` (AI-certification logging fix), `package.json`/`.vercelignore` (new — deployment readiness). Nothing has been committed this session; ask before committing.

> **How to use this document:** this is the single source of truth for a new Claude Code conversation picking up this project cold. Read it in full before touching any file. It documents what exists today, not aspirations — anything described as "planned" or "not yet built" must be treated as absent from the code.

---

## 1. Project Overview

### Vision
Retail AI is a suite of single-page, browser-only tools for store managers and area managers at an Indian multi-brand fashion retail operator (brand houses: **W**, **Aurelia**, **Jaypore** — see `retail-profiles.js`). Every tool lets a manager drop in a POS/SAP export (Excel/CSV) and get an instant, richly formatted business report — inventory validity, stock audits, sales review, courier waybills — entirely client-side, with no server-side data storage of the underlying business data.

The strategic direction (added in this conversation, Phases 5–6) is to evolve the platform from a set of **independent, single-purpose report generators** into a connected system that (a) adds AI-generated narrative insight on top of existing reports, and (b) correlates signals **across** tools into a single, prioritized "what needs my attention today" view for the store manager — the **Retail Decision Engine**.

### Business goals
- Reduce the time a manager spends reading dense spreadsheets by surfacing the 3–5 things that actually need action.
- Catch stock problems (shrinkage, broken size runs, mis-picks) before they become write-offs.
- Support staff coaching with objective, data-backed signals.
- Do all of this **without** becoming a data-harvesting platform: the existing product culture (see `retail-assist.js`, `api/map-schema.js`) is aggressively privacy-conscious — real transaction data essentially never leaves the browser, and where it does (AI features), it is masked or pre-aggregated and gated behind authentication.

### Current maturity
- **6 tools are live** and reachable from `index.html`. All are functional, independently field-tested products (not prototypes) with real prior usage (visible in git history predating this conversation).
- **Shared engineering foundation** (`retail-*.js`, `retail-theme.css`, `auth-guard.js`, `firebase.js`) was substantially unified across tools in Phases 1–4 of this conversation.
- **AI Executive Summary** (Phase 5) is implemented end-to-end but **not live-tested against the real Gemini API** — only up to the point where the request leaves the browser (see "AI Summary status" below).
- **Decision Engine** (Phase 6) is implemented and wired into **all 6 tools**: 4 primary, real-data-tested tools (Store Review, Inventory Validity Console, Inventory Audit, Stock IN/OUT Adjustment) drive `confidence` and the recommendation categories; 2 auxiliary/coverage-only tools (SOH Image Link Builder, BlueDart Waybill Builder) light up their status chip without affecting `confidence` or any category. Phase 6 (steps 1–5) is complete.

---

## 2. Repository Structure

```
Retail-Ai/
├── index.html                        Landing page + tool directory + Decision Engine panel
├── login.html / signup.html / forgot-password.html   Auth pages (Firebase)
├── privacy.html / terms.html         Legal pages
│
├── Store_Review a1.html              Tool: POS sales business review        [LIVE — linked from index.html]
├── Inventory_Validity_Console.html   Tool: SOH size-run validity            [LIVE]
├── Inventory_Audit_Toolf1.html       Tool: 3-way stock reconciliation       [LIVE]
├── Stock_IN_OUT_Adjustment.html      Tool: system-vs-physical barcode diff  [LIVE]
├── SOH_Image_Link_Builder.html       Tool: style+brand → product URL        [LIVE]
├── BlueDart_Etail_Waybill_Builder1.html  Tool: courier waybill builder      [LIVE]
│
├── firebase.js                       Single shared Firebase init (auth + Firestore)
├── auth-guard.js                     Auth gating, profile card, logout, free/premium quota
├── retail-import.js                  Universal SOH import engine (header/column detection, house detection)
├── retail-profiles.js                Brand-house data (W / Aurelia / Jaypore) + size ordering
├── retail-mapping.js                 Column-mapping confirmation modal + localStorage memory
├── retail-assist.js                  AI column-mapping assist (privacy-masked, calls api/map-schema.js)
├── retail-ui.js                      Shared drag-and-drop file-intake behavior
├── retail-theme.css                  Shared base CSS (box-sizing reset, spin keyframe — intentionally minimal)
├── retail-insights.js                AI Executive Summary client (calls api/summarize.js)
├── retail-decision.js                Cross-tool Decision Engine: storage + correlation logic
├── retail-schema.js                  AI Intelligence Core: canonical row model + tool adapters (Phase 7 Step A, LOCKED) — NOT wired into any tool yet
├── retail-intelligence.js            AI Intelligence Core: rule-tier file-type + retailer classification (Phase 7 Step B, LOCKED) — NOT wired into any tool yet
├── retail-knowledge.js               AI Intelligence Core: AI-tier orchestration — detectRetailer()/classifyFile() (Step C) + enrichItems() (Step D) — NOT wired into any tool yet
├── retail-chat.js                    AI Intelligence Core: context-aware AI Assistant client — ask() + 4 context builders (Phase 7 Step E) — NOT wired into any tool yet
│
├── api/
│   ├── map-schema.js                 Vercel fn: AI column-mapping (Gemini, Firebase-auth-gated) + task:'classify' (Phase 7 Step C, file-type only)
│   ├── retail-knowledge.js           Vercel fn: AI retailer detection (Gemini, Firebase-auth-gated) — task:'detect-retailer' (Step C) + task:'enrich-items' (Step D, Tier 2)
│   ├── chat.js                       Vercel fn: context-aware AI Assistant (Gemini, Firebase-auth-gated) — "experienced retail consultant" persona (Phase 7 Step E)
│   └── summarize.js                  Vercel fn: AI executive summary (Gemini, Firebase-auth-gated)
│
├── archive/                          Superseded file-fork duplicates, kept for history (see §11)
│   ├── BlueDart_Etail_Waybill_Builder(.html)
│   └── Store_Business_Review*.html, Store_Review1.html
│
├── .claude/launch.json                Local dev-server config (see §14 — path is session-specific, will need regenerating)
├── _test_data/                        Untracked scratch folder used for manual testing (see below)
└── README.md                          Single line: "# Retail-Ai" (not maintained — this file supersedes it as the real doc)
```

### Untracked / local-only paths (not committed, do not assume they exist in a fresh clone)
- **`.claude/launch.json`** — points a PowerShell static file server at a path inside `AppData\Local\Temp\claude\...\scratchpad\static-server.ps1`, which is **specific to the session that created it** and will not exist in a new conversation. A fresh session needing a local server should recreate this (see §14, "Local dev server").
- **`_test_data/`** — holds two real sample files used for testing in this conversation (`jaypore_soh.xls`, a genuine "JAYPORE ALL STORES SOH" export; `w_item_master.xlsb`, a genuine W-house item master). Both are real production-shaped data, kept locally for regression testing. **Never commit these** — they are untracked on purpose.

---

## 3. Core Architecture

### 3.1 Shared modules (load order matters — see §6 for exact per-tool includes)
Every shared file is either:
- a **classic script** (`<script src="...">`), self-invoking UMD-style (`window.X` in browser, `module.exports` in Node) — `retail-import.js`, `retail-profiles.js`, `retail-mapping.js`, `retail-ui.js`, `retail-decision.js`; or
- an **ES module** (`<script type="module" src="...">`) — `firebase.js`, `auth-guard.js`, `retail-assist.js`, `retail-insights.js` — because these need `import`.

Classic shared scripts must appear **before** the tool's own main `<script>` block if that block calls them at parse time (several tools call their main render function synchronously at the bottom of the file). Module scripts are always deferred by the browser, so their position in the file matters less, but by convention they're placed just before `</body>`.

### 3.2 Data flow (per-tool, "report generation")
1. User drops/selects a file → tool's own `readFile`/`FileReader` logic (each tool has its own; only some route through `retail-import.js`, see §5).
2. Tool computes its report entirely in-browser (SheetJS parsing, then tool-specific business logic).
3. Tool renders tables/KPIs to the DOM.
4. **(New in Phases 5–6)** Selected tools additionally: (a) build a small aggregate-only summary object and call `RetailDecision.saveSummary(toolKey, data)`, persisting it to `localStorage`; (b) on `Store_Review a1.html` only, offer an "AI Summary" button that POSTs an aggregate context to `/api/summarize`.

No raw transaction rows, barcodes-with-context, or customer data are ever sent to a server in this architecture — see §4 (Security).

### 3.3 Security architecture
- **Firebase Authentication** (`firebase.js`) is the single identity provider. Every tool page (except the explicit public pages) is gated by `auth-guard.js`, which redirects signed-out visitors to `login.html` and remembers the originating page via `sessionStorage.redirectAfterLogin`.
- **Free/Premium quota**: `auth-guard.js` enforces **10 reports/day, 30/month** for free-plan users (`DAILY_LIMIT`/`MONTHLY_LIMIT` constants), by monkey-patching `HTMLAnchorElement.prototype.click` to intercept `<a download>` clicks. This is explicitly documented in the file as "a fair-use guard, not a security boundary" — real enforcement would need server-side checks.
- **AI endpoints** (`api/map-schema.js`, `api/summarize.js`) are Vercel serverless functions, each independently verifying a Firebase ID token via RS256 signature check against Google's public certs (no `firebase-admin` dependency, no service-account secret — see either file's "Firebase ID token verification" section). Both apply a per-user in-memory rate limit (20/hour, 100/day) and an **egress guard**: a request-body validator that throws if anything resembling raw/row-level data is present (long digit runs, oversized arrays, unexpected fields, non-string/non-numeric types where a label/number is expected). Both fail closed — any error returns a generic `ai_unavailable`/`bad_request`, never partial data.
- **No API keys ever reach the browser.** `GEMINI_API_KEY` lives only in Vercel environment variables, read server-side.

### 3.4 Authentication model
- `firebase.js` initializes exactly one Firebase app (`retail-ai-2c674` project) and exports `auth`/`db` singletons. **Never call `initializeApp()` anywhere else** — every other file imports from this one.
- `auth-guard.js` is the only file that should manage sign-in redirect, the bottom-left profile card, and logout. It is included as `<script type="module" src="auth-guard.js"></script>`, always as the last script before `</body>` (by convention), on every protected page.
- Public pages (never redirect signed-out visitors): `""`, `index.html`, `login.html`, `signup.html`, `forgot-password.html`. Every tool page is therefore protected by default once `auth-guard.js` is included.
- **Known history**: `Store_Review a1.html` was missing `auth-guard.js` entirely until this conversation (commit `a49f939`) — it's now included like every other tool.

### 3.5 AI architecture
Two independent AI features exist, both following the **same** architecture pattern (this is the mandatory template for any future AI feature — see §12):
1. **AI column-mapping assist** (`retail-assist.js` → `api/map-schema.js`, pre-dates this conversation): when `retail-import.js` can't confidently map a file's columns, this optionally asks Gemini using **only column header names and masked value shapes** (digits→`#`, letters→`A`/`a`) — never real values. Falls back to a manual mapping modal (`retail-mapping.js`) on any failure.
2. **AI Executive Summary** (`retail-insights.js` → `api/summarize.js`, built in Phase 5, this conversation): generates a narrative summary of a Store Review report using only already-computed aggregate numbers (period totals, per-staff/department/brand/size rollups — the same numbers already on screen). See §7.5 for full status.

A **third**, explicitly rejected pattern — **historical note, corrected 2026-07-29:** this document previously described `Store_Review a1.html`'s `#aiOverlay`/`btnAI` ("Ask AI") UI as dead/unwired code inherited from an archived prototype. That was a factual error, discovered during planning for the Phase 7 chat integration (§7): the UI was **not** dead — it was a fully functional, live feature calling Anthropic's API **directly from the browser** with a user-supplied API key stored in `localStorage` (`anthropic-dangerous-direct-browser-access`), in direct violation of §11 security principle #2 and this very section's "must never be revived" instruction. It had been live, undocumented as such, since before this conversation began. **This has since been retired** (2026-07-29) — `Store_Review a1.html`'s Ask AI now calls `retail-chat.js`/`api/chat.js` (the server-side pattern), and the client-side-API-key code no longer exists anywhere in the codebase. See §7's new entry for the full change and verification. This section is kept as a record of the anti-pattern for future reference — do not reintroduce it in this or any other tool.

### 3.6 Decision Engine architecture
See §7.6 for full detail. In one paragraph: `retail-decision.js` is a pure, dependency-free correlation module. Tools call `RetailDecision.saveSummary(toolKey, aggregateData)` after computing their own report; this writes a versioned envelope (`{v, tool, savedAt, data}`) to a namespaced `localStorage` key (`retailai.decision.v1.<toolKey>`). `index.html` calls `RetailDecision.loadSummaries()` + `RetailDecision.evaluate(summaries)` to read whatever's present and compute recommendations, entirely client-side, entirely deterministic (no AI/LLM call in this path). Cross-tab freshness is handled via the `storage` event.

### 3.7 AI Intelligence Core architecture (Phase 7 — LOCKED design, in-progress implementation)
**This architecture is explicitly LOCKED by user direction** (2026-07-29): do not redesign any part of it without the user explicitly requesting an architecture change. It is the long-term foundation intended to let Retail AI work for any retailer, not just the current one (ABFRL / W / Aurelia / Jaypore). Implementation proceeds phase-by-phase (A → B → C → D → E, F independent — see §9); only Phase A is built so far. Full design rationale lives in the session's plan file (`snoopy-singing-planet.md`, not part of this repo); the summary below is the durable record for future sessions.

**Guiding decisions (locked):**
1. **AI-assisted retailer detection**, not manual-only. Evidence (column headers, style-code patterns, description language, brand tokens, known business-pattern fingerprints) is scored for confidence: **high → auto-identify**, **medium → lightweight one-click confirm banner** (not the full manual-mapping modal), **low → Universal Retail Mode** — a first-class, non-error fallback where file-type detection, column mapping, canonicalization, and the Decision Engine all still work generically; only retailer-specific enrichment/templates are unavailable.
2. **Retail Knowledge Intelligence** (broadens "brand intelligence"): one reasoning service (`retail-knowledge.js`, planned) that infers brand/category/gender/colour/size/product-family/pricing-tier **jointly from every available field on an item at once** (style code + description + SKU shape + price + more), never one field in isolation. Every inferred field carries its own confidence score; below threshold the field is `null`, never a forced guess.
3. **AI Data Policy** — a standing, named rule every current and future Gemini-backed endpoint must satisfy, not a per-file comment. Four tiers, always prefer the lowest one that can answer the question:
   - **Tier 0 (aggregate-only):** named totals/rollups already on screen (used today by `api/summarize.js`).
   - **Tier 1 (structural metadata only):** column headers + digit/letter-masked value shapes, never real values (used today by `api/map-schema.js`, via `retail-assist.js`'s `maskValue()`/`assertMasked()`, and `api/retail-knowledge.js`'s `task:'detect-retailer'`).
   - **Tier 2 (deduplicated, capped item subset — built in Step D):** for item-level reasoning (`api/retail-knowledge.js`'s `task:'enrich-items'`), only the *distinct* items that actually need it, deduplicated by style and hard-capped (40/request), never a full row list, never an EAN/barcode, never a real price. **One deliberate, documented exception to shape-masking:** the product **description** field is sent as real text (length-capped at 80 chars), not digit/letter-masked — a description's entire value to this task is its *words* ("Floral Maxi Dress"), and shape-masking would destroy exactly the signal needed while adding no privacy benefit the policy cares about (it's product-catalog text, the same words a retailer already publishes on its own storefront — not a barcode, price, or anything transaction/customer-linked). Its safety net is different, not absent: the length cap plus rejection of any embedded 4+ digit run (`DIGIT_RUN_RE` — the same heuristic `api/summarize.js` already uses for Tier 0 labels), catching an accidentally-embedded barcode/SKU/phone number. Style code and price stay Tier-1-style shape-masked; colour/size/known-brand are short plain labels (same sensitivity as a department or staff name, already sent unmasked in Tier 0).
   - **Tier NEVER:** full workbook dumps, raw rows, barcode-with-context, customer data — absolute prohibition.
4. **The Decision Engine (`retail-decision.js`) is never modified.** Everything in this architecture is an upstream, pre-`saveSummary()` enrichment/standardization step. `TOOL_KEYS`, `PRIMARY_TOOLS`, and the three live category functions stay exactly as they are through every phase.

**Modules — status as of Step E, Phase 7 (A→E) now fully implemented:** `retail-schema.js` (canonical row model + adapters — **done, locked**), `retail-intelligence.js` (rule-tier file-type + retailer-signature registry — **done, locked**), `retail-knowledge.js` (AI-tier orchestration: `detectRetailer()`/`classifyFile()` — **done, locked**; `enrichItems()` — **done, locked**), `retail-chat.js` (context-aware AI Assistant client — **done**, design review/lock still pending; **now wired into `Store_Review a1.html`'s "Ask AI"** as of 2026-07-29, the first Phase 7 module connected to a live tool — see §7's new entry). Server-side: `api/map-schema.js`'s `task:'classify'` — **done, locked**; `api/retail-knowledge.js`'s `task:'detect-retailer'`/`task:'enrich-items'` — **done, locked**; `api/chat.js` — **done**, design review/lock still pending; now serving real requests from `Store_Review a1.html`. See §7 Phase 7 entries for full detail.

**How Step E's flagged privacy-boundary question was resolved:** §16's prior entry asked the user to confirm, before Step E began, whether sending the user's own typed question to Gemini (unmaskable, unlike everything else in this app) was acceptable. The user's Step E approval instructions ("implement Phase E," "reuse the... AI Data Policy") were treated as that confirmation — a chat feature inherently requires sending what the user types, and the alternative (refusing to build chat at all) wasn't what was asked for. What *was* kept conservative, per instruction: the **context** surrounding the question stays strictly aggregate (Tier 0 shape, reusing `decisionEngine`/`retailIntelligence`/`retailKnowledge`/`toolContext` — all already-on-screen data, all still digit-run-guarded like every other AI endpoint). Only `question` and `history[].text` are exempt from that guard, and only because they're the user's own authored words, not retailer business data — `api/chat.js`'s two validation tests proving this asymmetry both ways (business-data digit runs rejected, user-text digit runs allowed) are the concrete evidence this boundary was implemented deliberately, not overlooked.

**One Phase D field-mapping note, driven by the LOCKED Phase A schema (`retail-schema.js`), not a free design choice:** the canonical row's `intelligence` sub-object (as locked) has confidence slots for `brand`/`category`/`gender`/`productFamily` but **not** for `colour` or `pricingTier`'s own confidence — only a bare `intelligence.pricingTier` value slot exists. Since Phase A cannot be modified, `enrichItems()` scopes its output to exactly what the locked schema supports: `brand`/`category`/`gender`/`productFamily` (value + confidence), and `pricingTier` (value only — its confidence gate is applied before writing, so the field's mere presence already means "confident enough," consistent with the "null below threshold" rule used everywhere else). `colour`/`size` are used as **input context** for the joint reasoning (Decision 2's "reason using all available information"), not as AI-enriched output fields — re-reading Decision 2's original wording, they were always listed among the things the component should *understand*, not a committed output target.

**One Step C design decision worth flagging:** the roadmap's original wording only explicitly named `retail-knowledge.js`'s `detectRetailer()` for this phase. Implementing it surfaced that file-type classification's AI fallback (`api/map-schema.js task:'classify'`) also needed a client-side caller and an orchestrator to decide when to use it — resolved by (a) adding `classifyFile()` to `retail-assist.js`, since that file is already the established client for `api/map-schema.js`, and (b) giving `retail-knowledge.js` a matching `classifyFile(sheets)` orchestrator alongside `detectRetailer(sheets)`, since both are "try the Phase B rule tier first, fall back to AI only if needed" — the same pattern, just no `mode` field for file type (no Universal-Mode equivalent exists for "what kind of file is this"). Documented here so this isn't mistaken for scope drift.

---

## 4. Complete Tool Inventory

| Tool (file) | Purpose | Inputs | Outputs | Decision Engine status |
|---|---|---|---|---|
| **`Store_Review a1.html`** | POS sales business review for a period, optionally vs. a comparison period | Required: "Bill Wise Item List" POS export (bill/date/store/salesman/style/size/dept/subclass/mrp/discount/qty/value). Optional: "SOH or Item Master" file (enriches brand/story/season) | On-screen KPI dashboard (sale summary, ATV/UPT/ASP, staff performance, offer & fresh mix, weekend performance, department/festive/brand/season/story/size-curve breakdowns), Excel export, AI Summary (button) | ✅ **Integrated** — writes `storeReview` summary; also the pilot for AI Summary |
| **`Inventory_Validity_Console.html`** | Classifies SOH into Valid (3+ sizes)/Cut Piece (1–2 sizes)/Free Size, with offer-mix analysis | SOH export (plant/brand/style/size/qty/value/dept/story/season/offer%); supports single- or multi-store files | KPI tiles, per-brand-or-store breakdown table, offer × validity matrix, Excel export (5 or 8 sheets) | ✅ **Integrated** — writes `inventoryValidity` summary |
| **`Inventory_Audit_Toolf1.html`** | 3-way reconciliation: system vs. master vs. physical count | Three files: system export, master/item file, physical count | KPI cards (net value impact, shortage/excess/mismatch/unidentified), per-barcode discrepancy table with badges, Excel export | ✅ **Integrated** — writes `inventoryAudit` summary |
| **`Stock_IN_OUT_Adjustment.html`** | Barcode-level system-vs-physical diff to generate stock adjustment IN/OUT lists | System + physical files (single upload, multi-sheet or multiple files, user maps columns) | "Bring IN" list (found physically, absent from system) and "Take OUT" list (in system, absent physically), each sorted by value, Excel export | ✅ **Integrated** — writes `stockAdjustment` summary |
| **`SOH_Image_Link_Builder.html`** | Builds product-search URLs from style+brand codes for merchandising use | Any file with a style column and a brand column (auto-detected) | Table of {style, brand, product search URL}, CSV-like export | ✅ **Integrated (coverage-only)** — writes `sohImageLinks` summary (styles/linked/noLink/brandMix counts). Classified **auxiliary/enrichment** (Phase 6 design): does not affect `confidence` or any recommendation category, only lights up its status chip in `index.html`'s panel |
| **`BlueDart_Etail_Waybill_Builder1.html`** | Builds Blue Dart courier waybills for e-tail returns/dispatch | MB51 (SAP goods movement), GRN, store master, optional IST list | Matched invoice/waybill rows, unmatched entries for manual resolution | ✅ **Integrated (coverage-only)** — writes `blueDart` summary (waybills/pieces/declaredValue/issues/istMismatches/pendingStyles counts, mirroring the on-screen KPI tiles exactly). Classified **auxiliary/enrichment** (Phase 6 design, same as SOH Image Link Builder): does not affect `confidence` or any recommendation category, only lights up its status chip in `index.html`'s panel |

### Other pages
- **`index.html`** — public landing page; tool directory; now also hosts the **Decision Engine panel** ("Your Recommendations") between the hero and trust-marquee sections, visible only to signed-in users.
- **`login.html` / `signup.html` / `forgot-password.html`** — Firebase auth flows.
- **`privacy.html` / `terms.html`** — static legal pages.

### Archived (superseded, not part of the live product — see §11 for why)
- `archive/BlueDart_Etail_Waybill_Builder` (no extension) and `archive/BlueDart_Etail_Waybill_Builder.html` — pre-`1` suffix duplicates, superseded by the live `BlueDart_Etail_Waybill_Builder1.html`.
- `archive/Store_Business_Review.html`, `archive/Store_Business_Review (1).html`, `archive/Store_Business_Review (2).html`, `archive/Store_Review1.html` — earlier forks/drafts, superseded by the live `Store_Review a1.html`. **Note:** `Store_Business_Review.html` contains a "Weekly Review" tab with a coloured Excel export that was never ported to the live tool — flagged in Phase 1 as a legitimate future enhancement, not yet acted on.

---

## 5. Shared Components (detailed)

| File | Responsibility | Notes |
|---|---|---|
| **`firebase.js`** | Single Firebase app initialization; exports `auth`, `db` | Never call `initializeApp()` elsewhere |
| **`auth-guard.js`** | Sign-in redirect for protected pages, Firestore profile load, bottom-left profile card, logout, free/premium report-download quota (10/day, 30/month) | Self-contained; creates its own DOM (`#ra-profile-card`, `#ra-toast`); no HTML dependencies |
| **`retail-import.js`** | Universal SOH parser: header-row detection, column-synonym mapping (~20 known fields), brand-house detection (W/Aurelia by brand column; Jaypore by World+LOB+Division fingerprint since Jaypore has no brand column), style-key derivation, size-grid-to-label learning, Valid/Cut-Piece/Free-Size classification | Consumed by `Inventory_Validity_Console.html`. **Deliberately not used** by Inventory Audit, Stock IN/OUT, or BlueDart — investigated in Phase 4 and found to be a genuinely different data domain for each (see §10) |
| **`retail-profiles.js`** | Brand-house registry: `w`, `aurelia`, `jaypore` (keys/fam codes/domains/search URLs/free-size codes/size ordering) | `jaypore.brands = []` intentionally — Jaypore SOH exports have no brand column |
| **`retail-mapping.js`** | Manual column-mapping confirmation modal + per-file-fingerprint `localStorage` memory (`retailai.map.v1.*`) | Falls back to this on any AI-assist failure |
| **`retail-assist.js`** | Privacy-masked AI column-mapping client (calls `/api/map-schema`) + **Phase 7 Step C addition:** `classifyFile(headers, samples, meta)`, a thin raw AI-caller for `task:'classify'` (file-TYPE classification), mirroring `suggestBrands()`'s exact structure; also now exposes its previously-private `buildSamples()` for reuse by `retail-knowledge.js` | ES module; masks all values before they leave the browser; never blocks — returns `null` on any failure and the manual modal (or, for `classifyFile`, the rule tier's own answer) takes over |
| **`retail-ui.js`** | Shared drag-and-drop file-intake behavior (`wireDropZone`) | Parameterized (`groupedEvents`, `multiple`, `requireNonEmpty`, `bindClick`) to reproduce each tool's *actual*, verified-different drag/drop contract — **not** a one-size-fits-all default (see §10) |
| **`retail-theme.css`** | Two CSS rules only: `*{box-sizing:border-box}` and the `sp` spinner keyframe | Deliberately minimal — see §10, "why the shared theme is thin" |
| **`retail-insights.js`** | AI Executive Summary client (calls `/api/summarize`) | ES module; unlike `retail-assist.js`, returns a **typed failure reason** (`signed_out`/`rate_limited`/`unavailable`/`network`/`bad_response`) rather than silent `null`, because there's no equivalent invisible fallback for a missing summary |
| **`retail-decision.js`** | Decision Engine: `saveSummary`/`loadSummaries` (the cross-tool blackboard) + `evaluate()` (pure correlation logic) + the Recommendation Card model | See §7.6 for full detail |
| **`retail-schema.js`** | AI Intelligence Core, Phase A (**LOCKED**): canonical row model (`recordType:'sale'\|'stock'`, business-concept-organized, with a reserved `intelligence.*` sub-object for future AI enrichment) + one pure adapter per already-integrated Decision Engine tool (`toStoreReviewSummary`, `toInventoryValiditySummary`, `toInventoryAuditSummary`, `toStockAdjustmentSummary`) | Standalone — not wired into any tool page or into `retail-decision.js`. See §3.7 and §7 Phase 7. Do not modify without an explicit new requirement |
| **`retail-intelligence.js`** | AI Intelligence Core, Phase B (**LOCKED**): deterministic, zero-AI rule tier — `classifyFileType()` (SOH/Sales/MB51/GRN/IST/store-master/Blue Dart waybill-template) and `detectRetailer()` (signature registry: brand-column majority vote + header fingerprints, 0–1 confidence). Delegates header/column detection to `RetailImport` and brand-code lists to `RetailProfiles` when loaded; degrades gracefully to a smaller built-in fallback when they aren't | Standalone — not wired into any tool page. See §3.7 and §7 Phase 7. Do not modify without an explicit new requirement |
| **`retail-knowledge.js`** | AI Intelligence Core, the AI-tier **orchestrator**. **Step C:** `detectRetailer(sheets)` calls `RetailIntelligence.detectRetailer()` (Phase B, read-only) first; only calls the AI tier (`/api/retail-knowledge`) when rule-tier confidence isn't already `'high'` — a real cost optimisation, known retailers never reach Gemini. Produces the locked architecture's confidence-gated `mode:'auto'\|'confirm'\|'universal'`. `classifyFile(sheets)` is the file-type equivalent (via `RetailAssist.classifyFile()`), with no `mode` — file type has no Universal-Mode concept, callers fall back to manual selection below `'high'` confidence, same as `retail-mapping.js`'s existing manual modal. **Step D:** `enrichItems(canonicalRows)` — deduplicates `retail-schema.js` canonical rows by style (Tier 2), skips the AI call entirely when nothing in the batch needs anything, reasons jointly per item, and fills `brand`/`category`/`gender`/`productFamily`/`intelligence.pricingTier` only where missing (never overwrites a known value), each field confidence-gated at 0.6 | ES module; standalone — not wired into any tool page. See §3.7 and §7 Phase 7 |
| **`retail-chat.js`** | AI Intelligence Core, Phase 7 Step E: the context-aware AI Assistant client. `ask(question, context)` is the one entry point — sends the question + up to 8 turns of in-memory (never persisted) conversation history + whatever of the four context pieces the caller supplies. Ships 4 small **context-builder** functions (`buildDecisionEngineContext`, `buildRetailIntelligenceContext`, `buildRetailKnowledgeContext`, `buildToolContext`) that normalise a real `evaluate()`/`classifyFileType()`/`detectRetailer()`/`enrichItems()` result — or a tool's own plain label object — into the capped shape `api/chat.js`'s egress guard expects, so a future tool never needs to hand-roll the request schema (the concrete mechanism behind "modular — future tools automatically benefit") | ES module; standalone — not wired into any tool page. See §3.7 and §7 Phase 7 |
| **`api/map-schema.js`** | Vercel fn: AI column-mapping via Gemini + **Phase 7 Step C addition:** `task:'classify'` (file-TYPE classification only), reusing the exact same `validateBody`/`assertMasked` egress guard unchanged — new prompt/response, same Tier 1 data shape. Legacy callers (no `task` field) are byte-for-byte unaffected | Firebase-token-gated, rate-limited, egress-guarded |
| **`api/retail-knowledge.js`** | Vercel fn, two tasks on one file (locked-Step-C code path untouched by Step D's addition). `task:'detect-retailer'` (Step C) — AI retailer-identity guess from masked headers/shapes + a candidate-retailer key list (never hardcoded server-side; comes from the request, ultimately `RetailProfiles.PROFILES`) + an optional rule-tier hint, Tier 1. `task:'enrich-items'` (Step D) — AI item enrichment from a deduplicated, capped batch, Tier 2 (first use of this tier): masked style-code/price *shapes* + real (but length-capped, digit-run-rejected) product description text + plain colour/size/brand labels → `brand`/`category`/`gender`/`productFamily`/`pricingTier`, each independently confidence-gated | Same skeleton as `api/map-schema.js`/`api/summarize.js` (own independent rate-limit bucket), Firebase-token-gated, egress-guarded per-task (see §3.7 for the description-masking exception) |
| **`api/chat.js`** | Vercel fn, Phase 7 Step E. The "experienced retail business consultant" persona lives entirely in this file's prompt — every other endpoint returns a fixed JSON shape it fills in; this one free-answers in natural language (still JSON-wrapped, `{"answer":"..."}`, for parsing safety). Validates 4 context sections (`decisionEngine`/`retailIntelligence`/`retailKnowledge`/`toolContext`) plus `question`/`history` under **two different rules on the same endpoint**: business-data fields get the usual digit-run/length guards; `question`/`history` text is the user's own authored words and is deliberately exempt from the digit-run check (length-capped only) — see §3.7 for the full reasoning. `retailKnowledge` is shape-enforced to be a rollup (counts + top-N labels) — an individual enriched item's fields are rejected as "unexpected field," not just discouraged by convention | Same skeleton as the other 3 AI endpoints, own rate-limit bucket (30/hr, 150/day — more generous, chat is naturally multi-message), no conversation ever persisted server-side |
| **`api/summarize.js`** | Vercel fn: AI executive summary via Gemini | Same security pattern as above, different payload shape/prompt |

---

## 6. Per-tool script include reference (exact, as of latest commit)

| Tool | Classic scripts (in order) | ES modules |
|---|---|---|
| `Store_Review a1.html` | (vendor XLSX) → `retail-decision.js` → main script (calls `RetailDecision.saveSummary` inside `render()`) | `retail-insights.js`, `auth-guard.js` |
| `Inventory_Validity_Console.html` | (vendor XLSX) → `retail-ui.js` → main script → `retail-import.js`, `retail-profiles.js`, `retail-mapping.js`, `retail-decision.js` | `auth-guard.js` |
| `Inventory_Audit_Toolf1.html` | (vendor XLSX) → main script → `retail-ui.js` → `retail-decision.js` | `auth-guard.js` |
| `Stock_IN_OUT_Adjustment.html` | (CDN XLSX) → `retail-ui.js` → `retail-decision.js` → main script | `auth-guard.js` |
| `SOH_Image_Link_Builder.html` | (vendor XLSX) → `retail-ui.js` → main script → `retail-profiles.js` | `auth-guard.js` |
| `BlueDart_Etail_Waybill_Builder1.html` | (vendor XLSX) → main script (defines `WB`) → `retail-ui.js` → `retail-decision.js` → main UI script (calls `saveDecisionSummary()` inside `tiles()`) | `auth-guard.js` |
| `index.html` | (UI animation script) → `retail-decision.js` | Feedback-widget module, Decision Engine render module (imports `firebase.js`, calls `RetailDecision.evaluate`), `auth-guard.js` — in that order |

All 6 tools embed the SheetJS/XLSX library **inline** (vendor blob) except `Stock_IN_OUT_Adjustment.html`, which loads it from a CDN (`cdnjs.cloudflare.com`). This inline-duplication was identified in Phase 0 analysis as the single largest byte-count duplication in the repo but has **not been deduplicated** — it's out of scope for everything done so far (see §10, Known Technical Debt).

---

## 7. Completed Phases

### Phase 1 — Repository Cleanup
- **Objective:** Resolve literal duplicate/forked tool files before any refactor, so later work isn't repeated across forks.
- **Major implementation:** Identified canonical files by cross-referencing `index.html` nav links + git history + content diffs. Moved 6 non-canonical files into `archive/` via `git mv` (history preserved, nothing deleted).
- **Important design decisions:** `Store_Business_Review.html`'s "Weekly Review" tab (colour Excel export) was found to contain real, unmerged functionality — flagged for a possible future port rather than silently discarded.
- **Testing performed:** Verified canonical files (`BlueDart_Etail_Waybill_Builder1.html`, `Store_Review a1.html`) still resolve from `index.html`; confirmed no other file referenced the archived filenames.
- **Commit:** `27f5135`

### Phase 2 — Retail Core Foundation
- **Objective:** Extract genuinely duplicated code into shared modules — evidence-based, not aspirational.
- **Major implementation:** Created `retail-theme.css` (2 rules, only what was byte-identical across ≥2 files) and `retail-ui.js` (a `wireDropZone` helper, piloted on `Inventory_Audit_Toolf1.html`), then rolled the CSS piece out to the other 5 tools.
- **Important design decisions:** Rejected the temptation to invent a shared design system — investigation showed CSS/JS "family resemblance" across tools was mostly *convergent* (independently reimplemented), not literal duplication; unifying it would have changed each tool's appearance/behavior.
- **Testing performed:** Browser-based verification per tool (fresh tabs — stale-tab reuse was identified as a source of false test signals and corrected), console-error checks, computed-style checks.
- **Commits:** `298ff1d` (pilot), `783cf8c` (rollout to remaining 5 tools)

### Phase 3 — Retail Core Engine drop-zone unification
- **Objective:** Properly unify drag-and-drop file-intake behavior across tools without changing any tool's behavior.
- **Major implementation:** Rewrote `retail-ui.js`'s `wireDropZone` with options (`groupedEvents`, `multiple`, `requireNonEmpty`, `bindClick`) discovered by reading each tool's *actual* drop-zone code, then migrated 4 tools to it.
- **Important design decisions:** Found that several tools' drag-drop code, despite looking similar, had real semantic differences (multi-file vs. single-file, nested-button click guards, keyboard accessibility) — the shared helper was designed to reproduce each tool's exact prior behavior via explicit parameters, not to force convergence.
- **Testing performed:** Per-tool isolated-fresh-tab testing of every event-handling detail (preventDefault, class toggling, single/multi-file extraction, guard behavior).
- **Commit:** `bb7e113`

### Phase 4 — Business logic migration to `retail-import.js` (partial — scope narrowed)
- **Objective:** Migrate remaining tools' hand-rolled column/header detection to the shared `retail-import.js` "wherever it's a natural fit."
- **Major implementation:** Investigated all 6 tools' actual business logic. Found only `Store_Review a1.html`'s optional secondary file (kind==='soh' branch) has genuine field-vocabulary overlap with `retail-import.js`. BlueDart, Inventory Audit, Stock IN/OUT, and Store Review's primary sales parser were found to be **different data domains** (SAP logistics fields, 3-way reconciliation with positional fallbacks, POS transaction fields) that don't fit `retail-import.js`'s SOH-oriented model.
- **Important design decisions:** Explicitly **descoped** to just the one candidate; user further narrowed scope to require real test files before any change. **This migration was never completed** — it's paused waiting on a genuine W/Aurelia-house SOH file with an `EAN + Story Name` shape (the two files provided, a "W Item Master" and a "Jaypore SOH", were tested against the *current* code and found to resolve to `kind==='master'` and "Not recognised" respectively — neither exercises the target `kind==='soh'` code path). **No code was changed in this phase.**
- **Testing performed:** Ran both provided real files through the actual unmodified app logic (via a local static server) to determine what code path each hits, before touching anything.
- **Commit:** none (analysis only; work is stalled awaiting the right test file)

### Phase 5 — AI Executive Summary (Tier 1) + auth-guard fix
- **Objective:** Add an AI-generated executive summary to Store Review, following the same secure architecture as `retail-assist.js`/`api/map-schema.js`.
- **Major implementation:** New `api/summarize.js` (Firebase-gated, rate-limited, egress-guarded Vercel function) and `retail-insights.js` (client). Integrated into `Store_Review a1.html` via a new "AI Summary" button, reusing the exact aggregate context already built for the button (see `AI_CONTEXT` in that file). Separately, discovered and fixed that `Store_Review a1.html` was the only tool missing `auth-guard.js`/`firebase.js` entirely.
- **Important design decisions:** Kept the existing dead "Ask AI" button/overlay (client-side-API-key pattern from an archived prototype) untouched and unrepurposed — reserved as a placeholder for a possible future Tier-2 feature built the *right* way. `retail-insights.js` deliberately returns typed failure reasons rather than silent null, unlike `retail-assist.js`, because there's no invisible fallback for a missing AI summary.
- **Testing performed:** Extensive unit testing of the egress guard (5 different row-level-shaped payloads, all correctly rejected) and of every client response path (401/429/503/network/success/malformed → correct UI state). **The actual Gemini call itself has never been exercised** — this environment has no real Vercel deployment or `GEMINI_API_KEY`; the request pipeline was verified up to a real (404, expected locally) network call with a genuine Firebase auth token. Auth-guard fix was verified via real login/logout flow (redirect confirmed both ways) plus a full regression re-run of the report/AI-summary pipeline.
- **Commits:** `4f5c79f` (AI Summary), `a49f939` (auth-guard fix)

### Phase 6 — Retail Decision Engine (complete, all 5 steps)
All five sub-steps are now done and tested (steps 1–4 committed; step 5 — both the SOH and BlueDart auxiliary-wiring halves — is a tested, uncommitted working-tree change, see 6.5/6.5b). A possible future "AI narration layer" on top of the (still fully deterministic) Recommendation Cards is noted only as an architectural principle (§12) — not scheduled, not requested, not part of this five-step roadmap.

**6.1 — Pilot: Store Review only**
- **Objective:** Prove the cross-tool architecture (no separate page — integrate into `index.html` per explicit user direction) on the single lowest-risk tool.
- **Major implementation:** `retail-decision.js` v1 (`saveSummary`/`loadSummaries`/`evaluate`, `coaching` category only). `Store_Review a1.html` saves its existing `AI_CONTEXT` as the `storeReview` summary. `index.html` gets a new "Your Recommendations" panel (hidden for signed-out visitors, empty-state otherwise).
- **Design decisions:** Coaching rule: staff `abv` (average bill value) ≥20% below the store's own `atv`, with a minimum of 3 bills to avoid flagging low-volume noise.
- **Testing:** Extensive `localStorage`-level unit tests; rendering verified via **disposable, uncommitted copies** with only the Firebase auth-gate line bypassed (never the business logic) — necessary because the session's Firebase login had been signed out and creating a new account is a hard-prohibited action.
- **Commit:** `8272854`

**6.2 — Confidence level + per-tool freshness indicator**
- **Objective:** Show which tools have contributed data, how fresh, and an overall confidence level.
- **Major implementation:** `coverage.perTool` (status/ageDays/freshness — `fresh` <3d, `aging` <14d, `stale` beyond) for all 6 tools; `confidence: {level, score, reason}` based on how many of the 4 **primary** tools (`storeReview`, `inventoryValidity`, `inventoryAudit`, `stockAdjustment`) are present and how stale the oldest one is. Auxiliary tools (`sohImageLinks`, `blueDart`) deliberately do not affect confidence.
- **Testing:** 7 confidence scenarios + freshness banding, all matching documented thresholds exactly.
- **Commit:** `1c111d5`

**6.3 — Inventory Validity Console integration**
- **Objective:** Add the second primary data source, unlocking the `atRisk` category.
- **Major implementation:** `Inventory_Validity_Console.html`'s `rebuild()` now saves totals, per-brand/store group rollups, and the 20 highest-value Cut Piece styles.
- **Testing:** Verified against the **real** 23MB "JAYPORE ALL STORES SOH" file (in `_test_data/`) — correct totals, correct `(blank)` brand handling (Jaypore has no brand column), correct value-sorted at-risk list; confirmed the summary updates live when the manager changes the valid-threshold setting.
- **Commit:** `2aa06e0`

**6.4 — Recommendation Card model + Inventory Audit / Stock IN-OUT integration**
- **Objective:** Introduce one shared card shape for every category, then add cross-tool corroboration.
- **Major implementation:** Every category now normalizes to `{category, title, context, reason, metricLabel, metricValue, severity, evidence}`. `index.html` renders all categories through one generic function. New `attention` category merges Inventory Audit's Shortage/Excess with Stock Adjustment's OUT/IN **by barcode** — a barcode flagged by both is "corroborated" and ranks above single-source findings regardless of value.
- **Important design decisions (discovered during testing, not assumed up front):** (a) Inventory Audit has its own same-value/same-style "pairing" logic that reclassifies matching-value shortages/excesses as "Mismatch" swaps — real intentional behavior, test data had to account for it. (b) Stock IN/OUT Adjustment only flags barcodes **completely absent** from one side, not quantity mismatches — a real semantic difference from Inventory Audit that limits exactly when corroboration can fire (only on total-absence cases).
- **Testing:** Synthetic but realistic system/master/physical files run through both tools' **actual, unmodified** reconciliation code (via disposable auth-bypassed copies), producing matching real values (₹6,010 shortage, ₹5,607 excess) that correctly corroborated, plus two genuine single-source cases correctly demoted in ranking.
- **Commit:** `44dac98`

**6.5 — SOH Image Link Builder auxiliary wiring (half of step 5, done)**
- **Objective:** Wire `SOH_Image_Link_Builder.html` into the Decision Engine as a coverage-only auxiliary signal, per the design confirmed before implementation: neither this tool nor BlueDart would enrich the existing `coaching`/`atRisk`/`attention` categories (no shared join key with either), so the honest, minimal-risk scope is purely lighting up the tool's already-built-but-dormant status chip in `index.html`'s "Your Recommendations" panel — no new category, `retail-decision.js` and `index.html` untouched.
- **Major implementation:** Added `<script src="retail-decision.js"></script>` and a guarded `saveDecisionSummary()` call at the end of `rebuild()`, sending `{totals:{styles,linked,noLink}, brandMix:{w,au,jp,un}}` — counts only, mirroring the tool's own on-screen chips exactly.
- **Testing:** Verified against both real files in `_test_data/` (`jaypore_soh.xls`: no brand column, correctly all "un"/0 linked, matching the on-screen note; `w_item_master.xlsb`: 6 rows). Verified in `index.html` (disposable auth-bypassed copy) that the tool's status chip flips to "today," confidence stays empty (auxiliary tools don't count toward it), and no recommendation card is fabricated. Zero other files touched.
- **Commit:** none yet — uncommitted working-tree change.

**6.5b — BlueDart Waybill Builder auxiliary wiring (second half of step 5, done — resumed and completed 2026-07-29)**
- **Objective:** Wire `BlueDart_Etail_Waybill_Builder1.html` into the Decision Engine as a coverage-only auxiliary signal, using the exact same design as 6.5 (SOH): no new recommendation category, `retail-decision.js` and `index.html` untouched — `blueDart` was already present in `TOOL_KEYS` (not `PRIMARY_TOOLS`) and already had a chip label in `index.html`'s `TOOL_LABEL` map from earlier phases, so this step only needed to touch the tool file itself.
- **Major implementation:** Added `<script src="retail-decision.js"></script>` (after `retail-ui.js`, before the main UI script) and a guarded `saveDecisionSummary()` function, called once at the end of the existing `tiles()` method (the function that already computes and renders the on-screen KPI tiles — ship count, pieces, declared value, issues — on every `render()`/`tick()`/`edit()`/`selAll()`/`setVal()`). Reports `{totals:{waybills, pieces, declaredValue, issues, istMismatches, pendingStyles}}`: `waybills`/`pieces`/`declaredValue`/`issues` mirror the on-screen `tShip`/`tPcs`/`tVal`/`tIss` tiles exactly (computed over currently-*selected* rows, same as the tiles); `istMismatches` counts rows whose IST-cross-check `note` field flags a GRN/IST destination conflict (`"IST list says →…"`, already rendered on-screen as a ⚠ note); `pendingStyles` reports `state.pending.length` — IST-list styles never matched to an actual outward invoice — but only when `state.istActive` is true, mirroring the on-screen `pendWrap` panel's own visibility gating (never a stale/misleading count when the IST panel itself is hidden).
- **Important design decisions:** No AI Intelligence Core (Phase 7) component was reused here — considered per this session's requirement to reuse it "wherever appropriate," but there is no appropriate hook: this step is a pure client-side aggregate-count mirror of already-on-screen tiles, with no file-type/retailer classification or item-level enrichment need, consistent with 6.5's identical precedent and with Phase 7's own posture that none of its modules are wired into any live tool yet (a separate, future, explicitly-scoped decision per §7/§16). `retail-decision.js` and `index.html` were confirmed untouched — no code changes were even needed there, since `blueDart` was already a registered (non-primary) `TOOL_KEYS` entry from earlier phases.
- **Testing:** No real BlueDart test files exist in `_test_data/` (consistent with Phase 6.4's/7.A's precedent for this tool). Verified via a disposable, uncommitted copy of the tool (auth-guard include stripped, business logic untouched) driven directly through its real global `state`/`ui.tiles()`/`WB` objects in-browser: (a) synthetic realistic rows (matched + unmatched + an IST-conflict note + a pending IST style) produced a saved summary whose every field byte-matched the simultaneously-rendered on-screen tiles; (b) toggling `state.istActive` to `false` correctly zeroed `pendingStyles` even with non-empty `state.pending`, matching the UI's own gating; (c) deleting `window.RetailDecision` and re-invoking `tiles()` threw no error and left the tool's own tile rendering fully intact (graceful-degradation contract preserved); (d) a disposable, uncommitted copy of `index.html` (auth-guard include stripped) confirmed the "BlueDart Waybill Builder" chip renders `fresh`/"today", `confidence` stays empty, and the panel body shows only the empty-state message — no recommendation card fabricated. No console errors at any step. Both disposable copies were deleted after testing; only `BlueDart_Etail_Waybill_Builder1.html` itself carries a diff.
- **Commit:** none yet — uncommitted working-tree change.
- **Phase 6 status:** with 6.5b done, **all 5 steps of Phase 6 are now complete** — Decision Engine integration spans all 6 tools (4 primary + 2 auxiliary). **User-approved and explicitly LOCKED (2026-07-29).** Do not modify `retail-decision.js`'s core logic, the auxiliary-vs-primary distinction, or either tool's `saveDecisionSummary()` wiring without an explicit new requirement — see §15.

### Phase 7 — AI Intelligence Core (in progress)
Architecture is user-approved and **locked** (2026-07-29) — see §3.7 for the full design summary. Implementation proceeds one phase at a time (A → B → C → D → E), each stopped for review before the next begins.

**7.A — Canonical schema + tool adapters**
- **Objective:** Build a reusable canonical row model (`retail-schema.js`) plus one pure adapter per already-integrated primary tool, so a future universal ingestion path can feed the *existing* Decision Engine without any change to it. No AI, no file parsing, no wiring into any tool yet — purely new, freestanding infrastructure.
- **Major implementation:** Two `recordType`s (`'sale'` transaction-line rows for Store Review, `'stock'` item-grain rows for the other three), organized around business concepts (identity / descriptive attributes / location / quantity / money / transaction context / classification) rather than any one tool's internal variable names, with a reserved `intelligence.*` sub-object (retailer, per-field confidence, pricing tier) left null/unset for Phases C/D to populate later without a schema redesign. Two genuinely different classification vocabularies were kept as separate honestly-named fields (`classification.reconStatus` for Inventory Audit's value-based reconciliation vs. `classification.presenceStatus` for Stock Adjustment's presence-only diff) rather than forced into one shared enum.
- **Important design decisions:** Adapters are intentionally asymmetric — `toInventoryValiditySummary`/`toInventoryAuditSummary`/`toStockAdjustmentSummary` are **thin** (their tools already classify data internally before it becomes a canonical row; the adapter only rolls already-classified rows into totals/top-N, never re-implementing classification logic). `toStoreReviewSummary` is **thick** (Store Review's raw file genuinely is unaggregated POS bill-line data, so the adapter faithfully ports `agg()`/`billsOf()`/festive-segment-derivation from `Store_Review a1.html:604-758`, line-by-line, not from memory). Inventory Audit's `mm_pairs`/`mm_units`/`mm_val` are accepted as a pass-through `context.mismatchTotals` rather than re-derived, because they're a *relational* fact from the tool's own pairing algorithm (`classifyVariances()`), not a per-row property — re-deriving them would mean duplicating business logic the thin-adapter principle explicitly forbids.
- **Testing (real round-trip, not just unit fixtures):** `toStoreReviewSummary` verified **byte-identical** against the actual unmodified `Store_Review a1.html` (disposable auth-bypassed copy) with a synthetic 5-line, 4-bill CSV covering multi-staff/multi-department/festive/offer/weekend/return-line cases. `toInventoryValiditySummary` verified **byte-identical** against the actual unmodified `Inventory_Validity_Console.html`, driven by its own exposed `window.IVC.buildModel()` on the real 23MB `_test_data/jaypore_soh.xls` (9,471 styles, ₹16.6 crore total value, 9 stores). `toInventoryAuditSummary`/`toStockAdjustmentSummary` verified against hand-computed fixtures (no real test data exists for either, consistent with Phase 6.4's methodology). Edge cases (empty input, invalid `recordType`, junk/non-canonical rows mixed in) all degrade gracefully without throwing.
- **Two real bugs caught and fixed by the round-trip tests, not by inspection:** (1) `comparePeriod`/`compareTotals` must be non-null-with-zero-values when a compare period is *configured* but has no matching rows — the first draft incorrectly inferred "no compare period" from an empty array instead of from the caller's explicit intent (`compareRows == null` now means "not configured"; `[]` means "configured, empty"). (2) `inventoryValidity`'s `groups` array must be sorted (alphabetically by store for multi-store files; W-house-brand-priority then alphabetical for single-store/brand-keyed files, porting `Inventory_Validity_Console.html:849-858` exactly) — the first draft didn't sort at all, which passed on totals/top-N but silently produced groups in the wrong order.
- **Commit:** none yet — uncommitted working-tree change (new file, not wired into anything).
- **Status:** user-approved and **explicitly LOCKED** (2026-07-29). Do not modify without an explicit new requirement — see §15.

**7.B — Rule-tier file-type + retailer classification**
- **Objective:** Build `retail-intelligence.js`'s deterministic rule tier — `classifyFileType()` and `detectRetailer()` — generalizing two pieces of real, already-working detection logic (`BlueDart_Etail_Waybill_Builder1.html`'s `WB.classify()`, `retail-import.js`'s `findHeaderRow()`/`detectHouse()`) into one reusable, extensible module. No AI, no network call — the AI fallback tier this architecture calls for is explicitly Phase C's job, not started or stubbed here.
- **Major implementation:** `classifyFileType(sheets)` scores 7 file types (`soh`, `sales`, `mb51`, `grn`, `ist`, `storeMaster`, `waybillTemplate`) via a table of scored rules instead of an if/else priority chain — the `soh`/`sales` rules were newly generalized (no prior standalone classifier existed for either; Store Review only ever checked for a bare `BillNo` column, Inventory Validity Console never classified its input at all, it just assumed SOH shape), while `mb51`/`grn`/`ist`/`storeMaster`/`waybillTemplate` are direct, regex-faithful ports of BlueDart's existing structural checks. `detectRetailer(sheets)` generalizes `retail-import.js`'s hardcoded 2-brand-set-plus-1-fingerprint `detectHouse()` into a data-driven signature registry (pulled live from `RetailProfiles.PROFILES` when loaded) that produces a genuine 0–1 confidence score — the original only ever returned a bare house name or `'unknown'`, no confidence at all.
- **Important design decisions:** Investigated `Inventory_Audit_Toolf1.html` and `Stock_IN_OUT_Adjustment.html` before writing anything — neither auto-classifies its uploaded files by content; both use fixed, separately-labelled drop zones instead (Inventory Audit: `#drop-master`/`#drop-physical`/`#drop-system`; Stock IN/OUT: user-driven column mapping). There was no existing detection logic to generalize for either, so none was invented — a documented boundary, not a gap. Reuses `RetailImport.findHeaderRow()`/`mapColumns()` for header/column detection and `RetailProfiles.PROFILES` for brand-code lists rather than duplicating either (this file only replaces retail-import.js's *decision* step, not its detection mechanics); both are optional, with a smaller, explicitly-documented built-in fallback when absent (fingerprint-based retailer detection specifically cannot run in fallback mode, since it needs `RetailImport`'s field map — verified to degrade to `'unknown'`, never a false positive). BlueDart's terse `'master'`/`'template'` result names were deliberately renamed to `'storeMaster'`/`'waybillTemplate'` for a universal registry.
- **Testing (real round-trip, not just unit fixtures):** File-type rules cross-checked against the actual `WB.classify()` (extracted from `BlueDart_Etail_Waybill_Builder1.html` via fetch + eval, no disposable copy needed since it's a pure function with no DOM/auth dependency) for all 5 BlueDart-derived types — full agreement. SOH classification verified against the real 23MB `_test_data/jaypore_soh.xls` (0.9 confidence, `'high'`). Retailer detection cross-checked against the real `RetailImport.detectHouse()` on the same real file — identical result (`jaypore`, via header fingerprint). Synthetic W/Aurelia brand-column data verified correct majority-vote confidence (18/20 rows → 0.9; 10/10 → 1.0). Cross-type false-positive checks (an MB51 sheet doesn't also match SOH/sales/etc.), garbage/empty/undefined input (never throws, always degrades to `'unknown'`), and the standalone fallback path (page with neither `RetailImport` nor `RetailProfiles` loaded) were all verified.
- **Commit:** none yet — uncommitted working-tree change (new file, not wired into anything).
- **Status:** user-approved and **explicitly LOCKED** (2026-07-29). Do not modify without an explicit new requirement — see §15.

**7.C — AI fallback tier: retailer detection + file-type classification**
- **Objective:** Build the AI tier of Decision 1 (AI-Assisted Retailer Detection) — called only when Phase B's deterministic rule tier can't reach high confidence on its own — plus the confidence-gated `auto`/`confirm`/Universal-Retail-Mode orchestration the locked architecture calls for. Strictly Tier 1 data only (AI Data Policy, §3.7): masked headers + value shapes + a short candidate-retailer label list, never per-row or per-style data.
- **Major implementation:** `api/map-schema.js` gets one additive `task:'classify'` branch (file-type only), reusing its existing `validateBody`/`assertMasked` egress guard completely unchanged — legacy callers (no `task` field) are byte-for-byte unaffected, verified by regression test. New `api/retail-knowledge.js` implements `task:'detect-retailer'` with its own copy of the proven auth/rate-limit/egress-guard skeleton (own independent rate-limit bucket, per this repo's existing per-endpoint convention) and a prompt whose candidate-retailer list comes from the *request*, not hardcoded server-side — a future retailer needs no server code change, only a longer list from the client (the concrete payoff of Phase B's registry generalisation carried through to the AI tier). New `retail-assist.js` addition `classifyFile()` (thin AI caller, mirrors `suggestBrands()`'s exact structure) and newly-exposed `buildSamples()` (previously private, now reused rather than duplicated). New `retail-knowledge.js` (client, ES module) is the orchestrator: `detectRetailer(sheets)` and `classifyFile(sheets)` both call Phase B's `RetailIntelligence` first and only reach for AI below `'high'` rule-tier confidence.
- **Important design decisions:** See §3.7's "Step C design decision" note — `retail-knowledge.js` grew a second orchestrator function (`classifyFile`) beyond the roadmap's literal wording, for a well-reasoned, documented reason. AI is never allowed to *downgrade* a rule-tier answer — the merge logic only swaps in the AI result when it reports a non-`'unknown'` retailer/fileType at *higher* confidence than the rule tier already had. `retailer:'unknown'`/`fileType:'unknown'` from the model is never reported above 0.5 confidence server-side (there is nothing to be confident about in "I don't know").
- **Testing (thorough, given no real `GEMINI_API_KEY` exists in this environment — same "verify up to the network boundary" methodology already established for the AI Executive Summary in Phase 5, not skipped):**
  - 24 server-side validator/sanitiser tests via the extract-and-eval technique (§14): full regression coverage confirming `api/map-schema.js`'s *existing* behavior (legacy no-`task` requests, `task:'brands'`, the original `sanitise()`) is byte-for-byte unchanged, plus full coverage of the new `task:'classify'` branch and every one of `api/retail-knowledge.js`'s egress-guard rejections (missing/too-many headers, unmasked digit, malicious candidate string, too many candidates, `ruleHint` validation, unexpected fields) and its `sanitise()` (unknown-candidate rejection, confidence clamping, "unknown" never high-confidence).
  - 8 tests of `retail-assist.js`'s new `classifyFile()` against every HTTP outcome (signed-out, 401, 429, 503, network error, malformed JSON, success, below-`MIN_CONF`) via a mocked `fetch`, plus a regression spot-check confirming `suggest()`/`suggestBrands()`/`maskValue()` are unaffected.
  - 7 integration tests of `retail-knowledge.js`'s orchestration via mocked `RetailIntelligence` + mocked `fetch` (loaded as real ES modules through a blob-URL `import()` with only the `firebase.js` import line substituted for a fake, mutable auth object — the actual production code paths, not a re-implementation): confirmed high rule-tier confidence genuinely skips the network call entirely for both `detectRetailer` and `classifyFile` (the cost-optimisation claim, not just asserted); confirmed a stronger AI answer overrides a weaker rule-tier one and recomputes `mode` correctly; confirmed AI failure (401) and a missing `RetailIntelligence` both degrade gracefully to the rule tier's own answer with `mode:'universal'`; confirmed an AI `'unknown'` response never overwrites a real rule-tier guess.
  - Final integrity check: `retail-decision.js` and all 6 tool files remain untouched (only the already-approved Phase 6.5 `SOH_Image_Link_Builder.html` change plus Phase 7's own new/additive files appear in the working tree).
- **Commit:** none yet — uncommitted working-tree change.
- **Status:** user-approved and **explicitly LOCKED** (2026-07-29). Do not modify without an explicit new requirement — see §15. (Step D below additively extends `api/retail-knowledge.js` and `retail-knowledge.js` with new, separate functions — it does not edit anything Step C built.)

**7.D — Retail Knowledge Intelligence: item-level enrichment (Tier 2)**
- **Objective:** Build Decision 2's item-level reasoning — `task:'enrich-items'` on `api/retail-knowledge.js`, `enrichItems()` on `retail-knowledge.js` — introducing the AI Data Policy's Tier 2 (deduplicated, capped item subset) for the first time in this app. Infer `brand`/`category`/`gender`/`productFamily`/`pricingTier` by reasoning **jointly** over every available field per item at once, never one field in isolation; every field independently confidence-gated, `null`/omitted below threshold.
- **Major implementation:** `api/retail-knowledge.js` gains `task:'enrich-items'` — same auth/rate-limit/Gemini-cascade skeleton, a new Tier 2 validator (`validateEnrichItemsBody`), a new prompt (`buildEnrichPrompt`), and a new sanitiser (`sanitiseEnrich`) that only trusts item keys the request actually sent and drops any field lacking a valid confidence rather than assuming one. The handler now peeks at `body.task` once, up front, to pick the right byte ceiling/validator/prompt/sanitiser — Step C's `task:'detect-retailer'` branch is untouched, same functions, same behavior. `retail-knowledge.js` gains `enrichItems(canonicalRows)`: deduplicates Phase A canonical rows by style code (ranked by combined qty/value so a hard 40-item cap drops the least business-impactful items first, the same "rank by impact, then cap" philosophy `retail-decision.js` already uses for its own top-N lists), skips the AI call entirely when nothing in the batch actually needs anything (same cost-optimisation discipline as Step C), and merges results back — never overwriting an already-known field, only filling gaps.
- **Important design decisions:**
  - **Description masking exception** — see §3.7's AI Data Policy Tier 2 entry for the full reasoning: descriptions are sent as real text (capped, digit-run-rejected) rather than shape-masked, because shape-masking would destroy the exact signal this task needs while protecting nothing the policy actually cares about (it's product-catalog text, not transaction/customer data).
  - **Synthetic request keys, not real style codes** — caught during design, before any code was verified: an early draft would have derived the request's item `key` field directly from the real style code, which (since `key` appears in the prompt row Gemini sees) would have silently leaked the real, unmasked style code text through a field not intended to carry data at all. Fixed by using position-based synthetic keys (`"i0"`, `"i1"`, ...) with the real style code kept only in a client-side lookup that is never transmitted — then verified directly (see Testing) that the real style code never appears in the outgoing request body.
  - **Schema-driven field scope, not a free design choice** — the locked Phase A schema's `intelligence` sub-object has confidence slots for `brand`/`category`/`gender`/`productFamily` but not for `colour` or a `pricingTier` confidence. Since Phase A cannot be modified, `enrichItems()`'s output scope was set to exactly what the locked schema supports; `colour`/`size` are used as input context for the joint reasoning, not as AI-enriched output fields (see §3.7 for the full note).
- **Testing (thorough, same "verify to the network boundary" methodology as Steps C and Phase 5, no real `GEMINI_API_KEY` in this environment):**
  - 22 server-side tests via extract-and-eval: 3 explicit regression checks confirming Step C's `task:'detect-retailer'` path (`validateDetectRetailerBody`, `sanitise`, `assertMasked`) is completely unaffected, plus full coverage of the new Tier 2 guard — valid item passes, too-many-items/duplicate-keys/bad-key-format rejected, unmasked digits in `styleCode`/`priceShape` rejected, **a description containing an embedded long digit run rejected while the same description without one passes as real readable text** (the key proof the design decision works both ways), a short digit run like a size "34" correctly allowed through, digit runs in label fields rejected, oversized fields rejected, and `sanitiseEnrich`'s unknown-key/missing-confidence/out-of-range-confidence dropping.
  - 8 client-side integration tests via the same blob-URL `import()` + mocked-`fetch` technique as Step C: cost optimisation verified (an already-fully-enriched row triggers zero fetch calls), **a direct security assertion that the outgoing request body never contains the real style code, barcode, or price text** (only the masked shapes and the real description, by design), the merge never overwriting an already-known `brand`, confidence-gating dropping a sub-threshold field, graceful fallback on AI failure (401), correct dedup (two rows sharing a style code produce exactly one AI request item and both rows get enriched), and regression confirmation that `detectRetailer()`/`classifyFile()` (Step C) still work unchanged after Step D's additions.
  - Final integrity check: `retail-decision.js`, all 6 tool files, and every Step A/B/C code path remain untouched — only the two files Step D was approved to extend show any diff.
- **Commit:** none yet — uncommitted working-tree change.
- **Status:** user-approved and **explicitly LOCKED** (2026-07-29). Do not modify without an explicit new requirement — see §15. (Step E below builds two wholly new files — it does not touch anything Step D built.)

**7.E — Context-Aware AI Assistant ("experienced retail business consultant")**
- **Objective:** Build the last step of the AI Intelligence Core roadmap (A→E) — a chat assistant that answers grounded in Decision Engine output, Retail Intelligence detection, Retail Knowledge Intelligence's enrichment rollup, and the current tool's own report context (the four sources user requirement 3 named), in the voice of an experienced consultant rather than a generic chatbot. Built modularly (requirement 7) so any future tool can plug in without tool-specific code in this file.
- **Major implementation:** New `api/chat.js` — same auth/rate-limit/Gemini-cascade skeleton as the other three AI endpoints, own rate-limit bucket (30/hr, 150/day — more generous, chat is naturally multi-message per session). The consultant persona (direct, concrete, grounded only in given data, INR/Indian digit grouping, redirects off-topic questions) lives entirely in `buildPrompt()`'s system instructions — every other endpoint returns a fixed JSON shape it fills in, this one free-answers in prose (still JSON-wrapped for parsing safety). New `retail-chat.js` — `ask(question, context)` is the only entry point a tool needs; it holds up to 8 turns of conversation history in memory (never persisted, never sent anywhere except back to `api/chat.js` on the next call) and ships four context-builder functions (`buildDecisionEngineContext`, `buildRetailIntelligenceContext`, `buildRetailKnowledgeContext`, `buildToolContext`) that normalise a real `evaluate()`/`classifyFileType()`/`detectRetailer()`/`enrichItems()` result into the exact capped shape the server expects — this is the concrete mechanism behind "modular, future tools automatically benefit" (requirement 7): a future caller passes its own real objects to these builders and gets a valid request, without needing to know the wire format.
- **Important design decisions:**
  - **The flagged privacy-boundary question was resolved by treating the Step E approval as its answer** — see §3.7's "How Step E's flagged privacy-boundary question was resolved" note for the full reasoning. Concretely: the user's own `question`/`history` text is exempt from the digit-run guard (it's their own authored words, not retailer data); every other context field stays exactly as guarded as every prior AI endpoint in this app.
  - **`retailKnowledge` context is a rollup, never raw enriched items** — sending Phase D's per-item `enrichItems()` output directly into a Tier 0 endpoint would be exactly the kind of tier violation the AI Data Policy exists to prevent. `buildRetailKnowledgeContext()` reduces it to counts + top-5 category/brand/family labels before it ever leaves the browser, and `api/chat.js`'s validator independently enforces the same shape server-side (an item-like field is rejected as "unexpected field," not just discouraged by convention).
  - **Not streaming.** The original architecture doc flagged streaming as chat's likely added complexity; Phase E instead reuses the exact same request/response pattern every other AI endpoint in this app already uses (requirement 4: reuse existing infrastructure), which is simpler, consistent, and sufficient for a first version. Noted as a possible future enhancement, not a Phase E gap.
  - **Not wired into `Store_Review a1.html`'s dead `#aiOverlay`/`btnAI` stub.** Every step so far (A–D) has been standalone, freestanding infrastructure; Step E's own requirements didn't explicitly ask for the UI wiring, and requirement 7's emphasis on modularity argues for a tool-agnostic module now, with actual wiring into a live tool page as a separate, explicitly-scoped future decision — the same posture the doc has held throughout Phase 7.
- **Testing (thorough, same "verify to the network boundary" methodology as every prior AI-tier step, no real `GEMINI_API_KEY` in this environment):**
  - 22 server-side tests via extract-and-eval: full request validation (valid full/minimal requests, empty/missing/oversized question), and critically, **two paired tests proving the asymmetric privacy design works both ways** — a long digit run inside `question`/`history` text is allowed through (the user's own words), while the identical digit run inside `decisionEngine`/`toolContext`/`retailKnowledge` fields is rejected (business data) — plus a dedicated test proving an item-shaped object smuggled into `retailKnowledge` is rejected as an unexpected field, not silently accepted. Also covered: history/card-list length caps, bad enum values (severity, retailerMode), out-of-range confidence, `sanitise()`'s answer-length capping, and a structural check that `buildPrompt()`'s output actually contains all four named context sections plus the conversation and the persona framing.
  - 16 client-side tests via the established blob-URL `import()` + mocked-`fetch` technique: all four context builders (correct capping/aggregation, `null` when there's nothing to report, and — for `buildRetailKnowledgeContext` — only counting rows actually enriched by AI, not every row), `ask()`'s full typed-failure-reason coverage (invalid question, signed out, 401/429/503/network/malformed-JSON, each with zero or correct fetch calls), confirmation the request body actually forwards the supplied context untouched, and history accumulating correctly across multiple calls while staying capped at 8 turns.
  - Final integrity check: `retail-decision.js`, all 6 tool files, and every Step A–D file remain byte-for-byte untouched — only the two new Step E files appear in the working tree beyond what Steps A–D and Phase 6.5 already added.
- **Commit:** none yet — uncommitted working-tree change.
- **Status:** complete and verified, awaiting user review. This completes the originally-planned Phase 7 (AI Intelligence Core) roadmap, A through E.

**First live-tool integration — `retail-chat.js` wired into `Store_Review a1.html`'s "Ask AI" (2026-07-29, planned via EnterPlanMode/ExitPlanMode, user-approved, implemented and verified)**
- **Objective:** Wire the AI Intelligence Core into its first real, user-facing tool, per user request for "a detailed integration plan for connecting the completed AI Intelligence Core into the first live production tool."
- **Critical finding made during planning, not assumed:** `Store_Review a1.html`'s `#aiOverlay`/`#btnAI` ("Ask AI") — previously described everywhere in this document (§3.5, §12, §15, old §17.3) as "dead markup… unwired… a placeholder" — was **not dead**. It was a fully functional, currently-live feature letting a user paste their own Anthropic API key into `localStorage` and calling `https://api.anthropic.com/v1/messages` directly from the browser (`fetch` with `x-api-key` header and `anthropic-dangerous-direct-browser-access:true`). This is precisely the anti-pattern this document's own §11 security principle #2 and §15 explicitly prohibit ("do not revive or repurpose"). It had been live and undocumented as such since before this conversation began. This integration retires it entirely.
- **Major implementation (`Store_Review a1.html` only — no other file touched):**
  - Deleted: `LS_KEY`/`LS_MODEL`, `getKey()`/`getModel()`, `buildAIContext()` (DOM-scraping context builder), `offlineAnswer()` (no-key canned-answer fallback), the direct-to-Anthropic `fetch()` call and its hardcoded system prompt/headers, the `#aiGear`/`#aiKeySave` handlers, and the `#aiSettings` markup + CSS (API-key entry panel) + `#aiGear` button.
  - Added: `buildStoreReviewToolContext()` (flat, scalar-only summary derived from the existing `AI_CONTEXT` object, for `RetailChat.buildToolContext()`), `buildStoreReviewDecisionContext()` (Store Review's first-ever **read** from the Decision Engine — `RetailDecision.loadSummaries()`+`evaluate()`, previously this tool only ever wrote via `saveSummary`), and a rewritten `askAI()` that calls `RetailChat.ask(question, {decisionEngine, toolContext})` instead of the browser-side Anthropic call.
  - Added `<script type="module" src="retail-chat.js"></script>` alongside `retail-insights.js`/`auth-guard.js`.
  - Reused as-is: the entire `.ai-overlay`/`.ai-panel` visual chrome, `renderChat()`, chip suggestions, close/backdrop/send/Enter-key wiring — this is a backend swap behind an unchanged, already-good chat UI, not a UI redesign.
  - Reworded the shared `AI_FAIL_MSG` map (previously Summary-specific wording) to be feature-neutral and added an `invalid_question` entry, since it's now used by both `#btnSummary` and the new `askAI()`.
  - Added a `RetailChat.clearHistory()` + `AI_CHAT=[]` reset at the point `render()` already rebuilds `AI_CONTEXT` on every period/file change — a deliberate behavior improvement over the old code (which never reset chat across period changes), flagged to and accepted by the user during planning: `retail-chat.js` sends its internal history as literal prior Gemini turns, so a stale conversation about a previous period could otherwise blend into a new answer.
- **Scope decision (confirmed with the user via AskUserQuestion before implementation):** only `decisionEngine` + `toolContext` are wired for this first integration. `retailIntelligence`/`retailKnowledge` context are explicitly **not** wired — Store Review has no file-type/retailer-detection or item-enrichment step of its own, and wiring either would require touching the paused, not-to-be-touched-without-a-real-test-file Phase 4 secondary-SOH-file code path (§7 Phase 4, §13 item 2). This remains true after this change: Phase 4 is still untouched.
- **Backward compatibility:** `#btnSummary`/`AI_CONTEXT`/`RetailInsights.summarize()`/`RetailDecision.saveSummary('storeReview', AI_CONTEXT)` — all unchanged, confirmed via direct in-browser regression testing (see Testing below).
- **Testing (same "verify to the network boundary" methodology as every prior AI-tier phase, no real `GEMINI_API_KEY`/Vercel deployment exists in this environment):** using the project's established disposable-copy technique (a never-committed copy of the tool with only `auth-guard.js`'s `location.replace("login.html")` line bypassed via a disposable copy of `auth-guard.js` too, both deleted after testing) —
  - Grepped the file post-edit for every old-code marker (`LS_KEY`, `getKey`, `buildAIContext`, `offlineAnswer`, `api.anthropic.com`, `aiSettings`, `aiGear`, `aiKeySave`, `aiKey`, `aiModel`): zero matches.
  - Confirmed `RetailChat.ask()` resolves `{ok:false,reason:'signed_out'}` with **zero** network requests to `/api/chat` in the default (signed-out) state of this dev environment — no faking needed, this is the real default.
  - Confirmed `buildStoreReviewToolContext()` produces 18 flat scalar keys from a realistic synthetic `AI_CONTEXT` (well under `buildToolContext()`'s 20-key cap) and `buildStoreReviewDecisionContext()` degrades cleanly to a valid empty-but-well-shaped result (`confidenceLevel:'none'`, empty arrays) when `localStorage` has no saved Decision Engine summaries.
  - Drove the real UI end-to-end via direct function calls (`openAI()` → set `#aiInput` → `askAI()`): overlay opens, user message renders, the reworded `AI_FAIL_MSG.signed_out` bubble renders correctly, `#aiSend` re-enables — confirmed via the actual rendered DOM, not just return values.
  - Confirmed the module-not-loaded defensive guard (`typeof RetailChat==='undefined'`) degrades cleanly to the "unavailable" message with no thrown error, by deleting `window.RetailChat` and invoking `askAI()` directly.
  - Regression-confirmed `#btnSummary` still calls `RetailInsights.summarize()`, `AI_CONTEXT` is unaffected, and the reworded `AI_FAIL_MSG` still renders sensibly for that feature too.
  - Confirmed via `render.toString()` that the new `clearHistory()`/`AI_CHAT=[]` reset sits immediately after the already-proven-reached `saveSummary`/`renderAiSummaryStale()` call site inside `render()`.
  - Zero console errors throughout. Both disposable copies deleted after testing; only `Store_Review a1.html` carries a diff (net 60 insertions / 101 deletions — smaller than before, since the insecure key-entry code was larger than its replacement).
  - **Cannot be verified in this environment (pre-existing, expected gap, not introduced by this change):** the real Gemini round-trip — no `GEMINI_API_KEY`/Vercel deployment exists here, exactly as already true for Phase 5, 7C, and 7D.
- **Adjacent, explicitly out-of-scope finding:** `privacy.html` (§16/§17.4) still describes the client-side-Anthropic-key pattern this change just deleted. Before this change, that policy line described dead-but-present code; **now the code it describes doesn't exist in this codebase at all**, while the real, live Gemini-backed processing (now including this newly-wired chat) still goes undisclosed. This makes the existing §17 Wave-0 "fix privacy.html" recommendation more urgent, not less — not actioned here, as it wasn't part of the approved plan for this specific change.
- **Commit:** none yet — uncommitted working-tree change.
- **Status:** implemented and verified per the plan above. This is the first Phase 7 module ever connected to a live tool; `retail-schema.js`/`retail-intelligence.js`/`retail-knowledge.js` and every other tool page remain unwired, as does Step E's own review/lock status (unaffected by this wiring work — this integrated Step E's already-built client module, it did not constitute the user reviewing/approving Step E's design itself).

**Not yet done:**
- Wiring `retail-schema.js`/`retail-intelligence.js`/`retail-knowledge.js` (file classification, retailer detection, item enrichment) into any tool — still standalone; Store Review was never a natural fit for these (see scope decision above), a different tool (e.g. Inventory Validity Console) would be the natural next candidate if this is pursued.
- Wiring `retail-chat.js` into any tool beyond Store Review.
- Reviewing/locking Step E's underlying design (`api/chat.js`/`retail-chat.js` themselves) — still awaiting that separate review, independent of this wiring work.
- Any further Phase 7 work beyond Step E (e.g. streaming for chat) — not currently planned.

(Phase 6 step 5's BlueDart half — previously listed here as paused — is now done; see §7, Phase 6.5b.)

---

## 8. Current State

### Current architecture
Static, client-side-only site (no build step, no bundler) plus two Vercel serverless functions for the two AI features. Firebase (Auth + Firestore) is the only backend service in active use for the core product; the Decision Engine's data layer is `localStorage` only — **no server-side persistence of business data exists anywhere in this system.**

### Current recommendation categories (in `retail-decision.js`)
| Category | Source(s) | Status |
|---|---|---|
| `coaching` | `storeReview` | ✅ Live |
| `atRisk` | `inventoryValidity` | ✅ Live |
| `attention` | `inventoryAudit` + `stockAdjustment` (merged/corroborated) | ✅ Live |
| `reorders` | *(planned: inventoryValidity × storeReview per-style)* | ❌ Always empty — deliberately not implemented; `storeReview`'s aggregate summary doesn't expose per-style sell-through, so a reorder call would be a guess |
| `transfers` | *(planned: multi-store correlation)* | ❌ Always empty — not yet wired |

### Dashboard capabilities (`index.html`, "Your Recommendations" panel)
- Hidden entirely for signed-out visitors.
- Shows a confidence badge (`High`/`Medium`/`Low`/none) with a tooltip explaining why.
- Shows a status chip per tool (6 total): fresh/aging/stale/not-connected, colour-coded.
- Renders every non-empty category as a titled section of Recommendation Cards, in a fixed priority order: **Needs Attention → Staff Coaching → Inventory At Risk → Reorder Suggestions → Transfer Suggestions**.
- Live-updates across browser tabs via the `storage` event.
- Empty state (no tool has ever saved data) points the user to Store Review.

### AI Summary status (Tier 1, Phase 5)
**Implemented, wired, unit-tested up to the network boundary. Never verified against a real Gemini response** — this repo/environment has no Vercel deployment and no `GEMINI_API_KEY`. Before relying on this in production, a real deployment test is recommended (see §16, Next Recommended Task, as an alternative to the Decision Engine work if that's preferred).

### Decision Engine status
All 6 tools wired: 4 primary (`storeReview`, `inventoryValidity`, `inventoryAudit`, `stockAdjustment`, driving `confidence` and the `coaching`/`atRisk`/`attention` categories) + 2 auxiliary/coverage-only (`sohImageLinks`, `blueDart` — light up their status chip only, never affect `confidence` or any recommendation category). No AI layer on top yet — 100% deterministic today.

---

## 9. Roadmap

### Completed
- Repository cleanup and canonical-file resolution (Phase 1).
- Shared CSS/UI foundation, evidence-based only (Phases 2–3).
- Partial business-logic migration investigation (Phase 4 — paused, not abandoned).
- AI Executive Summary for Store Review (Phase 5).
- Decision Engine core + 4 of 6 tool integrations + unified card model (Phase 6, steps 1–4).
- SOH Image Link Builder auxiliary wiring (Phase 6, step 5 — SOH half; see 6.5).
- BlueDart Waybill Builder auxiliary wiring (Phase 6, step 5 — BlueDart half; see 6.5b). **Phase 6 (steps 1–5) is now fully complete.**
- AI Intelligence Core canonical schema + tool adapters (Phase 7, Step A — **LOCKED**, see §3.7, §7).
- AI Intelligence Core rule-tier file-type + retailer classification (Phase 7, Step B — **LOCKED**, see §3.7, §7).
- AI Intelligence Core AI fallback tier + confidence-gated orchestration (Phase 7, Step C — **LOCKED**, see §3.7, §7).
- AI Intelligence Core Retail Knowledge Intelligence item enrichment (Phase 7, Step D — **LOCKED**, see §3.7, §7).
- AI Intelligence Core context-aware AI Assistant (Phase 7, Step E — see §3.7, §7). **This completes the originally-planned Phase 7 roadmap (A→E).**
- **First live-tool integration:** `retail-chat.js` wired into `Store_Review a1.html`'s "Ask AI," planned via an explicit plan-mode design pass (research → clarifying questions → written plan → user approval) and implemented/verified after approval — see §7's new entry. Retired a pre-existing, previously-mischaracterized live security issue (client-side Anthropic API key) in the same change.

### In Progress
- **Awaiting a separate design review of Step E** (`api/chat.js`/`retail-chat.js` themselves) before any further Phase 7 work or a decision to lock it — unaffected by the wiring work above, which consumed Step E's already-built client module rather than reviewing its design.
- Per user instruction (2026-07-29), stopping here for review after the Store Review AI-chat wiring — no further roadmap work started beyond this.

### Planned (not started, no code exists)
- Phase 7's A→E roadmap, as originally approved, is fully implemented; Step E's design review/lock is still open. One live-tool integration is now done (above); wiring `retail-schema.js`/`retail-intelligence.js`/`retail-knowledge.js` (file classification, retailer detection, item enrichment) into any tool remains **not yet requested** — Store Review was never a natural fit for those three, a different tool (e.g. Inventory Validity Console) would be the natural next candidate if pursued. Also not yet requested: anything beyond the original A–E scope (e.g. streaming for chat, a true multi-retailer configuration layer — see §3.7's Context section for what this design explicitly does not attempt).
- Fixing `privacy.html`/`terms.html`'s AI-disclosure accuracy (§17.4/§17.6 Wave 0) — more urgent now that the client-side-Anthropic-key code the policy describes no longer exists at all in this codebase, not just present-but-dormant.
- `reorders` category: needs `storeReview`'s aggregate summary extended with per-style sell-through data before it can be safely implemented (see §8).
- `transfers` category: needs either multi-store file support to be leveraged more generally, or server-side persistence (Firestore) so summaries from different managers/stores/sessions can be correlated — a real infrastructure step up, not yet designed in detail.
- Completing Phase 4 (business-logic migration for `Store_Review a1.html`'s secondary-file `kind==='soh'` branch) — blocked on the user providing a genuine W/Aurelia-house SOH export with an `EAN + Story Name` column shape.
- Porting the "Weekly Review" tab + coloured Excel export from `archive/Store_Business_Review.html` into the live `Store_Review a1.html` (flagged in Phase 1, never scheduled).
- Deduplicating the inline SheetJS/XLSX vendor blob across 5 of 6 tools (known technical debt, see §11).

---

## 10. Coding Standards

- **No build step.** Every shared JS file is either a classic `<script>` (UMD-style: `window.X` in browser / `module.exports` in Node, zero npm dependencies) or an ES module (`type="module"`, used only when `import` is needed). Do not introduce a bundler, transpiler, or npm dependency without discussing it first — this is a deliberate, longstanding architectural constraint.
- **Aggregate-only data leaving the browser.** Any new AI feature or Decision Engine summary must only ever transmit numbers/labels that are already displayed on screen as an aggregate — never a raw transaction row, barcode-with-context, or customer identifier. Enforce this server-side too (an "egress guard" validator), not just client-side, following the pattern in `api/map-schema.js`/`api/summarize.js`.
- **Every AI failure path must degrade gracefully.** No AI call should ever block a report from being generated. Follow `retail-assist.js`'s silent-null pattern when there's an equally-good non-AI fallback; follow `retail-insights.js`'s typed-reason pattern when there isn't.
- **Verify before you trust "looks similar."** Repeated lesson across every phase of this project: code that looks duplicated across tools (drag-drop wiring, column detection, reconciliation logic) frequently has real, non-obvious behavioral differences on close reading (multi-file vs. single-file, positional fallbacks, pairing algorithms, presence-only vs. quantity-diff semantics). Read the actual implementation before assuming two tools "do the same thing" and can share code.
- **One tool, one file.** The "one page per tool" convention is deliberate (matches `index.html`'s nav structure and Firebase-auth-guard's page-based gating). Do not consolidate tools into a single multi-tab page or split a tool across multiple pages without discussion.
- **Test with a fresh browser tab, not a reused one.** This project's own testing uncovered that reused browser tabs return stale `localStorage`/DOM state that looks like a bug but isn't — always `tabs_create` a fresh tab (or equivalent) before asserting behavior.

---

## 11. Security Principles

1. **Never call `initializeApp()`** outside `firebase.js`.
2. **Never store or transmit an AI provider API key from the browser.** All AI calls go through a Vercel serverless function reading the key from an environment variable.
3. **Never send row-level or raw transactional data to any AI endpoint.** Mask (column-mapping) or aggregate (executive summary / Decision Engine) before it leaves the browser, and re-validate server-side.
4. **Every AI endpoint requires a verified Firebase ID token** (RS256 signature check against Google's public certs) and a per-user rate limit. Fail closed on any auth/parse error.
5. **The free/premium quota in `auth-guard.js` is a fair-use guard, not a security boundary** — documented as such in the source. Do not present it as real access control in any future feature.
6. **Never create real accounts or enter credentials as part of testing or development.** This is a hard rule that was upheld throughout this conversation even when it made testing harder (see Phase 6.1) — when Firebase auth-gated behavior needs testing and no valid session exists, use a disposable, uncommitted local copy with only the auth *gate* bypassed, never the business logic, and never real credentials.

---

## 12. Important Architectural Decisions

- **Decision Engine lives in `index.html`, not a separate page.** Explicit user direction in Phase 6 planning, overriding the original design proposal. Any future Decision Engine UI work should extend the existing `#decisionPanel` in `index.html`, not create a new page.
- **`localStorage` blackboard, not a database, for cross-tool data sharing (for now).** Chosen because it requires zero new backend infrastructure and works within the existing all-client-side architecture. Explicitly understood as a stopgap — see §9 (Planned) for what would need to change (Firestore-backed persistence) to support true cross-session/cross-store correlation.
- **Auxiliary vs. primary tools is a real, load-bearing distinction**, not just documentation. `sohImageLinks` and `blueDart` deliberately do not count toward Decision Engine confidence and were deliberately excluded from the first four integration steps — they don't produce comparable "aggregate risk/opportunity" signals the way the other four do.
- **The Recommendation Card model is the contract for all future categories.** Any new recommendation category (reorders, transfers, or anything else) must produce cards in the `{category, title, context, reason, metricLabel, metricValue, severity, evidence}` shape so `index.html`'s single generic renderer keeps working without modification.
- **`Store_Review a1.html`'s "Ask AI" UI is no longer the client-side-API-key anti-pattern.** *(Corrected 2026-07-29 — this was previously, incorrectly, described as dead/reserved markup; it was in fact live. See §3.5, §7.)* It now calls `retail-chat.js`/`api/chat.js`, the same server-side pattern as every other AI feature. The retired client-side-Anthropic-key approach must still be treated as a reference for *what not to do*, not reused, in this or any future feature.
- **Recommendation logic is deterministic by design**, not an LLM call. Any future AI narration sits on top of already-computed cards, and must not replace the underlying rule-based logic — this preserves auditability (a manager can check any recommendation against the source tool's own report).
- **Corroboration outranks raw value.** In the `attention` category, a recommendation confirmed by two independent tools is ranked above a single-source recommendation of much higher monetary value. This was a deliberate design choice, verified in testing (a ₹6,010 corroborated item ranked above a ₹1,20,000 single-source item).

---

## 13. Known Technical Debt

1. **Inline vendor library duplication.** 5 of 6 tools embed the full SheetJS/XLSX library inline (a multi-hundred-KB blob each); only `Stock_IN_OUT_Adjustment.html` loads it from a CDN. Identified in Phase 0 as the single largest byte-count duplication in the repo. Not yet acted on — no task has touched this.
2. **Phase 4 (business-logic migration) is incomplete, not abandoned.** Blocked on the user providing a real W/Aurelia-house SOH file with an `EAN + Story Name` column shape to safely test the one identified candidate (`Store_Review a1.html`'s secondary-file `kind==='soh'` branch).
3. **`archive/Store_Business_Review.html`'s "Weekly Review" tab** (coloured Excel export, richer KPI layout) was never ported to the live `Store_Review a1.html`. Flagged in Phase 1, not scheduled.
4. **AI Executive Summary has never been tested against a real Gemini response.** No Vercel deployment or API key exists in this development environment. Treat the feature as "implementation complete, production-unverified" until that gap is closed.
5. **`.claude/launch.json` references a session-specific temp path** for its local dev server script and will not work in a fresh conversation/session without regenerating the PowerShell server script (see §14).
6. **No automated test suite exists anywhere in this repo.** All verification in every phase has been manual (browser-based, ad hoc scripts via dev tools), because there is no build tooling, no Node runtime available in the working environment, and no CI configured. See §15.

---

## 14. Testing Strategy

There is **no automated test suite** and no CI. All testing to date has been manual, browser-driven, and ad hoc, using whatever local static server is available. The methodology that proved reliable across every phase of this project:

- **Local dev server:** this environment has no working `python`/`node`/`npm` (the `python`/`python3` commands only resolve to non-functional Windows Store alias stubs). A minimal PowerShell-based static file server was written from scratch (`static-server.ps1`, using `System.Net.HttpListener`) and wired into `.claude/launch.json` under the config name `retail-ai-static` on port 8000. **A new session will need to recreate this script** (the path in `launch.json` is tied to the previous session's temp directory) — the script itself is short (a `param(Port,Root)` HttpListener loop serving files with a MIME-type map) and can be rewritten in a few minutes if `python`/`node` are still unavailable; check those first, they may just work in a fresh environment.
- **Always use a fresh browser tab**, never a reused one — stale tabs were found to return misleading `localStorage`/DOM state (see §10).
- **For auth-gated pages when no valid Firebase session exists** (and creating one is prohibited): make a disposable, **never-committed** copy of the file, remove/bypass only the auth *redirect* line, test the business logic (which is identical to the real file), then delete the copy. This was necessary repeatedly in Phase 6 because the test session's Firebase login had been intentionally signed out while verifying the auth-guard fix in Phase 5.
- **Prefer real sample data over synthetic when available.** `_test_data/` holds two genuine production-shaped files (a Jaypore SOH export, a W item master) used for real-data verification of Inventory Validity Console. When real files aren't available (Inventory Audit's 3-file format, Stock Adjustment's 2-file format), synthetic files were constructed carefully to match the tool's actual expected column headers/synonyms — and in two cases, this process **surfaced real, previously-undocumented business logic** (Inventory Audit's same-value pairing algorithm; Stock Adjustment's presence-only vs. quantity-diff semantics) that had to be understood before the test data (and the correlation logic depending on it) could be considered correct.
- **Verify server-side validation logic by extracting and running it in-browser.** Since there's no Node runtime, `api/map-schema.js`'s and `api/summarize.js`'s pure validation functions were tested by fetching the source text, slicing out the non-Node-specific parts, and `new Function()`-evaluating them in the browser — a workable substitute for unit testing serverless code without a Node environment.
- **Console-error checks and computed-style/DOM assertions** via the browser devtools JS execution are the primary correctness signal throughout — always check `read_console_messages` after any interaction, not just after page load.

---

## 15. Things Claude Must Never Change Without Approval

- **Do not create Firebase accounts, sign in with real credentials, or enter any password**, even for testing purposes. This rule was upheld throughout this project and directly shaped the testing methodology in §14.
- **Do not revive or repurpose the client-side-API-key "Ask AI" pattern.** This code was found to be live (not dead, as previously documented) and was retired from `#aiOverlay`/`btnAI` in `Store_Review a1.html` on 2026-07-29 (see §3.5, §7). Any conversational AI feature — in this tool or any other — must use the server-side, Firebase-gated, egress-guarded pattern established by `retail-assist.js`/`retail-insights.js`/`retail-chat.js`.
- **Do not force a tool onto `retail-import.js`, `retail-ui.js`, or any other shared module** without first reading its actual current implementation end-to-end. Every phase of this project found real, load-bearing differences between tools that looked superficially similar.
- **Do not send row-level data to any AI endpoint**, and do not weaken the egress-guard validators in `api/map-schema.js`/`api/summarize.js` without an explicit, separate discussion.
- **Do not create a separate Decision Engine page.** It lives in `index.html` by explicit user direction.
- **Do not delete `archive/`** — it's a preserved historical record of superseded forks, including the still-unported "Weekly Review" feature.
- **Do not commit anything from `_test_data/`** — it's real (if low-sensitivity) sample business data, kept locally, untracked on purpose.
- **Do not push to GitHub without explicit instruction.** As of this document, `main` is 10 commits ahead of `origin/main` and nothing has been pushed — this has been a deliberate, repeated instruction across every phase.
- **Do not add a build step, bundler, or npm dependency** without discussing it first.
- **Do not add new recommendation categories that skip the Recommendation Card shape.**
- **Do not touch the file currently mid-decision** without re-confirming scope: the Phase 4 migration target in `Store_Review a1.html` (blocked on a real test file). (`Store_Review a1.html`'s Ask-AI UI is no longer a mid-decision item — it was wired to `retail-chat.js` on 2026-07-29, see §7.)
- **The Phase 7 AI Intelligence Core architecture is explicitly LOCKED** (user direction, 2026-07-29 — see §3.7). Do not redesign the canonical schema, the thin/thick adapter split, the AI Data Policy tiers, the retailer-detection three-way outcome (auto/confirm/Universal Retail Mode), or the phase order (A→B→C→D→E) without the user explicitly requesting an architecture change. Implement it phase-by-phase, stopping for review after each phase, exactly as directed.
- **Phase 6 (Retail Decision Engine, all 5 steps) is explicitly LOCKED** (user direction, 2026-07-29 — see §7, Phase 6.5b). Do not redesign `retail-decision.js`'s correlation logic, the Recommendation Card shape, the primary-vs-auxiliary tool distinction, or either auxiliary tool's `saveDecisionSummary()` wiring without an explicit new requirement.

---

## 16. Next Recommended Task

Phase 6 (all 5 steps, now **LOCKED**) and Phase 7's A→E roadmap (A–D **LOCKED**, E awaiting review) are both fully implemented. Per user instruction (2026-07-29), a full project-wide "roadmap to v1.0" analysis was requested next — see the new §17, which is the authoritative next-step reference going forward (this section is retained for phase-boundary history only). No code should be written until the user approves a specific item from §17.

Superseded candidates (resolved or absorbed into §17):
- Review/lock Step E → still open, now tracked as a §17 item.
- Decide on wiring Phase 7 modules into a live tool → still open, now tracked as a §17 item.
- Commit the work → still open (nothing from Phase 6.5/6.5b/Phase 7 has been committed — see §8), now tracked as a §17 item.
- Verify AI Executive Summary against a real Gemini deployment → still open, now tracked as a §17 item.
- Resume Phase 4 → still blocked on the user providing a real test file (§7, Phase 4; §13 item 2) — unchanged.

---

## 17. Roadmap to Version 1.0 (analysis only — 2026-07-29, awaiting user approval, nothing implemented)

**Requested by the user** immediately after approving/locking Phase 6 Step 5, as a full project-wide stocktake before any further code is written. This section is pure analysis — no files were changed to produce it, beyond grounding checks (reading `firebase.js`, `privacy.html`/`terms.html`, `api/*.js`'s rate-limiter, repo root for config files). **Nothing below is authorized for implementation until the user picks specific items.**

### 17.1 Remaining unfinished roadmap items (already known, carried forward)
- `reorders` category — always empty; needs `storeReview`'s aggregate summary extended with per-style sell-through data (§8, §9).
- `transfers` category — always empty; needs multi-store correlation or Firestore-backed cross-session persistence (§8, §9).
- Phase 4 (Store Review secondary-file `kind==='soh'` migration to `retail-import.js`) — blocked on the user supplying a real W/Aurelia SOH file with an `EAN + Story Name` shape (§7 Phase 4, §13 item 2).
- "Weekly Review" tab + coloured Excel export from `archive/Store_Business_Review.html` — flagged in Phase 1, never scheduled (§9, §13 item 3).
- Phase 7 Step E's underlying design (`api/chat.js`/`retail-chat.js`) — built and self-tested, but not yet reviewed/locked by the user (unaffected by the wiring below).
- Wiring `retail-schema.js`/`retail-intelligence.js`/`retail-knowledge.js` into a live tool page — `retail-chat.js` is now wired into `Store_Review a1.html`'s "Ask AI" (2026-07-29, see §7), the first Phase 7 module connected to a live tool; the other three remain standalone.
- Inline SheetJS/XLSX vendor blob deduplication across 5 of 6 tools — identified Phase 0, never actioned (§13 item 1).
- Nothing from Phase 5, 6, or 7 has been committed or pushed — 10 local commits ahead of `origin/main`, plus a large uncommitted working tree.

### 17.2 Technical debt (existing + newly identified this pass)
Existing (§13, unchanged):
1. Inline vendor library duplication (5 of 6 tools embed SheetJS in full).
2. Phase 4 incomplete.
3. "Weekly Review" tab never ported.
4. AI Executive Summary never tested against a real Gemini response.
5. `.claude/launch.json` / local static server is session-specific (now regenerated this session, but will need regenerating again in a fresh session unless committed — it's gitignored-in-spirit but there's no actual `.gitignore`, see below).
6. No automated test suite anywhere; all verification has been manual/browser-driven.

**Newly identified this pass:**
7. **No `.gitignore` exists in the repository at all.** `_test_data/` and any future disposable test copies rely entirely on manual discipline ("never `git add` these") rather than tooling enforcement. One careless `git add -A` would commit real (if low-sensitivity) sample business data. Low effort to fix, meaningful risk reduction.
8. **The AI endpoints' rate limiter is in-memory (`new Map()` at module scope) in all four `api/*.js` files**, not backed by any shared store (Redis/Vercel KV/Firestore). On Vercel, concurrent or cold-started serverless invocations do not share memory, so the documented "20/hour, 100/day" (or 30/150 for chat) limits are enforced **per warm instance**, not truly per-user globally. This under-delivers on the abuse/cost-control guarantee the code's own comments claim, though it's not a security hole (the Firebase-auth gate and egress guards are unaffected) — it's a cost-control/abuse-resistance gap that matters once real traffic exists.
9. No `package.json`, no CI config (`.github/workflows` or equivalent), and no `vercel.json` in the repo — deployment configuration for the 4 serverless functions is presumably done entirely through the Vercel dashboard/CLI outside this repo, meaning it isn't version-controlled or reviewable here.

### 17.3 Missing integrations
- **Update (2026-07-29, post-analysis): `retail-chat.js` is now wired into `Store_Review a1.html`'s "Ask AI"** — the first Phase 7 module connected to a live tool. `retail-schema.js`/`retail-intelligence.js`/`retail-knowledge.js` (file classification, retailer detection, item enrichment) remain standalone, wired into zero live tools — Store Review was never a natural fit for these three (no file-type/retailer-detection or item-enrichment step of its own).
- ~~`Store_Review a1.html`'s `#aiOverlay`/`btnAI` UI is dead markup reserved for `retail-chat.js`, never connected.`~~ **Superseded** — this was itself a factual error in this document: the UI was never dead, it was a live, insecure client-side-Anthropic-key chat (see §7's new entry). It is now connected to `retail-chat.js` and the insecure code has been removed entirely.
- `BlueDart_Etail_Waybill_Builder1.html` and `SOH_Image_Link_Builder.html` are coverage-only in the Decision Engine — real signals (declared value, IST mismatches, brand mix) are captured but never feed any recommendation category, by original design (§12) — this is intentional, not a gap, but worth listing since "integration" could be read either way.
- No integration between the Decision Engine and Firestore — everything is `localStorage`-only, so recommendations never survive a browser reset, are never visible to a district/area manager across stores, and never correlate data from more than one manager's session (this is what blocks `transfers`, see 17.1).

### 17.4 Production readiness gaps
Beyond what §13 already documents, this pass found two concrete, previously-undocumented gaps:

1. **`privacy.html` is factually out of date relative to the shipped AI architecture, and appears to always have been** (its "Last updated" date, 26 July 2026, predates even the pre-existing AI column-mapping assist, which the doc itself says pre-dates this conversation). **Update (2026-07-29): this gap is now more urgent, not less.** Section 05 ("The Ask AI feature") describes the client-side-API-key Anthropic pattern as a currently-offered opt-in feature — at the time this was written, that code was in fact still live (see §7's new entry, a correction to this document's own prior "dead markup" mischaracterization); as of the Store Review AI-chat wiring, that code has been **deleted entirely**, so the policy now describes a feature that doesn't exist in the codebase at all, while remaining silent about the real, live Gemini processing (including chat) that does. It says nothing about:
   - Gemini (Google) as the actual AI provider for all four real, live server-side endpoints (`api/map-schema.js`, `api/summarize.js`, `api/retail-knowledge.js`, `api/chat.js`).
   - The fact that column headers/value shapes, aggregate report numbers, and (once Step E ships) the user's own typed chat questions are sent server-side to Gemini via Vercel.
   - Vercel as an infrastructure/service provider.
   `terms.html`'s "Third-party services" section is vague enough to not be technically false, but doesn't name Gemini/Google AI or Vercel either. **This is a real legal-accuracy gap, not a wording nitpick** — a privacy policy that describes a feature that doesn't exist while staying silent about the AI processing that actually does happen is a genuine compliance risk for a product handling business (and, in the chat case, user-authored) data. This should be fixed before any public/paying launch, independent of any other engineering work.
2. **In-memory, per-instance rate limiting** (17.2 item 8) — acceptable at current near-zero traffic, becomes a real cost/abuse exposure at real scale, since `GEMINI_API_KEY` spend is the thing being protected.

Carried forward from §13/elsewhere, restated in production-readiness terms:
3. **Zero real-world verification of any Gemini call.** All four AI endpoints (map-schema classify/brands, summarize, retail-knowledge detect-retailer/enrich-items, chat) have been tested only up to the outgoing HTTP request in this environment (no `GEMINI_API_KEY`, no Vercel deployment). Prompt correctness, response-shape assumptions, and latency are all unverified against the real model.
4. **No automated tests, no CI.** Every regression check across 7 phases has been manual and ad hoc (browser devtools, extract-and-eval). This scales poorly and risks silent regressions as the codebase grows, especially once Phase 7 modules get wired into live tools.
5. **The free/premium quota (`auth-guard.js`) is explicitly documented as "a fair-use guard, not a security boundary"** (§11 item 5) — real enforcement would require a server-side check before report generation, not a client-side `<a download>` click interceptor. Fine for a soft launch to trusted users; not fine if/when a paid tier is introduced with real revenue at stake.
6. **Firestore security rules are not part of this repository** and were not reviewed this pass — there is no way to confirm from the code alone that `users/{uid}` documents (auth-guard quota data) or any other Firestore collection are locked down to the owning user only. This needs verifying directly in the Firebase console/CLI, not just inferred from client code.
7. **No error monitoring / observability** — no Sentry-equivalent, no structured logging, no alerting on AI-endpoint failure rates, rate-limit trips, or Firebase auth errors. Failures currently fail silently to the end user (by design, per the "never block a report" principle) but are equally invisible to the team running the product.
8. **Page weight** — 5 of 6 tools embed the full SheetJS library inline; `BlueDart_Etail_Waybill_Builder1.html` alone is ~1.9MB, `Inventory_Validity_Console.html` ~1.9MB. Untested on a throttled/mobile connection, which is a realistic usage context for store-floor managers.

### 17.5 Features required before public launch
Synthesizing 17.1–17.4 into what a real public (even soft) launch needs, roughly in "must / should / nice" order:

**Must-have (blocking):**
- Fix `privacy.html` (and check `terms.html`) to accurately describe the real, live Gemini-backed AI processing across all four endpoints, and remove or clearly re-scope the dead client-side-Anthropic-key description in §05.
- At least one real, live Gemini deployment test (a real Vercel deploy + real `GEMINI_API_KEY`) for all four AI endpoints, not just up to the network boundary.
- Verify Firestore security rules directly (not inferred) for the `users` collection and any other collection in use.
- Decide the fate of the rate limiter (17.2 item 8) — acceptable to ship as-is for a low-traffic soft launch, but should be a known, explicit decision, not an oversight.

**Should-have (strongly recommended before charging money / scaling traffic):**
- Some minimal error monitoring/alerting for the 4 serverless functions and client-side auth flows.
- A real server-side check for the free/premium quota before treating it as a monetization boundary.
- A `.gitignore` (trivial effort, real hygiene benefit).
- At least a light automated regression suite for `retail-decision.js`'s pure `evaluate()` logic and the egress-guard validators, given how much manual re-verification every phase has required — this is the single highest-leverage place to add tests, being pure/deterministic and already exhaustively hand-tested.

**Nice-to-have (can follow launch):**
- Vendor-blob deduplication (page-weight/perf).
- Decide on wiring Phase 7 into a live tool (or explicitly deciding not to, for now).
- `reorders`/`transfers` categories.
- Phase 4 completion (blocked on real test data anyway).
- "Weekly Review" tab port.

### 17.6 Prioritized roadmap to v1.0 (proposed sequencing — as of 2026-07-29; Wave 2 item 7's chat half is now done, see status note)

**Wave 0 — Immediate, no dependencies, low risk:**
1. **Fix `privacy.html`/`terms.html` AI-disclosure accuracy (17.4 #1) — now MORE urgent, not less.** Still not actioned. The client-side-Anthropic-key feature the policy describes has since been deleted entirely (see §7's new entry), so the gap between what the policy says and what the code does has widened, not narrowed.
2. Add a `.gitignore` (`_test_data/`, any `*_TEST_DISPOSABLE*` naming convention, OS/editor cruft). Not yet actioned.
3. Review and decide on Step E's underlying design (`api/chat.js`/`retail-chat.js` themselves, lock or request changes) — closes out Phase 7's originally-approved A→E scope either way. Not yet actioned; unaffected by item 7 below (consuming an already-built module is not the same as reviewing its design).

**Wave 1 — De-risking what's already built:**
4. Real Gemini deployment test for all 4 AI endpoints (needs a Vercel project + real API key — an infrastructure/access decision, not just code). Not yet actioned.
5. Verify Firestore security rules directly. Not yet actioned.
6. Explicit decision on the rate limiter (accept as-is for soft launch vs. move to a shared store). Not yet actioned.

**Wave 2 — Closing the loop on what's standalone:**
7. ~~Decide whether/how to wire Phase 7 (retailer detection, item enrichment, chat) into at least one live tool~~ — **Chat half done (2026-07-29):** `retail-chat.js` is now wired into `Store_Review a1.html` (see §7's new entry), planned and approved via an explicit plan-mode pass before implementation. **Retailer detection / item enrichment half still open** — `retail-schema.js`/`retail-intelligence.js`/`retail-knowledge.js` remain standalone; a different tool (e.g. Inventory Validity Console) would be the natural next candidate if pursued.
8. **If chat is wired in: revisit `privacy.html` again for the chat-specific data flow (user's own question text reaching Gemini).** Chat is now wired in (item 7) — this is folded into item 1's now-heightened urgency, not a separate future trigger.

**Wave 3 — Hardening for scale/money:**
9. Server-side enforcement of the premium quota (if monetization is planned). Not yet actioned.
10. Minimal error monitoring/alerting. Not yet actioned.
11. A small, targeted automated test suite for `retail-decision.js` and the egress guards. Not yet actioned.

**Wave 4 — Polish / technical debt (can interleave with above, not blocking):**
12. Vendor-blob dedup for page weight. Not yet actioned.
13. `reorders`/`transfers` categories (needs 17.1's prerequisites). Not yet actioned.
14. Phase 4 completion (blocked on user-supplied test file). Not yet actioned.
15. "Weekly Review" tab port. Not yet actioned.

**Not recommended to schedule yet:** anything requiring a redesign of Phase 6 or Phase 7's locked architecture — none of the above needs one; every item is additive or operational. (The Store Review wiring work confirmed this in practice: it called existing locked modules from a new location without modifying any of them.)

**Status:** analysis complete (2026-07-29). One item (Wave 2 #7, chat half) has since been implemented and verified, per explicit user request and a plan-mode design pass — see §7's new entry. All other items remain unactioned, awaiting the user's selection of which to authorize next.

---

## 18. Post-Phase-7 work (2026-07-29 – 2026-07-30) — UX polish, Universal Intelligence rollout, AI certification

Everything in this section happened after §17's roadmap was produced, each as its own explicitly-scoped, user-directed task, each independently audited before implementation and verified after. All still uncommitted (see Repository Status above). This section is a summary-level record, not the exhaustive per-decision style of earlier sections — the detail lives in this session's own history; what matters for a future session picking this up cold is *what changed and why*, captured here.

### 18.1 Homepage/UX polish (5 issues fixed, `index.html` + `SOH_Image_Link_Builder.html`)
Following a first-time-user product audit, fixed in ascending scope: **UX-01** hero stat corrected from "10+ AI Tools" to "6 Live Tools" (matches the real live-tool count exactly). **UX-02** testimonial attribution changed from plural role labels ("Store Managers") to honest singular anonymized attribution ("A Store Manager") — deliberately did *not* fabricate specific named individuals, since that would be worse than the original issue. **UX-03** added the previously-undiscoverable Stock IN/OUT Adjustment tool card to the homepage grid (a fully-built, tested tool with zero prior homepage link). **UX-04** unified tool names across the homepage grid and the dashboard's `TOOL_LABEL` map (e.g. "SOH Audit" → "Inventory Audit Tool"), converging on the dashboard's pre-existing, more-canonical names rather than touching the map or any tool's own internal branding. **UX-05** added a "Try with sample data" button to SOH Image Link Builder (the simplest, lowest-risk of the 5 tools that lacked one), reusing Stock IN/OUT Adjustment's existing pattern; a bug (calling the real `loadSheet()` would have thrown on a null `wb`) was caught and fixed during implementation, before shipping. All five verified via direct browser interaction; zero console errors; zero UI regressions found in any prior work.

### 18.2 Universal Intelligence rollout — 3 of 6 tools (`retail-intelligence.js`, Phase 7 Step B, was fully built, tested, and connected to zero live tools before this)
A proven, identical **"confirm, never override"** pattern was applied to three tools in sequence, each audited for fit before implementation, each verified against real data after:
- **BlueDart** (first, lowest-risk): `WB.classify()` remains the sole authority for what actually happens; `RetailIntelligence.classifyFileType()` is called alongside it purely to confirm agreement. A real edge case was found and designed around (per-sheet-priority vs. per-type-across-all-sheets scanning could theoretically disagree on a contrived multi-sheet file) — not realistic for BlueDart's actual usage, but the merge strategy was built to be safe regardless.
- **Inventory Validity Console** (second): `RetailIntelligence.detectRetailer()` confirms `RetailImport.detectHouse()`'s existing retailer/house detection. Verified against the real 46,523-row Jaypore file in `_test_data/` — which turned out to be tab-delimited text with a `.xls` extension (a real SAP export quirk), revealing a **pre-existing, unrelated gap**: that file format bypasses `updateHousePrefix()` entirely via a different code path (`IVC.parseDelimited()`), so house detection (old and new) never runs for it. Not fixed — out of scope for a "connect the existing module" task; recorded here for a future, separately-scoped fix.
- **Store Review** (third): `RetailIntelligence.classifyFileType()` confirms the tool's own long-standing bare "BillNo column present?" check.
- Each integration: same script include added, same tiny confirming-only helper, zero UI change, zero change to `retail-decision.js`, zero change to `retail-intelligence.js` itself. Only 3 of 6 tools fit this pattern — Inventory Audit and Stock IN/OUT Adjustment's actual file shapes (product master, physical scan) don't correspond to any of `retail-intelligence.js`'s known file types, confirmed by that module's own header comment; connecting them would mean inventing new detection rules, explicitly out of scope.

### 18.3 Store Review ↔ Retail Chat data bridge
`Store_Review a1.html`'s `SALES_RI_RESULT` (produced by 18.2's integration) is now passed into `RetailChat.buildRetailIntelligenceContext()` on every Ask AI question — connecting two things built independently (Universal Intelligence's detection result, and Retail Chat's already-existing, already-tested context builder) that had simply never been wired together. 3 lines changed in `Store_Review a1.html`; nothing else touched. Verified by intercepting the actual call to `RetailChat.ask()` and confirming the context object is correctly shaped.

### 18.4 AI production-readiness certification (two phases)
**Phase 1 (audit only):** inspected all seven AI-touching client/server pairs. Finding, stated plainly: **the AI code itself is genuinely sound** (real Gemini endpoint, real current model names in a self-updating "-latest alias first" cascade, strong explicit anti-hallucination prompt instructions in all four endpoints, robust timeout/network/malformed-response handling, correct Firebase RS256 token verification with no bypass path, no hardcoded keys anywhere) — but **no AI feature has ever completed a real round-trip to Gemini**, because no `.env`, `.vercel` link, or `GEMINI_API_KEY` has ever existed in any development environment this project has used. Every endpoint fails closed (503 `ai_not_configured`) rather than faking a response — confirmed by direct inspection, not assumption. Also confirmed precisely which AI features are actually reachable by a real user today (AI Summary, Ask AI, the original column-mapping "suggest"/"brands" tasks) versus fully built but unreachable (`task:'classify'`, `task:'detect-retailer'`, `task:'enrich-items'` — all only ever called via `retail-knowledge.js`, which is not loaded by any tool page).

**Phase 2 (implementation, narrowly scoped to "only fix what's required for deployment readiness"):** found exactly two genuine gaps and fixed only those. (1) Zero server-side log trace anywhere when `GEMINI_API_KEY` is missing — added one `console.error` line to each of the four `api/*.js` files' existing early-return branch, logging only the fact, never a secret. (2) No `package.json` — and all four endpoints rely entirely on Node's native global `fetch` (confirmed zero polyfill/import anywhere) which requires Node ≥18; added a minimal `package.json` (`engines.node >=18.0.0`, zero dependencies) and a `.vercelignore` (excludes `_test_data/`'s real business data and `.claude/` from any deployment). Nothing else changed — no prompts, no models, no timeouts, no business logic, no client-side code. All four edited endpoints were syntax-checked and functionally executed against mocked request/response objects (same extract-and-eval technique this project has used since Phase 5), confirming byte-identical response behaviour in both the "key missing" and "key present" paths.

### 18.5 Live Gemini Test Plan (recorded for when a real deployment exists)
A full checklist was produced (not yet executed — no real key/deployment exists): exact Vercel env-var and deployment steps; **AI Summary recommended as the first feature to test** (simplest, most mechanically checkable — a clean pass gives confidence in the shared connectivity skeleton before testing the more complex Ask AI); 10 concrete test cases spanning grounding, the critical "can the model admit it doesn't know" honesty test, multi-turn context, and off-topic redirection; a hallucination-detection methodology (trace every claim back to the exact context sent, treat anything untraceable as a failure); explicit success/failure criteria; and a rollback plan — the cleanest available: removing `GEMINI_API_KEY` and redeploying instantly disables all AI features while leaving every non-AI tool (all 6 report generators, the Decision Engine, Universal Intelligence's rule tier) completely unaffected, since none of them depend on Gemini at all.

### 18.6 What remains true, unchanged by any of the above
Everything in §15 ("Things Claude Must Never Change Without Approval") still holds. `retail-decision.js`, `retail-intelligence.js`, `retail-schema.js`, `retail-knowledge.js` (Steps C/D) remain exactly as locked. No architecture was redesigned at any point in this pass — every change above is additive (a new script include, a new confirming function, a new log line, a new config file) or a pure data-plumbing connection between two already-built, already-tested pieces.

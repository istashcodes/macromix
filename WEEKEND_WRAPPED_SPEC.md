# 🎬 Macromix Weekend Review Wrapped — Architecture & Specification

> **Source of Truth & Reference Specification** for the Spotify-style Weekend Review Wrapped story engine, dynamic weekly edition rollover, and mobile reel experience in Macromix.

---

## 1. Overview & Cadence

* **What it is:** A Spotify Wrapped-inspired 9:16 mobile reel reviewing the user's weekly nutrition, macro density, top foods, habit wins, intelligent food swaps, and custom archetype persona.
* **Release Timing:** Available every **Friday morning through Sunday midnight** (Day 5, 6, 0).
* **Entry Point:** An Instagram Stories-style pulsating gradient ring around the Macromix brand logo in the header (`#brand-wrapper.has-wrapped-story`). Tapping the logo opens the full-screen reel.
* **Manual Review / Testing:** Appending `?wrapped=1` or `?wrapped=true` to any Macromix URL allows launching and previewing the reel anytime on any device.

---

## 2. User Eligibility & Dynamic Rollout

1. **VIP Accounts:** `@istashmacros`, `@kalay`, and `@katara` always have immediate access and curated showcases.
2. **All New Registrations & Active Users Going Forward:** Any user logged into Macromix (`currentUserHandle` in `localStorage`) is automatically eligible every Friday through Sunday.
3. **Dynamic Generator Engine (`generateDynamicWrappedProfile`):**
   * Computes the user's weekly metrics from their actual meal logs over the past 7 days (`currentLogs` or Firestore meals).
   * Aggregates total calories, meals count, total protein, chicken breast/egg protein equivalents, top 4 most frequent dishes with pastel badges, and peak compliance day.
   * Compares average intake against user targets (`userTargets`) to calculate calorie deficit/surplus runway and recommends culturally sensible macro/fiber swaps.
   * Categorizes the user into a gamified Persona Archetype (e.g. *The Protein Architect*, *The Fiber Alchemist*, *The Metabolic Engine*, or *The Momentum Pioneer*).
   * Generates custom share text for 1-tap clipboard copying.

---

## 3. Strict Design & Content Rules

Developers and coding agents working on Macromix must strictly enforce these constraints:

| Rule | Requirement |
|---|---|
| **Zero AI / Gemini Branding** | Never display "powered by google gemini..." or AI mentions anywhere in the wrapped slides or story deck. |
| **No "Tap To..." Commentary** | Do NOT display "TAP ANYWHERE TO CONTINUE &rarr;" or "TAP TO..." hint lines at the bottom of slides. The story auto-advances or taps natively via overlay tap zones. |
| **Slide 2 (MVP Dishes)** | Clean view: only shows title block and the Top Logged Fuel Items box. Entire audio transcript / voice quote box is removed (nothing below top items). **NO** `"Peak Fuel Window"` or `"peak"` badge. |
| **Slide 6 (Archetype)** | **NO** `"MACROMIX SOCIETY TIER"` card. Focus purely on the gamified Persona Archetype and descriptive tags. |
| **Slide 7 (Grand Finale Card)** | The summary card must be centered in the vertical and horizontal middle of the slide (`justify-content: center; gap: 20px;`). **NO** buttons, CTAs, or share boxes at the bottom of the final slide. |
| **Neo-Brutalist Aesthetic** | Maintain high-contrast brutalist borders (`2px solid #111`), vibrant accents (`#FFE600`, `#00F0FF`, `#FF3366`, `#00F59B`), and JetBrains Mono / Space Grotesk typography. |

---

## 4. Editioning, 24-Hour Retention & Bugfix History

### The Root Cause of the Missing Ring Bug (Resolved in v17.4)
* **The Symptom:** Users who watched a wrapped reel previously didn't see the glowing story ring on subsequent weekends despite closing and re-opening the PWA.
* **The Root Cause:**
  1. The app stores `weekendReviewViewed: true` and `weekendReviewViewedAt` timestamps.
  2. The app enforces a **24-hour viewing window retention**: after first watching, the glowing ring remains active for 24 hours so users can rewatch, and then gracefully disappears until the next weekly edition.
  3. The edition identifier `WRAPPED_CURRENT_EDITION` had previously remained hardcoded to an earlier week (`2026_w45_nov`). As a result, subsequent weeks evaluated as an expired watch (>24 hours ago), hiding the ring.
  4. The PWA Service Worker (`sw.js`) served cached application scripts from `v17.3` without recognizing the weekly edition transition.

### The Permanent Architectural Fix
1. **Dynamic ISO Calendar Edition Calculation:**
   ```javascript
   function getWrappedCurrentEdition() {
     const now = new Date();
     const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
     const dayNum = d.getUTCDay() || 7;
     d.setUTCDate(d.getUTCDate() + 4 - dayNum);
     const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
     const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
     const monthStr = now.toLocaleString('en-US', { month: 'short' }).toLowerCase();
     return `${d.getUTCFullYear()}_w${weekNo}_${monthStr}`;
   }
   const WRAPPED_CURRENT_EDITION = getWrappedCurrentEdition();
   ```
2. **Automatic Edition Rollover:**
   In `syncWeekendReviewViewedState()`, if Firestore or local storage has `weekendReviewEdition` from a previous week, the user's viewed status is automatically treated as `false` for the new week.
3. **Storage Hygiene:**
   `initWeekendWrappedEvents()` purges stale edition keys (`macromix_wrapped_viewed_*`) from older weeks on boot.
4. **Service Worker Versioning:**
   Every deployment that modifies application shell logic must increment `CACHE_NAME` in `sw.js` (e.g. `macromix-pwa-v17.4`) and asset query strings in `index.html`.

---

## 5. Slide Breakdown Reference

```
+-------------------------------------------------------+
| [===] [===] [===] [===] [===] [===] [===]   (X Close) |
| ⚡ @handle              WEEKEND WRAPPED               |
+-------------------------------------------------------+
| Slide 1: Week in Fuel (Total Calories, Meals, Protein) |
| Slide 2: MVP Food & Top Dishes (Top items, nothing below) |
| Slide 3: Peak Consistency Win (Best Day Macro Radar)  |
| Slide 4: The Macro Bridge (Smart Contextual Swaps)    |
| Slide 5: Energy Runway (Deficit/Surplus & Prep)       |
| Slide 6: Archetype Persona (Gamified identity & tags) |
| Slide 7: Grand Finale Summary Card (Vertically Centered) |
+-------------------------------------------------------+
```

* **Slide Duration:** 6,500ms per slide with smooth linear progress bars.
* **Interactions:** Tap left to go back, tap right to advance, hold down to pause, toggle sound FX with 🔊/🔇.

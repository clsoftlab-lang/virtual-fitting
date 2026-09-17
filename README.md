<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국) -->

# 👗 Virtual Fitting Room · 가상 피팅 룸

A browser-only **virtual clothing fitting** SPA that reduces online-shopping size/fit errors.
Enter your body metrics, pick a matching avatar, browse a garment catalog, and get an
**explainable, rule-based size recommendation** with per-region fit badges (**Tight / Just-right / Loose**)
and a scaled SVG avatar preview — no ML, no 3D scan, no build step.

**🔗 LIVE DEMO: https://clsoftlab-lang.github.io/virtual-fitting/**

> Read this in Korean: **[README.ko.md](README.ko.md)**

---

## Why

The single biggest driver of online-clothing returns is size/fit mismatch. This project shows a
**transparent geometry engine** that maps *your* measurements against *each garment's* size chart and
tells you, per body region, whether it will be tight, just right, or loose — with the math fully visible.

## Features

- **Body profile** — height / weight / gender / body type → estimated body circumferences (chest, waist, hip, shoulder, thigh) + BMI. Presets included.
- **Scaled SVG avatar** — a silhouette whose proportions scale with your estimated measurements.
- **Garment catalog** — 34 fictional items across 상의/하의/아우터/원피스, each with a real-ish cm size chart. Filter by category, gender, size availability, text search, or "good fit only".
- **Fit engine** — per-size, per-region **ease** (garment − body) classified against recommended ease bands → **recommended size** + fit badge + 0–100 fit score.
- **Garment try-on preview** — the avatar is overlaid with the garment shape, colored green/red/blue by fit, its length driven by the actual chart length.
- **Compare** up to 4 garments side by side (recommended size, badge, score, per-region).
- **Wishlist / cart mock**, persisted to `localStorage` (with reset).
- **Size-chart vs. my-measurements mapping** table with signed ease per cell.
- **Light + dark** theme, **mobile-first responsive**, Korean UI.

## How the fit engine works (the math)

All logic lives in [`fit-engine.js`](fit-engine.js) and is unit-tested in [`check.mjs`](check.mjs).

**1. Estimate body circumferences** from profile. For each region:

```
region_cm = A[gender] · height_cm + B · (weight − idealWeight) + typeAdj[bodyType]
idealWeight = 22 · (height_m)²          // BMI-22 reference weight
```

- `A[gender]` — height-proportion coefficients (men/women; unisex = average).
- `B` — per-kg circumference gain for the deviation from ideal weight.
- `typeAdj` — body-type offsets (slim / standard / athletic / curvy / plus).

Example — man, 175 cm, 70 kg, standard: idealWeight = 22·1.75² = 67.4 kg, ΔW = +2.6 kg →
chest = 0.514·175 + 0.60·2.6 + 0 = **91.5 cm**.

**2. Compute ease per size, per region:**

```
ease = garment_measurement − body_measurement      // cm
```

**3. Classify against recommended ease bands** (`[min, max]` per category+region, e.g. a shirt chest wants **+6…+16 cm**):

```
ease < min → Tight (타이트)   |   min ≤ ease ≤ max → Just-right (적당)   |   ease > max → Loose (넉넉)
```

**4. Recommend the size** minimizing a weighted penalty (distance outside the band, weighted per region — chest/waist dominate). Ties break toward more "just-right" regions, then the smaller size. The overall badge follows the category's primary region (chest for tops/dress, waist for bottoms); the fit score is `max(0, 100 − 4·penalty)`.

## Run locally

No dependencies, no build. Serve the folder over HTTP (ES modules + `fetch` need `http://`, not `file://`):

```bash
python -m http.server 8974
# open http://localhost:8974
```

Run the checks and fit-engine unit tests:

```bash
node check.mjs        # JSON parse + node --check all JS + index.html elements + engine tests
```

## Project structure

```
index.html            # SPA shell (required elements, module entry)
styles.css            # mobile-first, light/dark tokens
app.js                # UI: state, avatar SVG, catalog, filters, detail, compare, wishlist
fit-engine.js         # the sizing math (importable in Node + browser)
data/garments.json    # 34 fictional garments with cm size charts
data/body-models.json # genders, body types, avatar presets
ai/config.js          # AI_ENDPOINT ("" = built-in mock; else backend proxy URL)
ai/ai.js              # askAI(task, payload) — mock (fit-engine grounded) or streamed proxy
server/index.mjs      # backend proxy → Anthropic Claude (key server-side only)
server/               # package.json, .env.example, README.md
check.mjs             # CI checks + fit-engine unit tests + AI-layer checks
.github/workflows/ci.yml
```

## DEMO-MODE boundaries

> **This is a demo. Read these limits:**
>
> - **Sizing is rule-based geometry, not a 3D/ML body scan.** Body circumferences are *estimated* from height/weight/gender/body-type with documented linear coefficients — they are approximations, not measurements.
> - **The avatar is a scaled inline SVG silhouette**, not a photorealistic or physically-simulated garment drape.
> - **All garments, brands, prices and size charts are fictional seed data** (`data/*.json`).
> - **No real accounts, no payments, no PII.** Profile / wishlist / compare are stored only in your browser's `localStorage` and can be reset anytime.
> - **A production build could add** photogrammetry / ML body estimation from photos, real garment-drape simulation, a live product catalog & inventory API, and per-brand return-rate learning.

## Tech

Vanilla HTML + CSS + ES-module JavaScript. No framework, no bundler, relative paths only — deployable as-is to GitHub Pages. Node is used only to run `check.mjs`.

## 🤖 AI 기능 (API 연동)

The app ships a **pluggable AI layer** with three features:

1. **AI 스타일·핏 상담 챗봇** — from your body metrics + preferences, it recommends garments and sizes using the fit engine (grounded on real per-region ease and fit scores).
2. **핏 결과 자연어 설명** — narrates the recommended size and per-region ease for any garment ("chest +14.5cm just-right, waist tight → size up").
3. **상황별 코디 추천** — situation-based outfit suggestions (office / date / active / weekend / formal), pairing top+bottom (or dress)+outer.

**The demo works out of the box using a built-in, deterministic Korean mock** (`ai/ai.js`) that reuses the app's garment data and `fit-engine.js` — no key, no network, no build.

To enable **real Claude**:

1. Deploy `server/` (a thin proxy) with your `ANTHROPIC_API_KEY` (model `claude-opus-5`):
   ```bash
   cd server && cp .env.example .env   # put your key in .env
   npm install && npm start            # http://localhost:8787
   ```
2. Point the front end at it — set `AI_ENDPOINT` in `ai/config.js`:
   ```js
   export const AI_ENDPOINT = "http://localhost:8787/api/ai"; // or your deployed URL
   ```

The browser only ever sends `{task, payload}` to the proxy; the proxy holds the key and streams Claude's text back.

> **API keys are server-side only — never in the browser or the repo.** `ai/config.js` holds no key, `server/.env` is git-ignored, and `check.mjs` scans the repo for a committed key on every run.

## Return-rate rationale

Size/fit is the top return reason in fashion e-commerce. By surfacing *per-region* ease before purchase (e.g. "waist tight, chest fine → size up"), shoppers self-select the right size, which is exactly the lever that lowers fit-driven returns. This demo makes that decision transparent and explainable rather than a black box.

## Contributors

- **Dr. Lee Il-guk (이일국)** — concept, direction
- **LWJ**, **LMJ** — collaborators
- **Claude** (Anthropic) — implementation assistant

## License

- Code: **Apache-2.0** — see [LICENSE](LICENSE).
- Documentation: **CC BY 4.0**.
- SPDX headers: `Apache-2.0`, `Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국)`.

---

*Not an official Anthropic product.*

## 🎓 Idea origin

The seed idea for this project came from the **entrepreneurship class taught by Dr. Lee Il-guk (이일국) at Yongin University (용인대학교)**. The students in that class produced startup ideas of remarkable, standout creativity — this project is one of those exceptional ideas, finally brought to life as a working service. Built with deep admiration and gratitude for those students' imagination. *(No student personal information is included; only the idea itself was used, implemented clean-room.)*

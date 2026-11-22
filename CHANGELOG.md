# Changelog

All notable changes to **GuanXue (观穴) 3D Oriental Acupoint Atlas** are documented in this file.

## [Unreleased]

### Observation-Side Unified State Source
- Added `src/scene/stage-state.js`: a single `StageState` source of truth for the observation side (human left/right), display switches, and pause state, with `matchesSide` / `markerVisible` / `segmentVisible` / `qiParticleVisible` filtering predicates.
- Markers, meridian tubes, Qi particles, indication (主治) flow arcs, and leader labels now render only the current side; midline single points (GV/CV, `bilateral === false`) remain visible on both sides. Opposite-side markers, tubes, particles, and arcs can no longer leak into the view.
- Side switching no longer rebuilds Qi sprites (particles are built once per selected meridian for both sides and only their visibility toggles), and no longer re-creates geometry/materials. Repeated rapid switches neither stack nor leak.
- `StageState.setSide()` is the only side mutation entry point and only notifies subscribers on a real side change; the effect layer rebuilds per side through this subscription while pause/enabled state persists across rebuilds.

### Resource Lifecycle
- Fixed leaks in `src/scene/effects.js` `clear()`: sprite materials are now disposed (previously skipped via a `material.map === glowTex` guard), the shared Three.js `Sprite` geometry and the shared glow texture are no longer disposed per rebuild (only on full `dispose()`), and a `dispose()` API plus read-only `side`/`paused`/`enabled`/`snapshot` accessors were added.
- Fixed an operator-precedence bug in outer-ring opacity (`(paused || reduced) ? .4 : ...`).

### Body Materials
- Extracted the four body material presets into `src/scene/body-materials.js`; `applyBodyMaterial()` mutates existing materials and shader uniforms in place without allocating geometry/materials/textures, so shader recompilation never resets the observation side, flow pause/show switches, or label layout.

### Tests
- Added `tests/stage-state.test.mjs`, `tests/body-materials.test.mjs`, and `tests/effects-lifecycle.test.mjs` (26 node:test cases total with the existing suite).
- Added headless-browser real-WebGL smoke pages under `tests/browser/` and a zero-dependency runner `scripts/browser-smoke.mjs` (`npm run test:browser`).
- Added a read-only `window.__guanxueStage` debug/automation hook exposing per-layer visibility snapshots.

## [2.0.0] - 2026-11-13

### Architecture & Engineering Standards
- Restructured the repository from a flat `/docs` bundle into a standard modular codebase (`src/data`, `src/scene`, `src/styles`, `src/vendor`, `scripts`, `tests`, `assets`, `licenses`).
- Moved `index.html` and `.nojekyll` to repository root so GitHub Pages deploys cleanly from `/ (root)`.
- Added root `MIT LICENSE`, `package.json` (`type: "module"`), `.editorconfig`, `.gitignore`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/`, and GitHub Actions CI (`npm run check` & `npm test`).
- Added zero-dependency Node static dev server (`scripts/dev-server.mjs`), link/import integrity checker (`scripts/check-integrity.mjs`), and `node:test` test suite (`tests/atlas.test.mjs`).

### 3D Rendering & UI/UX Upgrade
- Upgraded WebGL rendering with equirectangular studio reflection dome and custom GLSL sculptural shaders (`jade`, `bronze`, `xray`, `ivory`).
- Added dynamic 12-branch **Ziwu Liuzhu (子午流注)** celestial compass pedestal synced with current system time and active meridian shortcut (`#shichenBtn`).
- Added surface-normal glowing golden light needle (`needleGroup`) and breathing dual reticle for the active acupoint.
- Upgraded meridian conduits to surface-hugging `CatmullRomCurve3` tubes and fixed world-space scaling artifacts.
- Upgraded 149 traditional symptom associations in `src/scene/effects.js` with animated gold-to-cyan GLSL Qi wave shaders, target halos, and non-overlapping SVG elbow leader callouts (`#leaderLines`).
- Redesigned UI around deep obsidian ink / celadon jade / imperial gold editorial theme with 4x4 meridian filter matrix, special-point seal badges, meridian progression bar, and keyboard navigation (`/`, `←`, `→`, `Escape`).

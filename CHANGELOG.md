# Changelog

All notable changes to through-the-cracks are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Releases are cut automatically from Conventional Commits, and each GitHub Release carries its generated notes. What each version bump means: [CONTRIBUTING.md](CONTRIBUTING.md#versioning-and-releases).

## [Unreleased]

### Added

- Cloudflare Worker and Cloudflare D1 production archive API (`server/worker.js`, `server/d1Schema.js`, `server/d1Queries.js`, `server/schema.sql`, `wrangler.jsonc`) deployed to `https://idleamericana.com/through-the-cracks/` with scheduled Blogger API v3 Cron refreshes (`0 6 * * SUN,THU` UTC) and Bearer-authenticated `POST /through-the-cracks/api/ingest`.
- `scripts/seed-d1.js` to export static archive snapshots into chunked D1 SQL statements for remote seeding.
- `idleAustin` Thread Level Midnight cockpit UI (`DESIGN.md`, `--as-*` tokens, Overview telemetry and interactive `AnnualSpinChart`, two-pane Broadcast Log, paginated Artists and Songs catalogs with Artist Inspector, `/search` and `⌘K` Command Palette).
- Vitest unit test suites (`src/*.test.js`) and Playwright browser end-to-end suite (`tests/browser/*.spec.js`).
- Seven-doc `/setup-docs` governance suite, `.agents/agents/` subagent definitions, and `docs/agents.md` roster.

### Changed

- Extracted pure Blogger HTML playlist parsing (`scripts/blogger-parser.js`) and static JSON snapshot generation (`scripts/static-snapshots.js`) from `scripts/ingest.js`.
- Deployed production directly via Wrangler Worker deployment in `.github/workflows/deploy.yml` after retiring GitHub Pages and blocked Cloud Run billing paths.
- Updated Header and client API resolution (`src/api.js`) for subpath hosting under `/through-the-cracks/` and static JSON fallback parity.

### Fixed

- Incremental Blogger refresh date clamping, post-Aug-2025 bare episode number parsing, and `(episode_id, position)` duplicate prevention.

### Security

- Applied `express` transitive advisory fixes (`npm audit fix`), SQL `LIKE ... ESCAPE '\'` wildcard escaping, generic Worker `500`/`503` responses, `workers_dev: false`, and explicit least-privilege `permissions` in `.github/workflows/deploy.yml`.

[Unreleased]: https://github.com/idleAustin/through-the-cracks/compare/main...HEAD

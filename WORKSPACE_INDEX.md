# Workspace index

Where things live in through-the-cracks. The table is regenerated from tracked folders; the descriptions are hand-written and kept. Placement rules for new files: [CONTRIBUTING.md](CONTRIBUTING.md#where-files-go).

## Map

<!-- setup-docs:map -->
| Path | What lives here |
| --- | --- |
| `.agents/` | Specialized AI coding subagent definitions (`.agents/agents/*.md`). |
| `.claude/` | Local Claude Code harness settings. |
| `.github/` | GitHub Actions CI, Snyk security scan, and Cloudflare Worker deploy workflows. |
| `.project-documentation/` | Historical initial project specification notes. |
| `docs/` | Engineering reference docs, including the subagent roster and file ownership (`docs/agents.md`). |
| `public/` | Static web assets and prebuilt JSON archive snapshots (`public/data/`). |
| `scripts/` | Blogger API v3 ingestion, HTML playlist parser, static snapshot builder, D1 SQL seeder, and setup scripts. |
| `server/` | Cloudflare Worker + D1 runtime (`worker.js`, `d1Schema.js`, `d1Queries.js`, `schema.sql`) and local Express/BigQuery server (`index.js`, `bigquery.js`, `routes/`). |
| `src/` | React + Vite cockpit UI (`views/`, `components/`, `styles/`), API/static clients, and Vitest unit tests (`*.test.js`). |
| `tests/` | Playwright end-to-end browser test suite (`tests/browser/`). |
<!-- /setup-docs:map sha256=349eb1a20271 -->

## Entry points

- `src/main.jsx` — React app bootstrap, router, and theme initialization.
- `src/App.jsx` — Top-level Thread Level Midnight shell, routes, and archive data provider.
- `src/api.js` — Client archive API and static JSON snapshot adapter.
- `server/worker.js` — Production Cloudflare Worker API, SPA static asset router, and Cron ingestion handler.
- `server/index.js` — Local Express API server (BigQuery backend).
- `scripts/ingest.js` — CLI Blogger API v3 ingestion and static JSON snapshot pipeline.

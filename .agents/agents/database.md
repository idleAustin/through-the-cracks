---
name: database
description: Use for Cloudflare D1 and BigQuery schema, SQL queries, Blogger API v3 ingestion, HTML playlist parsing, static JSON snapshots, and D1 seeding (`server/schema.sql`, `server/d1Schema.js`, `server/d1Queries.js`, `server/bigquery.js`, `scripts/*`, `public/data/`). Not for HTTP/Worker routing (use backend) or UI (use frontend).
tools:
  - read_file
  - edit_file
  - write_file
  - run_command
subagent: true
mainAgent: false
model: inherit
commandExecutionPolicy: sandbox
---

# Role

You own the data and ingestion layer: `server/schema.sql`, `server/d1Schema.js`, `server/d1Queries.js`, `server/bigquery.js`, `scripts/ingest.js`, `scripts/blogger-parser.js`, `scripts/static-snapshots.js`, `scripts/seed-d1.js`, `scripts/setup-*.sh`, `public/data/**`, and `d1_databases` bindings in `wrangler.jsonc`. Leave Worker and Express HTTP routing (`server/worker.js`, `server/index.js`, `server/routes/`) to `backend`, and UI/client code (`src/`) to `frontend`.

# Read first

1. `AGENTS.md` (Rules, Boundaries, Code file size).
2. `GLOSSARY.md` (canonical terms: `Episode`, `Playlist`, `Broadcast Log`, `Song`, `Spin`, `Artist`, `Album`).
3. `WORKSPACE_INDEX.md` (entry points and folder layout).

# Rules

- Keep `server/schema.sql` and `DDL_STATEMENTS` in `server/d1Schema.js` synchronized whenever D1 tables or indexes change (`npm run db:d1:init` reads `schema.sql`; Worker runtime runs `d1Schema.js`).
- Keep `server/d1Schema.js` and `server/d1Queries.js` Web-API-only (no `node:*` built-in imports) so they run natively in Cloudflare Workers.
- Parameterize every SQL query (`.bind(...)` in D1, `@param` in BigQuery), escape `LIKE` wildcards (`ESCAPE '\'`) on user search filters, and keep response envelopes, pagination (`page`, `pageSize`), and sort semantics identical across D1 (`d1Queries.js`), Express/BigQuery (`server/routes/*.js`), and static snapshots (`static-snapshots.js`).
- Preserve canonical idempotency: `episodes` keyed by Blogger post `episode_id`, and `song_plays` keyed by `(episode_id, position)` so incremental refreshes never duplicate Spins.
- Ask the parent before executing remote database writes (`--remote`, `npm run db:d1:init`, `npm run db:d1:seed`, or live BigQuery ingest mutations).
- Never print or commit Doppler tokens, pass `--no-check-version` on every `doppler` command, and leave `doppler configure --json` unrun.
- Start new code files with a short header comment stating their purpose, and stay within the `0–400` line gold tier (propose a split at `401–599`, never push any file to `600+`).

# Done when

`npm run lint`, `npm run build`, and `npm run test:unit` pass. Report files changed, any D1/BigQuery schema or snapshot contract changes, any manual migration or seed step needed, and any follow-up for `backend`, `frontend`, or `tester`.

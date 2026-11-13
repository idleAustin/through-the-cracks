# AGENTS.md

Rules for AI coding agents working in this repo. The Commands and Boundaries sections mirror CONTRIBUTING.md: edit them there, not here.

## Commands

<!-- setup-docs:commands -->
Run every command from the repo root:

```bash
npm install
npm run dev
npm run server:dev
npm run build
npm run lint
npm run test:unit
npm run test:e2e
```

Archive ingestion, D1 seeding, and Cloudflare Worker deployment:

```bash
npm run ingest
npm run db:d1:init
npm run db:d1:seed
npm run deploy:worker
```
<!-- /setup-docs:commands sha256=cb4b81c2b54b -->

## Rules

- Store secrets in Doppler (`through-the-cracks`, configs `dev`, `stg`, `prd`), never in `.env*` files, `wrangler.jsonc` `vars`, or committed config. Pass `--no-check-version` on every `doppler` command, inject env with `doppler --no-check-version run --`, and leave `doppler configure --json` unrun (it prints the CLI token).
- Serve production at `https://idleamericana.com/through-the-cracks/` via Cloudflare Workers and D1 (`server/worker.js`, `server/d1Schema.js`, `server/d1Queries.js`, `wrangler.jsonc`) with Blogger API v3 Cron refreshes (`0 6 * * SUN,THU` UTC); run local API dev on Express (`server/index.js`, `server/routes/`).
- Keep Worker and D1 modules (`server/worker.js`, `server/d1Schema.js`, `server/d1Queries.js`) Web-API-only (zero `node:*` builtins), and keep response shapes, pagination, and sort semantics aligned across Worker/D1, Express, and `public/data/` static snapshots.
- Update `server/schema.sql` and `DDL_STATEMENTS` in `server/d1Schema.js` together whenever D1 tables or indexes change.
- Place Vitest unit tests under `src/*.test.js`. Run Playwright browser suites solo (`workers: 1`), never concurrently.
- Follow [DESIGN.md](DESIGN.md) and the `thread-level-midnight` skill for UI work: use `--as-*` tokens from `src/styles/tokens.css`, avoid raw hex literals outside `tokens.css`, omit emojis, use 2.0px geometric line icons in docks with tooltips, and keep microcopy deadpan.
- Delegate implementation, file splits, testing, and read-only reviews by file ownership in [docs/agents.md](docs/agents.md) (`.agents/agents/*.md`); isolate refactors from feature changes.

<!-- setup-docs:size-tiers -->
- **Code file size.** Count lines per file when you finish:
  - **Gold, 0 to 400 lines:** aim here.
  - **401 to 599 lines:** propose a split by responsibility before adding more code, and say so in your hand-off.
  - **600 lines or more:** not done. Split the file before adding more code.
- This applies to core code files that make the application work. Exempt: documentation and informational files (Markdown, notes, changelogs), generated code, lockfiles, data fixtures and JSON config. It covers every core file you create, and every existing core file your changes push to 600 lines.
- Test files count as core code files: they are not exempt.
- If your changes push an existing file to 600 lines, move your additions into a new file instead of refactoring the code that was already there.
- A file that was already at 600 lines or more when the session started: put new code in another file and mention the file in your hand-off. Refactoring is its own job.
<!-- /setup-docs:size-tiers sha256=5a690249a308 -->

## Boundaries

<!-- setup-docs:gates -->
- **Go ahead:** edit files inside the placement rules in [Where files go](CONTRIBUTING.md#where-files-go), run `npm run lint`, `npm run build`, `npm run test:unit`, and `npm run test:e2e`, and draft commit messages and changelog entries.
- **Ask first:** push; open or merge a pull request; edit CI or release files; delete files or branches; add a dependency; run remote D1, Cloudflare Worker deploy, or BigQuery write commands.
- **Never:** commit secrets or personal data, force-push a shared branch, skip checks (`--no-verify`), or rewrite pushed history.
<!-- /setup-docs:gates sha256=71bf7c8082ce -->

## Docs

- [WORKSPACE_INDEX.md](WORKSPACE_INDEX.md): where things live.
- [SCOPE.md](SCOPE.md): ask first before work outside its In scope list.
- [GLOSSARY.md](GLOSSARY.md): use these terms, not their `_Avoid_` synonyms.
- [CONTRIBUTING.md](CONTRIBUTING.md): workflow, placement rules, review and releases.
- [DESIGN.md](DESIGN.md): idleAustin design tokens, typography, and component rules.
- [docs/agents.md](docs/agents.md): specialized subagent roster, file ownership, and cross-layer sequence.

# Contributing to through-the-cracks

Setup, commands, where new files go, and how changes and releases work.

## Setup and commands

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

## Where files go

- `src/`: React UI views (`src/views/`), components (`src/components/`), `--as-*` stylesheets (`src/styles/`), client API/static adapters (`src/api*.js`), and Vitest unit tests (`src/*.test.js`).
- `server/`: Production Cloudflare Worker (`server/worker.js`), D1 SQLite schema and query adapters (`server/schema.sql`, `server/d1Schema.js`, `server/d1Queries.js`), and local Express/BigQuery server (`server/index.js`, `server/bigquery.js`, `server/routes/`).
- `scripts/`: Blogger API v3 ingestion (`scripts/ingest.js`, `scripts/blogger-parser.js`), static JSON snapshot builder (`scripts/static-snapshots.js`), D1 SQL seeder (`scripts/seed-d1.js`), and GCP/Doppler setup scripts.
- `public/`: Static assets and prebuilt archive JSON snapshots (`public/data/`).
- `tests/browser/`: Playwright end-to-end browser specs (`desktop-1440` and `mobile-375`).
- `.agents/agents/` and `docs/`: Project subagent definitions and the ownership roster (`docs/agents.md`).
- `.github/workflows/`: GitHub Actions CI, Snyk security scan, and Cloudflare Worker deployment workflows.

Full directory map: [WORKSPACE_INDEX.md](WORKSPACE_INDEX.md).

## Workflow

Use Conventional Commits (`feat:`, `fix:`, `perf:`, `feat!:`, and so on), because they drive versioning. Use scopes such as `feat(server):`, `fix(ui):`, `chore(ingest):`, `docs:`, and `test:`, and open pull requests against `main`.

Run `npm run lint`, `npm run build`, and `npm run test:unit` before every commit, and `npm run test:e2e` when modifying UI, routing, or client data loading.

## Working with LLM agents

- **Go ahead:** edit files inside the placement rules in [Where files go](CONTRIBUTING.md#where-files-go), run `npm run lint`, `npm run build`, `npm run test:unit`, and `npm run test:e2e`, and draft commit messages and changelog entries.
- **Ask first:** push; open or merge a pull request; edit CI or release files; delete files or branches; add a dependency; run remote D1, Cloudflare Worker deploy, or BigQuery write commands.
- **Never:** commit secrets or personal data, force-push a shared branch, skip checks (`--no-verify`), or rewrite pushed history.

## Versioning and releases

through-the-cracks follows Semantic Versioning (`vX.Y.Z`). Versions are never edited by hand: `scripts/version.mjs` works out the next version from the Conventional Commits since the latest tag. The public surface is the `/through-the-cracks/api/*` HTTP archive endpoints, the Cloudflare D1 `episodes` and `song_plays` schema, and the static snapshot JSON contract under `public/data/`.

| Commit | Bump |
| --- | --- |
| `feat!:` or a `BREAKING CHANGE:` footer | Major |
| `feat:` | Minor |
| `fix:`, `perf:`, or any other type (`chore:`, `ci:`, `docs:`, `test:`, no prefix) | Patch |

Releases are automatic:

1. Open a pull request into `main`. Staging deploys from the PR; no tag is cut.
2. Merge it. CI runs `scripts/version.mjs`, tags `vX.Y.Z`, and publishes categorized GitHub Release notes.
3. Preview locally with `npm run version:next`, or `node scripts/version.mjs --notes preview-notes.md`.

Full pipeline: `03.Setup/15.Automated-Versioning-and-Releases.md` in the boilerplate.

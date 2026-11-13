# Subagents

Project subagents live in [`.agents/agents/`](../.agents/agents/), one markdown file per agent. The primary agent delegates to them with `invoke_subagent`. This page is the single index for the roster and file ownership.

## Roster

| Agent | Use it for | Mode |
|-------|------------|------|
| `database` | D1 & BigQuery schema, queries, Blogger ingestion, HTML parser, snapshots, seeding | writes |
| `backend` | Cloudflare Worker routing, `/api/ingest` auth, Cron triggers, local Express routes | writes |
| `frontend` | React views, components, `⌘K` palette, URL routing, client API/static adapters, CSS | writes |
| `tester` | Vitest unit tests (`src/*.test.js`) and Playwright browser tests (`tests/browser/`) | writes tests only |
| `mobile` | Future Capacitor iOS/Android wrapper (`src/platform/`; out of scope unless approved) | writes |
| `refactoring` | Splitting oversized or mixed-responsibility files without behavior changes | writes, two phases |
| `domain-integrity` | Read-only gate for parser rules, `(episode_id, position)` keys, and cross-runtime parity | report only |
| `security-reviewer` | Read-only gate for `/api/ingest` auth, SQL parameterization/`LIKE`, Worker headers, Doppler | report only |
| `styleguide` | Read-only UI and CSS audit against `DESIGN.md` and `thread-level-midnight` | report only |
| `mobile-web` | Read-only phone-browser audit (`320–430px` layout, touch, safe areas, overlays) | report only |

All agents use `model: inherit`, `mainAgent: false`, and the sandbox `commandExecutionPolicy`. They run only as delegates of the primary agent.

## File ownership

Write-capable agents edit only the paths they own. Cross-boundary work returns to the parent agent for sequencing.

| Agent | Owns |
|-------|------|
| `database` | `server/schema.sql`, `server/d1Schema.js`, `server/d1Queries.js`, `server/bigquery.js`, `scripts/ingest.js`, `scripts/blogger-parser.js`, `scripts/static-snapshots.js`, `scripts/seed-d1.js`, `scripts/setup-*.sh`, `public/data/**`, `d1_databases` in `wrangler.jsonc` |
| `backend` | `server/worker.js`, `server/index.js`, `server/routes/**`, Worker route/asset/cron config in `wrangler.jsonc` |
| `frontend` | `index.html`, `vite.config.js`, `src/main.jsx`, `src/App.jsx`, `src/theme.js`, `src/api.js`, `src/api-catalog.js`, `src/api-static.js`, `src/components/**`, `src/views/**`, `src/utils/**`, `src/assets/**`, `src/index.css`, `src/styles/*.css` |
| `tester` | `src/**/*.test.js`, `src/**/*.test.jsx`, `tests/browser/**`, `vitest.config.js`, `playwright.config.ts` |
| `mobile` | `capacitor.config.ts`, `src/platform/**`, `ios/`, `android/` |
| `refactoring` | Only the files the parent names, plus their importers |
| `domain-integrity`, `security-reviewer`, `styleguide`, `mobile-web` | None. They report only. |

## Cross-layer sequence

When a change spans multiple layers, run agents in this order and verify each report before the next:

1. `database` for schema DDL, D1/BigQuery queries, ingestion parsers, and static snapshot contracts.
2. `backend` for Cloudflare Worker and Express HTTP endpoints.
3. `frontend` for React views, client API/static adapters, and `--as-*` styles.
4. `tester` for Vitest unit tests and Playwright browser specs.
5. `domain-integrity` and `security-reviewer` as parallel gates when schema, parser, auth, headers, or SQL queries change.
6. `styleguide` and `mobile-web` as parallel gates after UI or CSS changes.
7. Run `/impeccable audit` (or `critique` on new surfaces) from the primary agent when shipping UI changes. Subagents cannot invoke slash commands.

Run refactors on their own, never inside a feature change.

## Adding an agent

1. Create `.agents/agents/<name>.md` where `name:` matches the filename and avoids built-in names (`research`, `browser`, `self`, `image-generator`).
2. Keep `description:` crisp: state when to delegate and which sibling owns adjacent work.
3. List exact tool names (`read_file`, `edit_file`, `write_file`, `run_command`).
4. Start with `# Role` (owned files) and `# Read first` (`AGENTS.md`, `WORKSPACE_INDEX.md`, etc.).
5. Register the agent in both tables above with non-overlapping paths.
6. Leave any human documentation outside `.agents/agents/` (Antigravity parses every `.md` there as an agent).

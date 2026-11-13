# Scope

What through-the-cracks takes on and what it turns away. Its purpose is in [README.md](README.md).

## In scope

- Archive web cockpit UI and `--as-*` design tokens (`src/`, `public/`, `DESIGN.md`)
- Production Cloudflare Worker API, D1 SQLite database, and scheduled Blogger Cron ingestion (`server/`, `wrangler.jsonc`)
- Local Express/BigQuery development API and CLI ingestion / static snapshot scripts (`server/`, `scripts/`)
- Unit and end-to-end browser test suites (`src/*.test.js`, `tests/browser/`)
- Subagent governance and CI/CD workflows (`.agents/`, `docs/`, `.github/`)

## Out of scope

- **Secrets & environment variable storage.** Kept out of git so credentials never leak. Instead: Doppler (`through-the-cracks` across `dev`, `stg`, `prd`).
- **End-user accounts, authentication, or public write APIs.** The archive is a read-only broadcast catalog; only Blogger ingestion writes records. Instead: upstream WEVL *Through the Cracks* Blogger posts.
- **Audio streaming or media hosting.** Broadcast recordings and commercial tracks carry licensing outside this catalog. Instead: live WEVL 89.9 FM broadcasts (`wevl.org`).
- **Cross-project boilerplate & global skills.** Maintained once across projects rather than forked here. Instead: `.boilerplate/` (gitignored) and `~/.gemini`.

## How scope changes

The owner edits this file in place; git history is the log.

Last reviewed: 2026-11-13

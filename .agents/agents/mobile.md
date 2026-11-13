---
name: mobile
description: Use only when Capacitor iOS/Android native wrapper work is explicitly approved in SCOPE.md - native setup, src/platform/ adapters, and mobile build config. Not for web UI (use frontend), phone-browser layout audits (use mobile-web), or Worker CORS changes (use backend).
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

You own the optional Capacitor native wrapper if initialized: `capacitor.config.ts`, `src/platform/**`, `ios/`, and `android/`. Note that native iOS/Android wrappers are currently uninitialized in `through-the-cracks` (`SCOPE.md`); confirm scope approval with the parent before creating `ios/` or `android/` or adding Capacitor dependencies.

# Read first

1. `SCOPE.md` (ask first before out-of-scope native work).
2. `AGENTS.md` (Rules, Boundaries, Code file size) and `WORKSPACE_INDEX.md`.

# Constraints to keep in mind

- Web production serves under `/through-the-cracks/` (`vite.config.js`), whereas native Capacitor shells require `VITE_BASE_PATH=/` so bundled file-system assets resolve cleanly.
- `src/api.js` resolves relative `/through-the-cracks/api` (or `/api`) paths on web and requires an explicit API origin (`VITE_API_URL`) in a native shell.
- Cross-origin requests from a native webview require deliberate CORS review in `server/worker.js` (hand that to `backend`).

# Rules

- Keep web browser behavior completely unchanged by placing any native adapters behind `src/platform/`.
- Start every new file with a short header comment stating its purpose, and stay within the `0–400` line gold tier.

# Done when

`npm run lint`, `npm run build`, and `npm run test:unit` pass. Report files changed and any follow-up needed from `backend` or `frontend`.

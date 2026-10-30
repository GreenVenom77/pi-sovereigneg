# Security policy

> This project is fully vibe-coded (AI-written) and has had limited human review. Treat it accordingly and read the source.

## Reporting a vulnerability
Please **do not** open a public issue. Use GitHub's private
["Report a vulnerability"](../../security/advisories/new) form on this repository.
You can expect an acknowledgement within a few days.

## What this extension touches
- Pi extensions run with your full user permissions. Read the (small) source before installing.
- Your API key is stored by **pi** (`~/.pi/agent/auth.json`) or read from `SOVEREIGNEG_API_KEY`.
  The extension never writes it to disk itself and never logs it.
- Network calls go only to the SovereignEG API (`https://backend.sovereigneg.com/v1`, or the URL in
  `SOVEREIGNEG_BASE_URL`): `/models`, `/credits` and your chat requests. There is no telemetry.
- Files written by the extension: `~/.pi/agent/sovereigneg.json` (settings), `sovereigneg-cache.json`
  (public model catalog) and, only when you run `/sovereign raw`, `sovereigneg-debug.json`
  (API samples; may contain balances. Review before sharing).

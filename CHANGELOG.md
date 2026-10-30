# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

## [0.1.0] - 2026-10-29

First public release.

### Added
- `/login` → **SovereignEG**: opens the dashboard key page, validates the pasted key against the API.
  `SOVEREIGNEG_API_KEY` is also supported.
- Live model catalog from `GET /v1/models`, cached for offline start-up.
- `sovereigneg/smart` virtual model: per-request routing by task complexity, with the thinking level as a
  spend ceiling, prefer-free-allowance, cache-friendly stickiness and fallback on 402/429/503.
- `/sm` (`/sovereign models`): collapsible, searchable model tree grouped by Category / Author / Host / Price,
  with favorites.
- Curated `/model` list (`/sovereign list curated|all`).
- `/sovereign` status, pick, why, refresh, budget, raw.
- Hidden-thinking cost guard for Claude 5.x, friendly error explanations, session budget prompt, footer status.
- `SOVEREIGNEG_BASE_URL` to target a different (e.g. Egypt-hosted) endpoint.
- Live footer: `[FREE]`/`[PAID]`, session spend, free allowance left and balance, updated while replies stream and
  polled from `/v1/credits` during long runs.
- Requests-per-minute tracking against the plan limit, with a warning at 80%.
- Health/deprecation awareness and a quality floor (no ≤3B or <32K-context models in auto-routing).
- Richer `/sovereign` status (plan, promo/paid balance, expiring credits, allowance tokens, monthly usage);
  `/sovereign raw` redacts per-request ids.
- Field names verified against real API responses; test fixtures captured from a Student-plan account.

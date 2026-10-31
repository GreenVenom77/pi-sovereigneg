# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

## [0.2.0] - 2026-10-31

### Added
- **Model list and prices straight from the API.** Models and prices come only from `GET /v1/models`, re-read when pi
  starts and each time `/sm` opens. **Price provenance** is shown: `/sovereign status` says whether the list is from
  the API or the cache, and the `/sm` legend warns when prices are not fresh (`offline: prices from cache, 3 d ago,
  may have changed`).
- **`paid` and `free used` survive `/reload`, `/resume` and restarts.** The totals (and the subagent totals) are saved
  into the pi session as a custom entry (never sent to the model); on session start the largest saved value in the
  session is restored. New sessions start at zero, forks continue from the parent. Writes are throttled to one per
  5 s and flushed when a turn settles and on shutdown.
- **Compact footer.** `footer: "auto"` (default) shows the full line when it fits the terminal and a compact one when
  it doesn't (`SEG haiku-5.5 FREE · free 0.99M (96%) · bal 20.00 EGP · paid 0.00`). Segments are ordered by importance and
  the least important ones are dropped first on very narrow terminals. It repaints when the terminal is resized.
  `/sovereign footer auto|full|compact` switches it.
- **Opt-in `rpm` counter** (`showRpm`, off by default): `rpm 14/20` in the footer, shown only from `rpmShowAtPercent`
  (default 60) of your plan's limit and flagged with `!` from 90%. Counts this session and its subagents (including
  subagent processes); other sessions on the same key are not visible. `/sovereign rpm on|off|<percent>`.
- `/sovereign status` shows your plan's request limit (`Rate limit: 20 requests/min (plan base 1000)`), plus the rpm
  count next to it when the counter is on, and where the model list came from (`Models: N (M routable) · from the API,
  5 min ago` / `cached 3 d ago (offline?)`).
- **pi-subagents support.** The extension inside each subagent process reports the SovereignEG model and the exact
  cost of every reply to the main session (shared file `sovereigneg-subagents.jsonl`, tagged with an id inherited
  through the environment). The footer shows `subagent <model> [FREE|PAID]`, the spend is added to `paid` /
  `free used` and the session budget, and credits are refreshed while subagents run, even after the main agent's turn
  has ended. `/sovereign` shows a `Subagents:` line.
- Fallback for anything the above doesn't cover (another session or a setup that doesn't pass the environment on):
  spend is detected from drops in the server's allowance/balance between refreshes, without double counting.
- `idleRefreshSeconds` (default 15): credits are also refreshed while pi is idle.
- Credentials are also looked up in pi's `auth.json` when pi doesn't hand them out at start-up.

### Changed
- **`/sm` tabs are now Favorites · Price · Author · Host** (was Category · Author · Host · Price). The Favorites tab
  lists only your starred models; it replaces the Category tab, so the Recommended / Coding & agents / Chat only groups
  are gone (the `best value`, `no tools`… badges stay on every row). On the Price tab a model that is free right now (in
  today's allowance, with allowance left; same rule as the footer's `[FREE]`) is listed under **Free today** whatever its
  list price, and returns to its price group when the allowance runs out. `/sm` opens on Favorites when you have any,
  otherwise on Price, and searching on the Favorites tab also lists the other matches under *Other models*.
- **`FREE (low)` in `/sm`.** A model that is free right now but whose allowance is below `minAllowanceLeftEgp` (default
  2 EGP: smart routing no longer picks it on its own) is tagged `FREE (low)` instead of `FREE`; it stays in the Free
  today group because you can still choose it yourself. The README now explains the buffer: the router prefers free
  allowance models first (low and medium tiers by default), stops at the buffer, and `minAllowanceLeftEgp` changes it
  (`0` = use the allowance until it is gone).
- **`/sm` shows cache prices and labels every number**: `131K ctx · in 8.41 · out 67.29 · cache r 1.29 w –`. A legend
  under the search box states the unit (EGP per 1M tokens), and the highlighted model gets a detail line with input,
  output, cache read, cache write and 1-hour cache write. `–` means the API doesn't list that price. The non-TUI
  fallback list and the `/sovereign pick` options use the same labelled prices (they used to show an unlabelled
  `8.41/67.29`).
- **SovereignEG-branded models are grouped under SovereignEG** in the `/sm` Author view (e.g. `SovereignEG/Qwen3.8-27B-FP8`
  was under Alibaba (Qwen)). Detected by the id prefix `SovereignEG/` or `owned_by: SovereignEG`; other models still use
  their real author.
- **Models and prices come only from the provider's API**; the old 6-hour timer and staleness check are gone and the
  cache file is rewritten each time. With no internet the cached list and last known prices are used and labelled. With
  no cache and no internet there are no models yet and `/sm` says so.
- **pi's `/model` is built from the API's data, not from model names**: `smart`, your favorites, recent models (last 8),
  today's free-allowance models (from `/v1/credits`) and `pinned` matches. It no longer adds the router's
  preference-list picks. The router can still use any listed model: it registers the one it picks on demand, and it
  stays in `/model` while smart is using it.
- **The hidden-thinking guard no longer matches model names.** It now applies to models the API data shows as
  billed-but-hidden thinkers (reasoning model, no `include_reasoning`, accepts `reasoning_effort`, or no parameter list
  at all), instead of the hard-coded `claude-*-5` pattern.
- The `best value` / `balanced` / `top quality` badges in `/sm` and the `/sovereign pick` options show what the router
  would pick per tier from the API's current models and prices.
- **Errors never switch the model.** Retries stay on the same model, which keeps the prompt cache. On the gateway's
  `rate_limit_exceeded` the limit is per key/plan (`rpm_limit` in `/v1/credits`), so switching could not help; if the
  error text carries a retry-after value the retry waits for it (pi's own backoff is only 2/4/8 s). The rate-limit
  notice is shown once per burst of retries.
- **Spend stays out of pi's own cost counter.** Models are registered with zero prices, so pi shows nothing for
  SovereignEG; the extension prices each reply from its token counts (input, output, cache read/write, 1-hour cache
  writes) with the catalog prices and shows it only in its own footer (`paid` / `free used`). Pi's `/model` list no longer
  shows prices for these models; `/sm` does.
- **Free vs paid is decided by the allowance, not by a routing buffer.** A model counts as free while it is in today's
  allowance list and allowance is left, so it turns `[PAID]` the moment the allowance runs out. A reply that crosses
  the end of the allowance is split (allowance first, the rest paid); nothing is charged to `paid` while the allowance
  covers it. `minAllowanceLeftEgp` now only affects routing.
- **The free allowance is shown in tokens** (`free left 0.99M/1.04M tokens (96%)`, `free used 41K`) using the API's
  own token figures, so it matches your plan. It falls back to EGP if the API doesn't report tokens.
- The footer no longer waits for the first message: credits are read when pi starts (retrying with back-off until the
  key works) and then refreshed on a timer.
- Install example in the README now pins `@v0.2.0`.

### Removed
- **The built-in model and price list**, and every hard-coded model name: the default per-tier preference lists
  (Haiku/Sonnet/Opus/Qwen/gpt-oss…), the Arabic Qwen/Haiku preference and the `gpt-oss` special case. The router now
  picks by price from whatever the API lists; `tiers` in the config is still available and empty by default.
- **Switching models on errors** (see Changed).
- **`/sovereign refresh`.** Redundant: the list is re-read from the API on every launch and every `/sm`.
- The always-on `rpm` counter and its 80% rate-limit warning (replaced by the opt-in counter above).

### Fixed
- **Wrong or outdated prices.** A catalog cached from the API was never re-read on start-up unless
  `SOVEREIGNEG_API_KEY` was set, so prices could stay days out of date. Prices of 100 EGP and more were rounded to
  whole numbers (`614.63` showed as `615`); every price now shows two decimals exactly as listed. The README example
  showed Qwen3.8-27B-FP8 at `5.00/15` (it is `8.41/67.29`).
- With `minAllowanceLeftEgp` set to `0`, smart routing kept picking free-allowance models after the allowance was
  completely used up. It now never routes to an allowance that is spent.
- The "Rate limited" notice never appeared: pi only calls `after_provider_response` for successful responses, so the
  429 branch there was dead code. It is now raised from the failed message and names your plan's limit.

## [0.1.1] - 2026-10-30

### Changed
- Footer usage now refreshes from `/v1/credits` every **5 s** while the agent works (was 15 s), so it feels live.
  Polls no longer overlap if the API is slow. Set `statusRefreshSeconds` to change it (`0` = off).
- Distribution is **GitHub only**: the npm badge, `npm:` install commands and the npm publish step are gone.
- README: install shows both options, always-latest (`git:github.com/GreenVenom77/pi-sovereigneg`) and pinned to a release (`@v0.1.1`).

### Fixed
- CI: silenced the `node-domexception` deprecation warning (dev dependency, replaced via `overrides`) and moved the
  workflows to `actions/checkout@v5` / `actions/setup-node@v5` (Node 24 runtime).
- README license badge showed "package not found"; it now reads the license from GitHub, and the version badge shows the latest GitHub release.

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

# atc Developer Technical Changelog

Detailed code-level history of architectural changes, feature additions/removals, configuration keys, load-balancing engines, protocol hardening, and modified files/functions — ordered chronologically from oldest release to latest release.

---

## [v0.9.5] - 2026-10-28

### Core Multi-Account Proxy Foundation
- **Files Introduced / Updated**:
  - `src/account-manager/strategies/pipelined-strategy.js`, `src/account-manager/index.js`, `src/cli/interactive-dashboard.js`, `src/auth/oauth.js`
- **Capabilities**:
  - Introduced `PipelinedStrategy` proactive quota-step rotation (default `5%` step threshold).
  - Added dual-window quota parsing for 5-hour rolling buckets and 7-day weekly Argon caps.
  - Added subscription tier classification (`[ultra]`, `[pro]`, `[plus]`, `[free]`).
  - Built Alternate Screen Buffer (`\x1b[?1049h`) interactive terminal dashboard and background OAuth refresh handling.

---

## [v1.0.0] - 2026-10-30

### 1. Package Identity & Scope Migration
- **Files Modified**: `package.json`, `bin/cli.js`, `README.md`
- **Functions & Schema Changes**:
  - `package.json`: Renamed `"name"` from `"atc"` to `"@8w6s/atc"`, added `"publishConfig": { "access": "public" }`, and set `"author"` to `"8w6s <satoharuki2321@proton.me>"`.
  - `bin/cli.js`: Updated uninstall guidance from `npm uninstall -g atc` to `npm uninstall -g @8w6s/atc`.

### 2. Removal of Legacy WebUI & Bundle Reduction
- **Files Deleted**:
  - `public/*` (37 HTML/CSS/JS WebUI files).
  - `src/webui/index.js` (1,286 lines of deprecated Express WebUI server endpoints).
- **Files Modified**:
  - `package.json`: Removed `"public"` from `files`, deleted CSS build scripts (`build:css`, `watch:css`, `dev:full`), and removed unused CSS/frontend `devDependencies`.
  - `src/config.js`: Removed `webuiPassword` and legacy WebUI auth config fields.
  - `src/cloudcode/message-handler.js`, `src/cloudcode/streaming-handler.js`: Replaced WebUI remediation prompts with terminal CLI hints (`Run "atc" to inspect and re-authenticate accounts`).

### 3. Live Backend Model Catalog Inspection (`atc models`)
- **Files Modified**: `src/cli/terminal-manager.js`, `bin/cli.js`
- **Functions Added**:
  - `showBackendModels(target, { refresh })` in `src/cli/terminal-manager.js`: Ranks accounts by subscription tier (`ultra > pro > plus > free`), calls Cloud Code `v1internal:fetchAvailableModels`, formats model capabilities (`think`, `vision`, `rec`) alongside 5h-Cap and Weekly quotas, and caches results in `account.quota.models`.

### 4. Flagship Model Flex Binding (`atc flex`) & CLI Lifecycle Suite
- **Files Modified**: `bin/cli.js`, `src/cli/changelog-viewer.js`, `src/cli/interactive-dashboard.js`
- **Functions Added**:
  - `flexCommand()` in `bin/cli.js`: Binds Claude 3.7 Sonnet and Claude 3 Opus aliases to Gemini backends in `~/.config/atc/config.json` and `~/.claude/settings.json`.
  - `daemonCheckCommand()`, `defuseCommand()`, `uninstallCommand()`, and `update` command in `bin/cli.js`.
  - `showInteractiveChangelog()` and `syncUserChangelog()` in `src/cli/changelog-viewer.js`.
  - Fixed `--` / `n/a` quota display fallbacks in `showAccountStatus()` and `runInteractiveDashboard()`, and externalized custom OAuth credentials out of source files into `~/.config/atc/config.json`.

---

## [v1.0.1] - 2026-10-31 (Latest)

### Summary of File Inventory Changes (vs. `v1.0.0`)

- **New Files Added (12)**:
  - `src/utils/upstream-transport.js` — Per-account isolated HTTPS/1.1 socket pools, jittered burst pacer, hourly circuit breaker, gzip/deflate/brotli streaming decoder, idle vs. active stream timeout separation.
  - `src/utils/token-counter.js` — Offline Anthropic-compatible `/v1/messages/count_tokens` heuristic estimator for text, images, documents, tools, thinking blocks, and system prompts.
  - `src/utils/terminal-box.js` — ANSI CSI stripper, East-Asian/Unicode display-column calculator (`getDisplayWidth`, `padEndVisible`, `truncateVisible`), `renderRoundedBox()`, and `renderDoubleBox()`.
  - `src/cli/diagnostics.js` — `runDoctor({ fix })`, `showTelemetryStats()`, `showLiveLogs()`, and `toggleSingleAccountLock()`.
  - `src/cli/tips.js` — Structured `SAFETY_TIPS` knowledge base and `getTipTickerFrame()` constant-cadence ticker engine with configurable scroll speeds (`slow`, `normal`, `fast`, `static`).
  - `src/account-manager/strategies/locked-strategy.js` — `LockedStrategy` (`[safest]`, hard single-account pin).
  - `src/account-manager/strategies/day-split-strategy.js` — `DaySplitStrategy` (`[low-risk]`, max 1 primary + 1 standby per calendar day).
  - `src/account-manager/strategies/shift-split-strategy.js` — `ShiftSplitStrategy` (`[low-risk]`, deterministic AM `00:00–11:59` / PM `12:00–23:59` 2-slot workday split).
  - `src/account-manager/strategies/session-strategy.js` — `SessionStrategy` (`[low-risk]`, natural idle-gap handover after >=45m session work).
  - `src/account-manager/strategies/weekly-guard-strategy.js` — `WeeklyGuardStrategy` (`[low-risk]`, protects 7-day Argon/Opus caps with a 20% weekly reserve floor and 15m minimum stay).
  - `src/account-manager/strategies/warmup-strategy.js` — `WarmupStrategy` (`[moderate]`, 5-request / 45m gentle warm-up drip for newly linked `<48h` accounts while seasoned accounts carry primary load).
  - `src/account-manager/strategies/custom-strategy.js` — `CustomStrategy`, `normalizeCustomProfile()`, `evaluateCustomProfileRisk()`, and `slugifyProfileId()` powering user-authored load balancer profiles (`custom:<id>`).

- **Existing Files Modified (27)**:
  - `package.json`, `bin/cli.js`, `docs/CHANGELOG.md`, `src/index.js`, `src/server.js`, `src/config.js`, `src/constants.js`, `src/changelogs.txt`, `src/auth/oauth.js`, `src/account-manager/index.js`, `src/account-manager/credentials.js`, `src/account-manager/storage.js`, `src/account-manager/strategies/base-strategy.js`, `src/account-manager/strategies/index.js`, `src/account-manager/strategies/pipelined-strategy.js`, `src/cli/accounts.js`, `src/cli/changelog-viewer.js`, `src/cli/interactive-dashboard.js`, `src/cli/terminal-manager.js`, `src/cloudcode/message-handler.js`, `src/cloudcode/streaming-handler.js`, `src/cloudcode/model-api.js`, `src/cloudcode/rate-limit-state.js`, `src/cloudcode/request-builder.js`, `src/modules/usage-stats.js`, `src/utils/helpers.js`, `src/utils/version-detector.js`.

---

### 1. Upstream Transport Isolation & Native Antigravity Client Alignment
- **Files**: `src/utils/upstream-transport.js`, `src/utils/version-detector.js`, `src/cloudcode/request-builder.js`, `src/cloudcode/message-handler.js`, `src/cloudcode/streaming-handler.js`, `src/cloudcode/model-api.js`, `src/auth/oauth.js`, `src/constants.js`
- **Added / Changed**:
  - Replaced shared global `fetch()` socket reuse with `upstreamRequest()` and `upstreamFetch()` in `src/utils/upstream-transport.js`:
    - Dedicated `https.Agent` (`ALPNProtocols: ['http/1.1']`, `maxSockets: 6`, `maxFreeSockets: 2`) keyed per account email (`normalizePoolKey(accountKey)`), preventing two Google accounts from sharing a warm TLS connection.
    - Decoupled idle keep-alive socket expiry (`config.keepAliveIdleSec`, default `30s`) from active streaming socket deadlines (`config.upstreamTimeoutSec`, default `300s`).
    - Added per-account jittered burst pacer (`waitForPacerSlot()` using `config.pacerDelayMs` + `config.pacerJitterPct`) and rolling 1-hour per-account circuit breaker (`checkHourlyAccountBudget()`, `recordAccountRequest()` using `config.hourlyAccountCap`).
  - Updated `src/utils/version-detector.js` (`getClientVersion()`, `generateSmartUserAgent()`) to extract the installed Antigravity version + changelist tuple (`antigravity/<ver> <os>/<arch> google-api-nodejs-client/10.3.0` / `cl=<num>`) with native `2.28.2` fallback.
  - Updated `buildHeaders()` and `buildCloudCodeRequest()` in `src/cloudcode/request-builder.js`:
    - Removed leaked Anthropic SDK / Node Undici headers (`anthropic-beta`, `anthropic-version`, `x-stainless-*`, `sec-fetch-mode`).
    - Removed non-native `request.stream` field from upstream Cloud Code JSON payloads and removed hardcoded synthetic system preambles.
    - Added `scrubClientIdentity()` (controlled by `config.sanitizeClientPrompts`, default `true`) to neutralize third-party CLI identity banners (`Claude Code`, `Cline`, `Roo Code`, `OpenCode`, `Kilo Code`) inside outgoing system instructions without altering user code blocks.
  - Updated `src/auth/oauth.js` and `src/cloudcode/model-api.js` (`loadCodeAssist`, `onboardUser`, `fetchAvailableModels`, `getModelQuotas`) to route control-plane calls through isolated account pools (`accountKey: email`) with synchronized `ClientMetadata` (`ideType: 'ANTIGRAVITY'`, `pluginType: 'GEMINI'`).

### 2. HTTP 403 Classification, Revocation Locking & Rate-Limit Deduplication
- **Files**: `src/account-manager/credentials.js`, `src/account-manager/index.js`, `src/cloudcode/rate-limit-state.js`, `src/cloudcode/message-handler.js`, `src/cloudcode/streaming-handler.js`
- **Added / Changed**:
  - Separated upstream `403` / OAuth error handling into three distinct states:
    1. `[verify-req]` (`VALIDATION_REQUIRED` / `verifyUrl` present): Stores `account.verifyUrl`, optionally pauses automatic routing when `config.pauseOnVerifyReq` is `true` and healthy alternates exist, and highlights `[V] Verify` on the TUI.
    2. `[banned]` (`TOS_VIOLATION`, `ACCOUNT_SUSPENDED`, `SERVICE_DISABLED`): Locks automatic background OAuth token refresh loops in `src/account-manager/credentials.js` (`isPermanentAuthFailure()`) so suspended accounts are never hammered.
    3. `[invalid]` (`invalid_grant` / revoked refresh token): Halts retry loops and marks the account for manual `[R] Re-login`.
  - Added `dedupedMarkRateLimited()` in `src/cloudcode/rate-limit-state.js` so concurrent streams hitting a simultaneous `429` do not compound exponential backoff multipliers.
  - Added global 5-hour quota floor (`config.globalQuotaThreshold`, default `10%`), weekly quota floor (`config.weeklyQuotaThreshold`, default `5%`, `#getWeeklyQuotaFraction()`), and single-account hard lock (`config.singleAccountLock`) inside `AccountManager` (`src/account-manager/index.js`).

### 3. Elimination of the 18-Request TUI Quota Polling Storm
- **Files**: `src/server.js`, `src/cli/interactive-dashboard.js`, `src/cli/terminal-manager.js`, `src/cli/accounts.js`
- **Changed**:
  - Changed `GET /health` in `src/server.js` to return zero-upstream cached pool and capability metadata (`capabilities: ['isolated-tls', 'pacer', 'hourly-cap', 'count-tokens', 'anti-burst-health']`) in `1–3ms`.
  - Added `quotaCacheTtlMs` (`config.quotaRefreshTtlSec`, default `300s`), single-flight `quotaRefreshInFlight` promise deduplication, and sequential `350–700ms` jittered per-account probing on `GET /account-limits?refresh=true` and `atc check`.
  - Added localhost bind enforcement (`config.bindHost` defaults to `'127.0.0.1'`) and port isolation (`43129` fallback when legacy `43128` is occupied).

### 4. Expanded Anti-Ban Load Balancer Modes & Custom Mode Profile Builder
- **Files**: `src/constants.js`, `src/account-manager/strategies/index.js`, `src/account-manager/strategies/base-strategy.js`, `src/account-manager/strategies/pipelined-strategy.js`, `src/account-manager/strategies/locked-strategy.js`, `src/account-manager/strategies/day-split-strategy.js`, `src/account-manager/strategies/shift-split-strategy.js`, `src/account-manager/strategies/session-strategy.js`, `src/account-manager/strategies/weekly-guard-strategy.js`, `src/account-manager/strategies/warmup-strategy.js`, `src/account-manager/strategies/custom-strategy.js`, `src/cli/interactive-dashboard.js`
- **Added**:
  - Expanded built-in `SELECTION_STRATEGIES` from 3 modes to **10 modes**, each annotated with live risk badges (`[safest]`, `[low-risk]`, `[moderate]`, `[elevated]`, `[high-risk]`):
    1. `locked` — Single-Account Lock (`[safest]`)
    2. `day-split` — Daily Primary + Standby (`[low-risk]`)
    3. `shift-split` — Workday 2x12h Shift (`[low-risk]`)
    4. `session` — Idle-Aware Session Shift (`[low-risk]`)
    5. `weekly-guard` — Weekly-Cap Preserver (`[low-risk]`)
    6. `sticky` — Sticky Drain-to-Floor (`[low-risk]`)
    7. `warmup` — Gradual Clone Warm-Up (`[moderate]`)
    8. `pipelined` — Pipelined Quota Shift (`[moderate]`, enforces `minStaySec`)
    9. `hybrid` — Hybrid Smart Score (`[elevated]`)
    10. `round-robin` — Round-Robin (`[high-risk]`)
  - Built `CustomStrategy` (`src/account-manager/strategies/custom-strategy.js`) and interactive `runCustomModeBuilderInline()` (`[N]` create, `[E]` edit, `[D]` delete inside `openLoadBalancerSelector()`), allowing users to configure `baseCore` (`day-slots`, `session-idle`, `sticky-floor`, `quota-step`, `locked`), `maxDailyAccounts`, `requireIdleGap`, `minIdleSec`, `minStaySec`, `quotaStepPct`, `floor5hPct`, `floorWeeklyPct`, `candidateOrder`, and `onUnavailable`, with real-time risk evaluation (`evaluateCustomProfileRisk()`) persisted in `config.customModes`.
  - Updated `src/index.js` `--strategy=<name>` CLI validator via `isValidStrategy()` to accept all 10 built-in modes as well as `custom:<profile-id>`.

### 5. Balanced 4-Tab Engine Settings, High-Contrast Safety Tips Ribbon & 3-Tab Model Mappings
- **Files**: `src/config.js`, `src/cli/interactive-dashboard.js`, `src/cli/tips.js`
- **Added / Changed**:
  - Expanded `~/.config/atc/config.json` schema in `src/config.js` with 14 new persisted operational and UI settings: `singleAccountLock`, `pacerDelayMs`, `pacerJitterPct`, `hourlyAccountCap`, `sanitizeClientPrompts`, `pauseOnVerifyReq`, `keepAliveIdleSec`, `globalQuotaThreshold`, `weeklyQuotaThreshold`, `accountSelection.minStaySec`, `accountSelection.idleBreakSec`, `switchAccountDelayMs`, `upstreamTimeoutSec`, `quotaRefreshTtlSec`, `loginTimeoutSec`, `bindHost`, `showTips`, `tipsDismissScope`, `tipsScrollSpeed`, `maskEmails`, `shimmerTitle`, and `customModes`.
  - Replaced the single-column Settings list with `openEngineSettings()` — a 4-tab, 3-column aligned configuration table (`1. Anti-Ban & Pacing`, `2. Pool & Failover`, `3. UI & Tips Banner`, `4. Network & Daemon`) exposing 27 live parameters with inline range warnings, per-tab defaults reset, and automatic Claude Code + daemon reload sync.
  - Added the scrolling Safety & Operational Tips Ribbon (`src/cli/tips.js` + `interactive-dashboard.js`):
    - High-contrast 256-color badge pills (`getTipBadgeStyle()`) paired with a dark slate ticker strip (`\x1b[38;5;230;48;5;236m`).
    - Locked badge width (`FIXED_TIP_BADGE_WIDTH`) so `viewportCols` never shifts when transitioning between `2/4` and `3/4`, completely eliminating boundary flicker.
    - Added `Ctrl+D` (`openTipDetails()`) full operational guide viewer and `X` hide/show toggle honoring `config.tipsDismissScope` (`'session'` vs. `'permanent'`) and startup `config.showTips`.
  - Redesigned `Model Mappings` (`cur.id === 'model_mapping'` in `src/cli/interactive-dashboard.js`):
    - Fixed the ConPTY overlapping-layer / blank-until-scroll bug by removing the shadowed inner `let isSubScreenActive = false;` declaration, stripping `\x1b[3J` from `c.clearScreen` inside the Alternate Screen Buffer, wiring `activeSubScreenRender` on terminal resize, and keeping TUI sub-screens in raw/nowrap mode without ConPTY line-discipline thrashing.
    - Replaced the cramped unpaginated list and jarring `readline` prompts with a 3-tab aligned table (`1. Claude Code Slots`, `2. Custom Aliases`, `3. Quick Presets`) featuring `[←/→ / Space]` instant backend cycling, 2-step inline cell editing (`[Enter]`), `[N]` inline custom alias creation, `[D]` alias deletion, and bounded viewport pagination.
  - Replaced cryptic `V/R/T/D Acct` footer text with a 2-line context-aware shortcut bar, added `[Space]` `Manage Account` popup (`openAccountActionsMenu()`), and matched `  > ` / `  · ` cursor widths (4 columns) across every screen.

### 6. CLI Observability, Chronological English Changelogs, Border Alignment & Windows Storage Fix
- **Files**: `bin/cli.js`, `src/cli/diagnostics.js`, `src/modules/usage-stats.js`, `src/server.js`, `src/cli/changelog-viewer.js`, `src/changelogs.txt`, `src/utils/terminal-box.js`, `src/index.js`, `src/account-manager/storage.js`
- **Added / Fixed**:
  - Added `atc doctor [--fix]`, `atc stats`, `atc logs [-f]`, `atc lock [on|off]`, and `POST /v1/messages/count_tokens`.
  - Recorded rolling request, input/output token, error code (`429`, `403`, `5xx`), and recent request ring-buffer telemetry in `src/modules/usage-stats.js` (`GET /api/stats`).
  - Rewrote `src/changelogs.txt` and `~/.config/atc/CHANGELOG.md` in 100% English and updated `parseChangelogFile()` / `showInteractiveChangelog()` in `src/cli/changelog-viewer.js` to sort and navigate chronologically from **oldest release (`v0.9.5`) to newest release (`v1.0.1 Latest`)**, adding `[SECURITY]` badge formatting, clean word wrapping, vertical `[↑/↓]` scrolling, and `[L]` Latest / `[F]` Oldest jump keys.
  - Audited and fixed all right-hand box borders (`│` and `║`) across `src/cli/changelog-viewer.js`, `src/cli/interactive-dashboard.js`, `bin/cli.js`, and `src/index.js` via `src/utils/terminal-box.js` (`getDisplayWidth()`, `renderRoundedBox()`, `renderDoubleBox()`).
  - Hardened `saveAccounts()` in `src/account-manager/storage.js` with per-process unique temp filenames (`${configPath}.${process.pid}.${++tmpCounter}.tmp`) and Windows `EPERM`/`EACCES`/`EBUSY` rename retries + safe in-place write fallback to prevent HTTP 500 errors during concurrent TUI and daemon saves.

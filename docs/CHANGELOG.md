# atc Developer Technical Changelog

Detailed code-level changes, modified functions, file references, and architectural impacts.

---

## [v1.0.0] - 2026-10-30

### 1. Package Identity & Scope Migration
- **Files Modified**: `package.json`, `bin/cli.js`, `README.md`
- **Functions & Schema Changes**:
  - `package.json`: Renamed `"name"` from `"atc"` to `"@8w6s/atc"`.
  - `package.json`: Added `"publishConfig": { "access": "public" }` for scoped npm registry publishing.
  - `package.json`: Updated `"author"` to `"8w6s <satoharuki2321@proton.me>"`.
  - `bin/cli.js`: Updated uninstall guidance command from `npm uninstall -g atc` to `npm uninstall -g @8w6s/atc`.
- **Purpose**: Establishes unique scoped npm namespace and prepares package for public npm registry distribution.

### 2. Removal of Legacy WebUI & Bundle Optimization
- **Files Deleted**:
  - `public/*` (37 files: HTML, CSS, client-side stores, translations, UI components).
  - `src/webui/index.js` (1286 lines of deprecated web dashboard server logic).
- **Files Modified**:
  - `package.json`: Stripped `"public"` from published files, removed build scripts (`build:css`, `watch:css`, `dev:full`), and purged unused devDependencies (`@tailwindcss/forms`, `daisyui`, `postcss`, `tailwindcss`, `autoprefixer`, `concurrently`).
  - `src/config.js`: Removed `webuiPassword` property, authentication middleware references, and redundant web routes.
  - `src/cloudcode/message-handler.js` & `streaming-handler.js`: Replaced user-facing error messages referencing WebUI with CLI instructions (`Run "atc" to inspect and re-authenticate accounts`).
- **Purpose**: Eliminates 15,000+ lines of dead code and reduces package size and attack surface, shifting ATC to a 100% terminal-native design.

### 3. Backend Model Inspection (`atc models`)
- **Files Modified**: `src/cli/terminal-manager.js`, `bin/cli.js`
- **Functions Added/Updated**:
  - `showBackendModels({ refresh = false })` in `src/cli/terminal-manager.js`:
    - Queries `loadAccounts()` from `ACCOUNT_CONFIG_PATH`.
    - Implements account tier ranking (`ultra: 5, pro/standard: 4, plus: 3, free: 2, unknown: 1`) to select the highest-tier account in the pool.
    - Resolves access tokens via `getTokenForAccount()` and project IDs via `getProjectForAccount()`.
    - Calls `fetchAvailableModels(token, project)` directly against Google Cloud Code `v1internal:fetchAvailableModels`.
    - Parses model capabilities: `supportsThinking` $\rightarrow$ `think`, `supportsImages`/`supportsVideo` $\rightarrow$ `vision`, `recommended` $\rightarrow$ `rec`.
    - Formats 5h-Cap and Weekly quota metrics.
    - Caches discovered quotas into `account.quota.models` and persists via `saveAccounts()`.
- **Purpose**: Allows users to inspect all 20+ models available to their Google accounts directly from the terminal without guessing model IDs.

### 4. Flagship Model Flex Binding (`atc flex`)
- **Files Modified**: `bin/cli.js`
- **Functions Added**:
  - `flexCommand()` in `bin/cli.js`:
    - Injects premier model aliases (`claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `claude-3-opus-20240229`, `claude-3-5-haiku-20241022`) into `~/.config/atc/config.json` (`modelMapping`).
    - Maps Claude flagship models to backend Gemini engines (`gemini-3.8-flash-high` and `gemini-3.1-flash-lite`).
    - Updates `~/.claude/settings.json` environment variables (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_SONNET`, `ANTHROPIC_DEFAULT_OPUS`, `CLAUDE_CODE_SUBAGENT`).
- **Purpose**: Enables one-touch setup for Claude Code CLI users wanting flagship model flags mapped to free Google infrastructure.

### 5. Deep Daemon Diagnostics (`atc daemon`)
- **Files Modified**: `bin/cli.js`
- **Functions Added**:
  - `daemonCheckCommand()` in `bin/cli.js`:
    - Inspects `server.pid` and validates if PID is active.
    - Performs parallel HTTP fetch to `/health` and `/account-limits` with 3000ms abort signal.
    - Computes real roundtrip ping latency in milliseconds.
    - Reports pool status (ready, rate-limited, invalid accounts) and active routing strategy.
    - Detects stale PIDs and provides actionable restart remedies.
- **Purpose**: Reliable troubleshooting command to verify background proxy health and latency without digging into logs.

### 6. Account Status Table & Quota Display Fixes
- **Files Modified**: `src/cli/terminal-manager.js`, `src/cli/interactive-dashboard.js`
- **Functions Updated**:
  - `showAccountStatus()` in `src/cli/terminal-manager.js`:
    - Added Plan Badge formatting (`[ultra]`, `[pro]`, `[plus]`, `[free]`).
    - Fallback mechanism: reads `acc.quota?.models` when proxy daemon live stats are not cached.
    - Replaced ambiguous `n/a` or `--` strings with explicit percentage and reset timers.
  - `runInteractiveDashboard()` in `src/cli/interactive-dashboard.js`:
    - Fixed quota extraction to query `lim.limits || lim.models || acc.quota?.models || live.models`.
    - Added Secret API Key editing field in Engine Settings with auto-sync to `~/.claude/settings.json` (`ANTHROPIC_API_KEY`).
    - Standardized box display width to 67 columns across all screens.
- **Purpose**: Fixes visual regressions where accounts incorrectly displayed `--` and `n/a` despite having valid quota metrics.

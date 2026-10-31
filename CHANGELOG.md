# atc Changelog (Oldest to Latest)

All notable changes to the atc proxy and multi-account manager, ordered chronologically from oldest release to latest release.

## [v0.9.5]

- **[NEW]** Introduced Pipelined Quota Shift load balancing to rotate accounts proactively after configurable quota steps.
- **[NEW]** Added dual-horizon quota tracking for both 5-hour rolling limits and 7-day weekly Argon caps.
- **[NEW]** Added automatic subscription tier detection for [ultra], [pro], [plus], and [free] Google AI plans.
- **[NEW]** Built an interactive TUI dashboard running inside an isolated Alternate Screen Buffer.
- **[FIX]** Added automatic background OAuth access-token refresh before session expiry.

## [v1.0.0]

- **[NEW]** Published official scoped release @8w6s/atc on the public npm registry.
- **[NEW]** Added "atc models [--refresh]" to probe live Antigravity backend model catalogs from the highest-tier account.
- **[NEW]** Added "atc flex" for one-step mapping of Claude 3.7 Sonnet and Claude 3 Opus aliases to Gemini backends.
- **[NEW]** Added "atc daemon" for deep process health, port binding, PID, and HTTP round-trip latency diagnostics.
- **[NEW]** Added "atc accounts" table listing account IDs, plan badges, 5h-Cap percentages, and Weekly quota status.
- **[NEW]** Added "atc changelog" interactive book viewer with version search and automatic ~/.config/atc/CHANGELOG.md sync.
- **[NEW]** Added "atc update" to check npm registry versions, install updates, and restart the background proxy daemon.
- **[NEW]** Added "atc defuse" and "atc uninstall" lifecycle commands for clean Windows Startup and Claude Code removal.
- **[NEW]** Added "atc settings" / "atc config" shortcut to jump straight into Engine Settings, including Secret API Key sync.
- **[SECURITY]** Removed embedded Google OAuth client secrets from source code and moved custom OAuth storage to ~/.config/atc/config.json.
- **[CHANGED]** Streamlined Model Mappings by removing 28 auto-generated legacy model aliases and adding "atc mapid" ("atc map").
- **[FIX]** Resolved "--" 5h-Cap and "n/a" Weekly quota display regressions across the TUI dashboard and terminal status view.
- **[REMOVED]** Removed 15,000+ lines of deprecated WebUI assets (public/, src/webui/) and unused CSS build dependencies.

## [v1.0.1] (Latest)

- **[NEW]** Isolated per-account HTTP/1.1 TLS connection pools (src/utils/upstream-transport.js) with jittered burst pacing and hourly request circuit breakers.
- **[NEW]** Aligned upstream User-Agent, Go-style transport headers, and OAuth metadata with native Antigravity 2.28.2 client behavior while scrubbing third-party client prompt markers.
- **[NEW]** Expanded Load Balancer to 10 built-in modes with live risk badges ([safest] to [high-risk]): Single-Account Lock, Daily Primary + Standby, Workday 2x12h Shift, Idle-Aware Session Shift, Weekly-Cap Preserver, Sticky Drain-to-Floor, Gradual Clone Warm-Up, Pipelined Quota Shift, Hybrid Smart Score, and Round-Robin.
- **[NEW]** Added interactive Custom Load Balancer Profile Builder ([N] New, [E] Edit, [D] Delete) with a live risk meter persisted in config.customModes.
- **[NEW]** Redesigned Engine Settings into a balanced 4-tab, 3-column table covering 27 real Anti-Ban, Pool & Failover, UI & Tips Banner, and Network & Daemon parameters.
- **[NEW]** Added a high-contrast, zero-flicker Safety & Operational Tips Ribbon (Ctrl+D for full guide, X to hide/show, startup toggle in Settings) including clone/family-slot risk guidance.
- **[NEW]** Added CLI hygiene and observability commands: "atc doctor [--fix]", "atc stats", "atc logs [-f]", and "atc lock [on|off]", plus local /v1/messages/count_tokens estimation.
- **[CHANGED]** Redesigned Model Mappings into a 3-tab aligned table (Claude Code Slots, Custom Aliases, Quick Presets) with instant inline editing and arrow-key backend cycling.
- **[CHANGED]** Ordered "atc changelog" chronologically from oldest release to newest release with 100% English release notes, vertical scrolling, and [L] Latest / [F] Oldest shortcuts.
- **[CHANGED]** Eliminated the 18-request TUI polling storm via cached /health responses, 300s quota TTLs, single-flight deduplication, and sequential jittered account probes.
- **[CHANGED]** Separated HTTP 403 classification into [verify-req] (browser challenge), [banned] (ToS lock stopping token refresh loops), and invalid_grant, plus readable 2-line account action shortcuts.
- **[FIX]** Fixed ConPTY sub-screen layer overlap in Model Mappings caused by shadowed sub-screen state and scrollback-clear escape sequences.
- **[FIX]** Fixed right-hand box border (│ / ║) misalignments across Changelog Book, TUI sub-screens, CLI banners, and daemon startup output using ANSI-aware display-width measurement.
- **[FIX]** Hardened Windows atomic accounts.json writes with per-PID temp files and EPERM retry/fallback logic during concurrent TUI and daemon saves.
- **[NEW]** Native Claude Desktop integration: automatic MCP configuration synchronization, path discovery across Windows, macOS, and Linux, and dedicated one-click launcher scripts ("atc desktop setup / status / launch").
- **[NEW]** Outbound Proxy IP Pool engine (src/utils/proxy-pool.js) with sticky-per-account consistency, round-robin, and random strategies to eliminate Google IP clustering and bulk account bans.
- **[NEW]** HTTP CONNECT tunneling over isolated per-account TLS sockets with automatic health tracking, error cooldowns, and direct-IP fallback.
- **[NEW]** Redesigned Settings & Model Mappings TUI with clean arrow-key tab navigation ([←/→]), single-key toggles ([Enter / Space]), and removal of numbered prefixes.
- **[NEW]** Enhanced high-contrast Safety Tips banner with dual-tone background styling, zero-flicker fixed viewport dimensions, and an explicit startup toggle in Settings.
- **[SECURITY]** Guarded streaming mid-flight retries: prevented duplicate message_start event emissions during disconnects and removed synthetic end_turn fallbacks.
- **[SECURITY]** Hardened account configuration storage: preserved corrupted configurations as timestamped backups and enabled automatic .bak recovery with POSIX 0600 permissions.
- **[SECURITY]** Enhanced upstream error parsing: mapped Google Cloud Code SAFETY, BLOCKLIST, and MALFORMED_FUNCTION_CALL finishes to proper refusal/stop_sequence events.
- **[FIX]** Fixed Model Mappings ConPTY layer overlap by introducing synchronous alternate buffer flushing and arrow-key tab switching without numeric hotkey clutter.
- **[FIX]** Fixed right border misalignment (|) in Model Mappings and TUI header boxes using strict column padding and Unicode box-drawing glyphs.
- **[FIX]** Eliminated duplicate action rows in Engine Settings and restored clean, balanced spacing across all categories.


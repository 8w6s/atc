# atc (Antigravity to Claude)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**atc** is a high-performance developer tool that bridges **Claude Code CLI** to Google Cloud Code's underlying Antigravity infrastructure. Rather than serving as a simple background proxy, **atc** is built around three distinct, decoupled subsystems: a streaming **API Proxy Engine**, an intelligent **Multi-Account Pool & Quota Scheduler**, and a terminal-native **TUI/CLI Management Interface**.

---

## The Three Core Pillars

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THREE CORE PILLARS                                   │
├──────────────────────────┬─────────────────────────────┬───────────────────────────────┤
│   1. API Proxy Engine    │  2. Account Pool & Quotas   │   3. TUI & CLI Controller     │
│  - Anthropic Messages API│  - Multi-account rotation   │  - Zero-flicker TUI dashboard │
│  - SSE stream translation│  - Pipelined Quota Shift 5% │  - Direct CLI commands        │
│  - Thinking block & tools│  - 5h & weekly telemetry    │  - Instant hot reload         │
│  - Google Cloud Code RPC │  - Plan tier auto-detection │  - Flagship model flex setup  │
└────────────┬─────────────┴──────────────┬──────────────┴───────────────┬───────────────┘
             │                            │                              │
             ▼                            ▼                              ▼
┌─────────────────────────┐  ┌───────────────────────────┐  ┌───────────────────────────┐
│     Claude Code CLI     │  │     Google Account Pool   │  │   Interactive Dashboard   │
│ (http://localhost:43128)│  │ [ultra] / [pro] / [plus]  │  │  (atc / atc models / ...) │
└─────────────────────────┘  └───────────────────────────┘  └───────────────────────────┘
```

### 1. API Proxy Engine (Protocol & Message Adapter)
- **Anthropic Messages Emulation**: Exposes a standard HTTP Messages API (`/v1/messages`) that seamlessly receives requests from Claude Code CLI.
- **Bi-Directional Streaming Adapter**: Translates Google Cloud Code RPC streaming chunks into standard Server-Sent Events (SSE) events (`content_block_start`, `content_block_delta`, `message_delta`, `message_stop`).
- **Advanced Capabilities Support**: Full support for tool use / function calling, native thinking blocks, and dynamic context windows.

### 2. Account Pool & Quota Scheduler (Resource Optimization)
- **Pipelined Quota Rotation**: Automatically staggers usage across accounts by shifting traffic upon each configured quota drop threshold (default 5%), allowing 5-hour quota pools to recover in parallel without user friction.
- **Subscription Tier Auto-Discovery**: Automatically probes and labels accounts (`[ultra]`, `[pro]`, `[plus]`, `[free]`).
- **Telemetry & Quota Tracking**: Continuously monitors both short-term 5-hour caps and long-term weekly quotas across all linked accounts.
- **Automatic Failover & Cooldown**: Instantly shifts traffic away from rate-limited or invalid accounts to healthy candidates.

### 3. TUI & CLI Management (Control Plane)
- **Zero-Flicker Terminal TUI**: High-contrast, double-buffered terminal dashboard with instant account switching (`1`-`9`), OAuth re-authentication (`R`), and engine tuning.
- **Zero-Downtime Hot Reloading**: Modifications to accounts or settings take effect immediately in the running proxy daemon without service interruptions.
- **Developer Command Suite**: Purpose-built CLI shortcuts (`atc models`, `atc flex`, `atc daemon`, `atc accounts`, `atc defuse`, `atc settings`).

---

## Quick Start

### 1. Installation

From the project root:

```bash
# Install dependencies
pnpm install --allow-build=better-sqlite3

# Link CLI command globally
npm link --force
```

### 2. Automatic Initialization

Run `atc init` to configure Claude Code settings and Windows boot startup automatically:

```bash
atc init
```

### 3. Open the Dashboard

Simply run `atc` without arguments to launch the isolated TUI:

```bash
atc
```

---

## CLI Command Reference

### Lifecycle & Management

| Command | Description |
| :--- | :--- |
| `atc` | Open the interactive TUI dashboard (default) |
| `atc init` | One-touch setup: configure Claude Code and Windows startup |
| `atc reinit` | Repair configuration and restart proxy daemon instance |
| `atc defuse` | Safely remove Windows startup and Claude Code proxy bindings |
| `atc uninstall` | Completely uninstall atc from PC (with option to keep or purge configs) |
| `atc start [--log]` | Launch proxy daemon (background by default, or foreground live logs) |
| `atc stop` | Shut down active proxy daemon |
| `atc restart` | Restart proxy daemon |
| `atc daemon` | Run deep health, latency, and account pool diagnostic on daemon |

### Accounts & Quotas

| Command | Description |
| :--- | :--- |
| `atc accounts` | List all saved accounts with index numbers, tiers, 5h-Cap, and weekly quotas |
| `atc add [--no-browser]` | Link a new Google account via OAuth browser flow or manual URL |
| `atc remove <id \| email>` | Remove an account from the pool by index (1-9) or email |
| `atc switch <id \| email>` | Switch active routing account from the command line |
| `atc toggle <id \| email>` | Enable or disable an account in the rotation pool |
| `atc check` | Probe all accounts and refresh live quota metrics |

### Models & Settings

| Command | Description |
| :--- | :--- |
| `atc models [--refresh]` | Probe and list available Antigravity backend models from top-tier account |
| `atc mapid` | Display current Claude alias → backend model mappings |
| `atc flex` | Auto-bind Claude 3.7 Sonnet & Opus to Google backend models |
| `atc settings` / `atc config` | Directly open proxy engine settings and custom secret API key |

---

## Dashboard Controls & Hotkeys

| Key | Action |
| :--- | :--- |
| `↑` / `↓` (or `k` / `j`) | Navigate between actions and accounts |
| `Enter` | Select action, switch active account, or edit parameter |
| `1` – `9` | Instant one-touch switch to account number |
| `V` / `v` | Open Google Security Verification URL if account flagged |
| `R` / `r` | In-place OAuth re-login for the highlighted account |
| `T` / `t` | Toggle account enabled / disabled in rotation pool |
| `D` / `d` | Delete account from pool with confirmation |
| `Q` / `Esc` / `Ctrl+C` | Exit dashboard back to terminal |

---

## Claude Code CLI Configuration

When running `atc init` or `atc flex`, Claude Code is automatically configured in `%USERPROFILE%\.claude\settings.json` (Windows) or `~/.claude/settings.json` (macOS / Linux):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:43128",
    "ANTHROPIC_API_KEY": "atc-local-key",
    "ANTHROPIC_MODEL": "claude-3-7-sonnet-20250219",
    "ANTHROPIC_DEFAULT_SONNET": "claude-3-7-sonnet-20250219",
    "ANTHROPIC_DEFAULT_OPUS": "claude-3-opus-20240229",
    "ANTHROPIC_DEFAULT_HAIKU": "claude-3-5-haiku-20241022",
    "CLAUDE_CODE_SUBAGENT": "claude-3-5-haiku-20241022"
  }
}
```

Once configured, simply run Claude Code normally:

```bash
claude
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.

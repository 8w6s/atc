# atc (Antigravity to Claude)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**atc** is a terminal-first proxy and multi-account manager that exposes a fully Anthropic-compatible Messages API backed by Google Cloud Code (Antigravity). It routes **Claude Code CLI** and compatible agent tools through a pooled cluster of Google accounts with intelligent load balancing, quota tracking, and live health monitoring.

---

## Key Features

- **Dashboard-First TUI (`atc`)**: Interactive terminal dashboard with zero-flicker double buffering, arrow-key navigation, instant account switching (`1`-`9`), and in-place OAuth re-login (`R`).
- **Multi-Account Pool Management**: Rotate requests across multiple Google accounts to bypass single-account rate limits. Automatically discovers subscription tiers (`[pro]`, `[free]`, `[ultra]`) and live 5h & weekly quota metrics.
- **Pipelined Quota Rotation**: Automatically staggers usage across accounts by shifting traffic upon each configured quota drop threshold (default 5%), allowing 5-hour quota pools to recover in parallel.
- **Antigravity Model Catalog (`atc models`)**: Introspects available Gemini and Claude backend models from the highest-tier account in your pool.
- **Flagship Flex Mode (`atc flex`)**: Instantly binds Claude Code CLI to Anthropic flagship tiers (`claude-3-7-sonnet-20250219`, `claude-3-opus-20240229`) silently backed by Google Gemini 3.8 infrastructure.
- **Deep Daemon Diagnostics (`atc daemon`)**: Live health checks, PID verification, and HTTP ping latency measurements.
- **Zero-Downtime Hot Reload**: Add, re-authenticate, toggle, or switch accounts without restarting the background daemon. Changes reload instantly in-memory.
- **Complete Messages API Emulation**: Full streaming SSE response converter, tool use / function calling, and thinking block handling.

---

## Architecture

```text
┌─────────────────────────┐          ┌───────────────────────────┐          ┌──────────────────────────┐
│     Claude Code CLI     │ ───────▶ │     atc Proxy Daemon      │ ───────▶ │  Google Cloud Code API   │
│ (Anthropic Messages API)│ :43128   │  (Account Pool & Routing) │          │(daily-cloudcode-pa / v1) │
└─────────────────────────┘          └─────────────┬─────────────┘          └──────────────────────────┘
                                                   │
                                     ┌─────────────▼─────────────┐
                                     │     atc Terminal TUI      │
                                     │  (Interactive Dashboard)  │
                                     └───────────────────────────┘
```

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

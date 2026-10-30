# atc (Antigravity to Claude)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**atc** is a terminal-first proxy and multi-account manager that exposes a fully Anthropic-compatible Messages API backed by Google Cloud Code (Antigravity). It routes **Claude Code CLI** and compatible agent tools through a pooled cluster of Google accounts with intelligent load balancing, quota tracking, and live health monitoring.

---

## Key Features

- **Dashboard-First TUI (`atc`)**: Interactive terminal dashboard with zero-flicker double buffering, arrow-key navigation, instant account switching (`1`-`9`), and in-place OAuth re-login (`R`).
- **Multi-Account Pool Management**: Rotate requests across multiple Google accounts to bypass single-account rate limits. Automatically discovers subscription tiers (`[pro]`, `[free]`, `[ultra]`) and live model quotas.
- **Zero-Downtime Hot Reload**: Add, re-authenticate, toggle, or switch accounts without restarting the background daemon. Changes reload instantly in-memory.
- **Custom Model Mappings**: Out-of-the-box support for Claude tiers (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`) and Claude 3.x aliases mapped to high-efficiency Gemini backends (`gemini-3.8-flash-high`, `gemini-3.8-flash-medium`).
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

# Link CLI commands globally (atc & acc)
npm link --force
```

### 2. Launch the Proxy Daemon

```bash
atc start
```

The daemon starts in the background on port `43128` and persists across terminal sessions.

### 3. Open the Dashboard

Simply run `atc` without arguments:

```bash
atc
```

```text
+ Accounts Dashboard (atc v2.9.1)

Quick Actions
o Add New Account
o Run Health Check
o Pick Best Account
o API credentials and models

Advanced Checks
o Refresh All Accounts
o Check Problem Accounts

Saved Accounts
o 1. satofam2321@gmail.com [pro] [ok]
> 2. satoharuki2202@gmail.com [pro] [current] [ok]
  Last used: 2m ago | High: [##########] 95% | Med: [##########] 95% | active [aicode-consumers]
o 3. neyu6639@gmail.com [pro] [ok]
o 4. satoharuki2575@gmail.com [pro] [ok]
o 5. ysnyuki2321@gmail.com [pro] [ok]
o 6. satoharuki5654@gmail.com [pro] [invalid]

Danger Zone
o Toggle Selected Account
o Delete Selected Account

↑↓ Move | Enter Select | R Re-login | 1-9 Switch | Q Back
+
```

---

## Dashboard Controls & Hotkeys

| Key | Action |
| :--- | :--- |
| `↑` / `↓` (or `k` / `j`) | Navigate between actions and accounts |
| `Enter` | Select action or switch active account |
| `1` – `9` | Instant one-touch switch to account number |
| `R` / `r` | In-place OAuth re-login for the highlighted account (repairs `[invalid]` credentials) |
| `Q` / `Esc` / `Ctrl+C` | Exit dashboard back to terminal |

---

## CLI Command Reference

| Command | Description |
| :--- | :--- |
| `atc` | Open the interactive TUI dashboard (default) |
| `atc dash` | Explicit shortcut to interactive dashboard |
| `atc switch <id \| email>` | Quick-switch active account from CLI |
| `atc status` | Print non-interactive status overview (script-friendly) |
| `atc models` | Display active Claude alias → Gemini backend mappings |
| `atc start` | Launch proxy background service |
| `atc start --log` | Run proxy in foreground with live console logs |
| `atc restart` | Restart proxy background service |
| `atc stop` | Stop proxy daemon |

---

## Claude Code CLI Configuration

Edit `%USERPROFILE%\.claude\settings.json` (Windows) or `~/.claude/settings.json` (macOS / Linux):

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:43128",
    "ANTHROPIC_MODEL": "claude-sonnet-5-5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-5-5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-haiku-5-5"
  }
}
```

Once configured, run Claude Code normally:

```bash
claude
```

---

## Storage & Configuration Files

- Accounts Pool: `~/.config/antigravity-proxy/accounts.json`
- Proxy Configuration: `~/.config/antigravity-proxy/config.json`
- Daemon PID: `~/.config/antigravity-proxy/server.pid`

---

## License

MIT

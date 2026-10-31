# atc (Antigravity to Claude)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

`atc` is a local proxy daemon and multi-account pool manager that connects **Claude Code CLI** to Google Cloud Code backend models. It exposes an Anthropic-compatible Messages API while handling OAuth authentication, load balancing, and quota tracking across multiple Google accounts.

---

## Architecture

The system consists of three decoupled components:

```text
┌─────────────────────────┐
│     Claude Code CLI     │
│ (http://localhost:43128)│
└────────────┬────────────┘
             │ HTTP /v1/messages
             ▼
┌────────────────────────────────────────────────────────┐
│                   atc Proxy Daemon                     │
│ ┌────────────────────────────────────────────────────┐ │
│ │ 1. Protocol Adapter (src/cloudcode)                │ │
│ │    • Anthropic schema -> Cloud Code RPC payload    │ │
│ │    • Cloud Code chunk stream -> Anthropic SSE      │ │
│ │    • Tool calls & thinking block preservation      │ │
│ └────────────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────┐ │
│ │ 2. Account Pool & Balancer (src/account-manager)   │ │
│ │    • OAuth token refresh & cache                   │ │
│ │    • 5h-cap and weekly quota telemetry             │ │
│ │    • Rotation strategies: pipelined / round-robin  │ │
│ └────────────────────────────────────────────────────┘ │
└────────────┬─────────────────────────────▲─────────────┘
             │ gRPC/REST                   │ IPC / reload
             ▼                             │
┌─────────────────────────┐   ┌────────────┴─────────────┐
│  Google Cloud Code API  │   │  3. CLI & TUI Interface  │
│ (daily-cloudcode-pa/v1) │   │     (src/cli, bin/cli)   │
└─────────────────────────┘   └──────────────────────────┘
```

### 1. Proxy Core (`src/cloudcode`, `src/proxy`)
- Exposes `POST /v1/messages` on `http://127.0.0.1:43128`.
- Translates Anthropic request schemas into Google Cloud Code internal RPC payloads.
- Converts upstream streaming chunks into standard Server-Sent Events (`message_start`, `content_block_start`, `content_block_delta`, `message_delta`, `message_stop`).
- Forwards tool call signatures, image buffers, and thinking parameters.

### 2. Account Pool & Balancer (`src/account-manager`)
- Manages credentials and refresh tokens stored in `~/.config/atc/accounts.json`.
- Detects subscription tiers (`ultra`, `pro`, `plus`, `free`) and project IDs.
- Tracks model-level quota metrics: 5-hour rolling limits and weekly caps.
- Selection strategies:
  - `pipelined` (default): Rotates to the next available account after a configurable quota drop (default 5%) to let exhausted pools recover in parallel.
  - `round-robin`: Cycles accounts sequentially per request.
  - `hybrid`: Weights remaining quota fraction against recent error rates.
  - `sticky`: Pins to the active account until rate-limited.
- Automatically isolates rate-limited or invalid credentials.

### 3. TUI & CLI Management (`src/cli`, `bin/cli.js`)
- Alternate-screen terminal dashboard with live quota bars and in-place OAuth login (`R`).
- Hot-reloads configuration into daemon memory without dropped connections.
- Standalone CLI commands for scripting and direct pool operations.

---

## Quick Start

### 1. Install

```bash
# Global install
npm i -g @8w6s/atc

# Or clone and link locally
pnpm install --allow-build=better-sqlite3
npm link --force
```

### 2. Initialize

Configures `~/.claude/settings.json` and optionally sets up background auto-start on Windows boot:

```bash
atc init
```

### 3. Launch Dashboard

Run `atc` without arguments to open the terminal UI:

```bash
atc
```

---

## CLI Reference

### Daemon & Lifecycle

| Command | Description |
| :--- | :--- |
| `atc` | Open interactive TUI dashboard (default) |
| `atc init` | Initial setup: configure Claude Code settings and Windows startup |
| `atc reinit` | Re-sync configuration and restart daemon |
| `atc defuse` | Remove Windows startup shortcut and Claude Code proxy settings |
| `atc uninstall` | Remove daemon, configuration, and optionally purge `~/.config/atc` |
| `atc start [--log]` | Start proxy daemon (background by default; `--log` runs in foreground) |
| `atc stop` | Stop running proxy daemon |
| `atc restart` | Restart proxy daemon |
| `atc daemon` | Check daemon process, port binding, and HTTP health latency |

### Accounts & Quota

| Command | Description |
| :--- | :--- |
| `atc accounts` | List configured accounts with ID, plan tier, 5h-cap, and weekly status |
| `atc add [--no-browser]` | Add Google account via OAuth browser flow or manual URL |
| `atc remove <id \| email>` | Remove account from pool by index (1-based) or email |
| `atc switch <id \| email>` | Switch active routing account |
| `atc toggle <id \| email>` | Enable or disable account in rotation pool |
| `atc check` | Probe all accounts and refresh quota cache |

### Models & Settings

| Command | Description |
| :--- | :--- |
| `atc models [--refresh]` | Probe backend models available to the highest-tier account in pool |
| `atc mapid` | Print active model alias mappings |
| `atc flex` | Configure Claude Code environment variables for flagship model IDs |
| `atc settings` / `atc config` | Open proxy engine settings screen directly |
| `atc desktop [setup\|status\|launch]` | Connect proxy & MCP bridge server to Claude Desktop app |

---

## Claude Desktop Integration

`atc` natively supports the official Anthropic Claude Desktop application. It registers a local MCP bridge and generates an automated launcher script ensuring `ANTHROPIC_BASE_URL` directs traffic to your active `atc` account pool.

```bash
# 1. Synchronize Claude Desktop configuration & register MCP bridge
atc desktop setup

# 2. Inspect active integration status
atc desktop status

# 3. Launch Claude Desktop routed through atc
atc desktop launch
```

---

## Outbound Proxy IP Pool

To eliminate bulk Google account suspension caused by multiple accounts issuing requests from a single residential or datacenter IP cluster, `atc` v1.0.2 includes an Outbound Proxy IP Pool engine:

- **Sticky-per-Account (Default & Safest)**: Permanently pins each Google account to a consistent proxy IP, preventing anomalous multi-IP hopping that triggers automated Google Cloud Code security challenges.
- **Round-Robin & Random**: Distributes requests evenly across forward proxies for high-throughput subagent bursts.
- **Failover Protection**: Automatically cools down failing proxies for 60 seconds and gracefully falls back to direct IP connection.

Configure proxies via **Settings → Tab 3 (Proxy IP Pool)** in the TUI dashboard, or edit `~/.config/atc/config.json`:

```json
{
  "proxyPoolEnabled": true,
  "proxyRotationStrategy": "sticky-account",
  "proxyFallbackDirect": true,
  "proxyIpPool": [
    "http://username:password@proxy1.example.com:8080",
    "http://username:password@proxy2.example.com:8080"
  ]
}
```

---

## TUI Keybindings

| Key | Action |
| :--- | :--- |
| `↑` / `↓` (`k` / `j`) | Navigate items |
| `Enter` | Select action, switch account, or edit field |
| `1` – `9` | Switch directly to account index |
| `V` | Open Google verification URL in browser |
| `R` | Re-authenticate selected account via OAuth |
| `T` | Toggle selected account enabled / disabled |
| `D` | Delete selected account |
| `Esc` / `q` / `Ctrl+C` | Exit dashboard |

---

## Claude Code Configuration

`atc init` writes the following settings to `%USERPROFILE%\.claude\settings.json` (Windows) or `~/.claude/settings.json` (macOS/Linux):

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

Once configured, run Claude Code:

```bash
claude
```

---

## Documentation

- **[Anti-Ban & Google Enforcement Deep Dive](docs/GOOGLE_BAN_MECHANISMS.md)**: Technical breakdown of Google Cloud Code / GFE anti-abuse detection vectors, 5-tier penalty taxonomy, multi-account rotation risks, and production safety guidelines.
- **[Changelog](docs/CHANGELOG.md)**: Full release history and architectural improvements.

---

## License

MIT © 2026 [8w6s](mailto:satoharuki2321@proton.me).

Free to use, modify, and distribute. Original author attribution must be preserved; claiming authorship of the original codebase is strictly prohibited.

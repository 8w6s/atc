#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, openSync } from 'fs';
import { spawn, exec } from 'child_process';
import { logger } from '../src/utils/logger.js';
if (!process.argv.includes('--log')) {
  logger.info = () => {};
  logger.warn = () => {};
}
import { runInteractiveDashboard } from '../src/cli/interactive-dashboard.js';
import { showInteractiveChangelog, syncUserChangelog } from '../src/cli/changelog-viewer.js';
import {
  showAccountStatus,
  switchAccount,
  checkAccounts,
  loginAccount,
  removeAccount,
  toggleAccount,
  showModelMappings,
  showBackendModels
} from '../src/cli/terminal-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json for version
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
);

// ANSI Colors & Styles
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  cyan: '\x1b[36m',
  bCyan: '\x1b[96m',
  magenta: '\x1b[35m',
  bMagenta: '\x1b[95m',
  green: '\x1b[32m',
  bGreen: '\x1b[92m',
  yellow: '\x1b[33m',
  bYellow: '\x1b[93m',
  red: '\x1b[31m',
  bRed: '\x1b[91m',
  gray: '\x1b[90m',
  white: '\x1b[97m'
};

/**
 * Calculate display width of string in terminal, handling emojis (width=2)
 * and stripping ANSI codes (width=0).
 */
function getDisplayWidth(str) {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (!cp) continue;
    if ((cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x200D) {
      continue;
    }
    if (
      (cp >= 0x1F300 && cp <= 0x1F9FF) || // Emojis & Pictographs
      (cp >= 0x2600 && cp <= 0x27BF) ||   // Misc symbols & Dingbats
      (cp >= 0x2300 && cp <= 0x23FF) ||   // Misc Technical
      (cp >= 0x2B50 && cp <= 0x2B55) ||   // Stars
      (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
      (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) || // CJK
      (cp >= 0xAC00 && cp <= 0xD7A3) ||   // Hangul Syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility
      (cp >= 0xFF01 && cp <= 0xFF60) ||   // Fullwidth Forms
      (cp >= 0xFFE0 && cp <= 0xFFE6)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Render a perfectly aligned rounded box with unified 67-column width
 */
function printBox(contentLines, width = 67) {
  const innerWidth = width - 2;
  const top = `${c.cyan}╭${'─'.repeat(innerWidth)}╮${c.reset}`;
  const bottom = `${c.cyan}╰${'─'.repeat(innerWidth)}╯${c.reset}`;

  console.log(top);
  for (const rawLine of contentLines) {
    const dispWidth = getDisplayWidth(rawLine);
    const pad = Math.max(0, innerWidth - dispWidth);
    console.log(`${c.cyan}│${c.reset}${rawLine}${' '.repeat(pad)}${c.cyan}│${c.reset}`);
  }
  console.log(bottom);
}

// PID file location for background process management
const CONFIG_DIR = join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'atc');
const PID_FILE = join(CONFIG_DIR, 'server.pid');

const args = process.argv.slice(2);
const command = args[0];

// Ensure config directory exists
function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Check if the service is running by reading PID file and verifying process
 */
function isServiceRunning() {
  if (!existsSync(PID_FILE)) {
    return false;
  }

  try {
    const pidStr = readFileSync(PID_FILE, 'utf-8');
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      cleanupPidFile();
      return false;
    }

    // Check if process is running (signal 0 doesn't kill, just checks)
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Process doesn't exist
    cleanupPidFile();
    return false;
  }
}

/**
 * Check if a specific PID is still running
 */
function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the PID of the running service
 */
function getServicePid() {
  if (!existsSync(PID_FILE)) {
    return null;
  }
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);
    return isNaN(pid) ? null : pid;
  } catch (e) {
    return null;
  }
}

/**
 * Save PID to file
 */
function savePid(pid) {
  ensureConfigDir();
  writeFileSync(PID_FILE, pid.toString(), 'utf-8');
}

/**
 * Clean up PID file
 */
function cleanupPidFile() {
  if (existsSync(PID_FILE)) {
    try {
      unlinkSync(PID_FILE);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Get current port from environment or default
 */
function getPort() {
  return process.env.PORT || 43128;
}

/**
 * Check if TCP port is in use
 */
async function isPortInUse(port = getPort()) {
  return new Promise((resolve) => {
    import('net').then(({ createConnection }) => {
      const socket = createConnection({ port: Number(port), host: '127.0.0.1' }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    }).catch(() => resolve(false));
  });
}

/**
 * P0: Ping real HTTP /health endpoint to verify health status
 */
async function checkProxyHealth(port = getPort(), timeoutMs = 10000) {
  const startTime = Date.now();
  const healthUrl = `http://127.0.0.1:${port}/health`;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        return true;
      }
    } catch {
      // Wait and retry
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

/**
 * Start the server as a background process (or foreground with --log)
 */
async function startServer() {
  const logMode = args.includes('--log');
  const port = getPort();

  // Process-level Singleton: Check if port is already active
  const inUse = await isPortInUse(port);
  if (inUse) {
    const isHealthy = await checkProxyHealth(port, 2000);
    if (isHealthy) {
      if (!logMode) {
        console.log('');
        printBox([`  🛸 ${c.bold + c.bCyan}atc proxy is already in orbit${c.reset}`], 67);
        console.log('');
        const pid = getServicePid();
        if (pid) console.log(`   ${c.cyan}├─${c.reset} PID:       ${c.bYellow}${pid}${c.reset}`);
        console.log(`   ${c.cyan}├─${c.reset} Endpoint:  ${c.underline}http://localhost:${port}${c.reset}`);
        console.log(`   ${c.cyan}└─${c.reset} TUI:       Run "atc" or "atc dash"\n`);
      }
      return { success: true, pid: getServicePid(), port, alreadyRunning: true };
    } else {
      console.log(`\n${c.yellow}▲ Port ${port} is occupied but health check failed.${c.reset}`);
      console.log(`  Cleaning up any stale atc process...`);
      await stopServer({ silent: true });
      const stillInUse = await isPortInUse(port);
      if (stillInUse) {
        console.error(`\n${c.red}▲ Port ${port} is occupied by another application.${c.reset}`);
        console.log(`  Please free port ${port} before starting atc.\n`);
        return { success: false, port };
      }
    }
  }

  if (isServiceRunning() && !logMode) {
    const healthy = await checkProxyHealth(port, 2000);
    if (healthy) {
      console.log('');
      printBox([`  🛸 ${c.bold + c.bCyan}atc proxy is already in orbit${c.reset}`], 67);
      console.log('');
      const pid = getServicePid();
      console.log(`   ${c.cyan}├─${c.reset} PID:       ${c.bYellow}${pid}${c.reset}`);
      console.log(`   ${c.cyan}├─${c.reset} Endpoint:  ${c.underline}http://localhost:${port}${c.reset}`);
      console.log(`   ${c.cyan}└─${c.reset} TUI:       Run "atc" or "atc dash"\n`);
      return { success: true, pid, port, alreadyRunning: true };
    } else {
      console.log(`\n${c.yellow}▲${c.reset} Stale atc proxy process detected, recycling...`);
      await stopServer({ silent: true });
    }
  }

  console.log('');
  if (logMode) {
    console.log(`${c.bCyan}🌌 Launching atc proxy (foreground mode)...${c.reset}`);
    console.log(`   ${c.gray}Press Ctrl+C to stop${c.reset}\n`);
  } else {
    console.log(`${c.bCyan}🌌 Launching atc proxy...${c.reset}`);
  }

  const serverScript = join(__dirname, '..', 'src', 'index.js');
  const serverArgs = args.slice(1).filter(arg => arg !== '--log');

  if (logMode) {
    const serverProcess = spawn(process.execPath, [serverScript, ...serverArgs], {
      stdio: 'inherit',
      env: { ...process.env, PORT: port.toString() }
    });

    serverProcess.on('error', (error) => {
      console.error(`\n${c.red}▲ Launch failed:${c.reset} ${error.message}\n`);
      process.exit(1);
    });

    serverProcess.on('exit', (code) => {
      console.log(`\n${c.gray}🌙 atc proxy has exited${c.reset}\n`);
      process.exit(code || 0);
    });

    return { success: true, pid: serverProcess.pid, port };
  }

  // Background detached mode with log redirection
  ensureConfigDir();
  const logFile = join(CONFIG_DIR, 'daemon.log');
  const logFd = openSync(logFile, 'a');

  const serverProcess = spawn(process.execPath, [serverScript, ...serverArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    shell: false,
    env: { ...process.env, PORT: port.toString() }
  });

  serverProcess.on('error', (error) => {
    console.error(`\n${c.red}▲ Launch failed:${c.reset} ${error.message}\n`);
    process.exit(1);
  });

  savePid(serverProcess.pid);
  serverProcess.unref();

  // Wait for real HTTP health endpoint confirmation
  const isHealthy = await checkProxyHealth(port, 12000);
  if (isHealthy) {
    console.log('');
    printBox([`  ⚡ ${c.bold + c.bGreen}atc proxy is now in orbit!${c.reset}`], 67);
    console.log('');
    console.log(`   ${c.cyan}├─${c.reset} Process ID: ${c.bYellow}${serverProcess.pid}${c.reset}`);
    console.log(`   ${c.cyan}├─${c.reset} Endpoint:   ${c.underline}http://localhost:${port}${c.reset}`);
    console.log(`   ${c.cyan}└─${c.reset} TUI:        Run "atc" in terminal\n`);
    console.log(`   ${c.bold}Quick Commands:${c.reset}`);
    console.log(`   • ${c.cyan}atc${c.reset}           → Open interactive TUI dashboard`);
    console.log(`   • ${c.cyan}atc status${c.reset}    → View proxy health & quotas`);
    console.log(`   • ${c.cyan}atc stop${c.reset}      → Shut down proxy\n`);
    return { success: true, pid: serverProcess.pid, port };
  } else {
    console.error(`\n${c.yellow}▲ Proxy launched but health check timed out${c.reset}`);
    console.log(`   Verify manually: ${c.cyan}curl http://localhost:${port}/health${c.reset}`);
    console.log(`   Or run with logs: ${c.cyan}atc start --log${c.reset}\n`);
    return { success: false, pid: serverProcess.pid, port };
  }
}

/**
 * Stop the running server gracefully
 */
async function stopServer({ silent = false } = {}) {
  const pid = getServicePid();
  let stopped = false;

  if (pid && isPidRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (!isPidRunning(pid)) {
          stopped = true;
          break;
        }
      }
      if (isPidRunning(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    } catch {}
  }

  cleanupPidFile();

  // Wait for port release
  const port = getPort();
  for (let i = 0; i < 10; i++) {
    const inUse = await isPortInUse(port);
    if (!inUse) break;
    await new Promise(r => setTimeout(r, 200));
  }

  if (!silent) {
    if (stopped || pid) {
      console.log(`\n${c.green}✓${c.reset} atc proxy daemon has been taken offline.\n`);
    } else {
      console.log(`\n${c.gray}• atc proxy is not running.${c.reset}\n`);
    }
  }
  return true;
}

/**
 * Restart the server
 */
async function restartServer() {
  console.log(`\n${c.bCyan}♻️  Restarting atc proxy...${c.reset}`);
  await stopServer({ silent: true });
  await startServer();
}

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function isConfigInitialized() {
  if (!existsSync(CONFIG_FILE)) return false;
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const cfg = JSON.parse(raw);
    return !!cfg.initialized;
  } catch {
    return false;
  }
}

function setConfigInitialized(val = true) {
  ensureConfigDir();
  let cfg = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      cfg = {};
    }
  }
  cfg.initialized = val;
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * Show server status
 */
function showStatus() {
  console.log('');
  printBox([`  🛸 ${c.bold + c.bCyan}atc (Antigravity to Claude)${c.reset} ${c.bMagenta}v${packageJson.version}${c.reset}`], 67);
  console.log('');

  if (isServiceRunning()) {
    const pid = getServicePid();
    const port = getPort();
    console.log(`  ${c.bold}STATUS${c.reset}`);
    console.log(`  ${c.green}⚡ Proxy is active${c.reset}\n`);
    console.log(`  ${c.bold}DETAILS${c.reset}`);
    console.log(`  ${c.cyan}├─${c.reset} PID:       ${c.bYellow}${pid}${c.reset}`);
    console.log(`  ${c.cyan}├─${c.reset} Port:      ${c.bYellow}${port}${c.reset}`);
    console.log(`  ${c.cyan}├─${c.reset} API:       ${c.underline}http://localhost:${port}${c.reset}`);
    console.log(`  ${c.cyan}└─${c.reset} TUI:       Run "atc" or "atc dash"\n`);
    console.log(`  ${c.bold}AVAILABLE COMMANDS${c.reset}`);
    console.log(`  • ${c.cyan}atc${c.reset}            Open interactive TUI dashboard`);
    console.log(`  • ${c.cyan}atc restart${c.reset}    Relaunch proxy`);
    console.log(`  • ${c.cyan}atc stop${c.reset}       Take offline`);
  } else {
    console.log(`  ${c.bold}STATUS${c.reset}`);
    console.log(`  ${c.gray}🌑 Proxy is offline${c.reset}\n`);
    console.log(`  ${c.bold}TO LAUNCH${c.reset}`);
    console.log(`  • ${c.cyan}atc start${c.reset}      Bring proxy online`);
  }
  console.log('');
}

async function updateCommand() {
  console.log(`\n${c.bold}Checking for updates for @8w6s/atc...${c.reset}`);
  const currentVersion = packageJson.version || '1.0.0';

  try {
    const res = await fetch('https://registry.npmjs.org/@8w6s/atc/latest', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    });

    if (res.status === 404) {
      console.log(`\n${c.yellow}ℹ️  Package @8w6s/atc is in local development (not yet published to npm).${c.reset}`);
      console.log(`   Current local version: ${c.bold + c.cyan}v${currentVersion}${c.reset}\n`);
      return;
    }

    if (!res.ok) {
      throw new Error(`Registry returned HTTP ${res.status}`);
    }

    const data = await res.json();
    const latestVersion = data.version;

    if (!latestVersion || latestVersion === currentVersion) {
      console.log(`\n${c.green}✓ atc is already on the latest version (v${currentVersion}).${c.reset}\n`);
      return;
    }

    console.log(`\n${c.yellow}★ Update available:${c.reset} ${c.gray}v${currentVersion}${c.reset} → ${c.bGreen}v${latestVersion}${c.reset}`);
    console.log(`Updating via npm: ${c.cyan}npm i -g @8w6s/atc@latest${c.reset} ...\n`);

    const { execSync } = await import('child_process');
    execSync('npm i -g @8w6s/atc@latest', { stdio: 'inherit' });

    syncUserChangelog();

    if (isServiceRunning()) {
      console.log(`\n${c.cyan}Restarting proxy daemon to apply updates...${c.reset}`);
      await restartServer();
      console.log(`${c.green}✓ Proxy daemon restarted with v${latestVersion}.${c.reset}`);
    }

    console.log(`\n${c.green + c.bold}✓ Successfully updated to v${latestVersion}!${c.reset}`);
    console.log(`Run ${c.cyan}atc changelog${c.reset} to see what's new.\n`);

  } catch (err) {
    console.log(`\n${c.red}Failed to check for updates:${c.reset} ${err.message}`);
    console.log(`You can run manually: ${c.cyan}npm i -g @8w6s/atc@latest${c.reset}\n`);
  }
}

function showHelp() {
  console.log('');
  printBox([
    `  🛸 ${c.bold + c.bCyan}atc (Antigravity to Claude)${c.reset} ${c.bMagenta}v${packageJson.version}${c.reset}`
  ], 67);

  console.log(`
Route Claude Code CLI through Antigravity's multi-model API
with intelligent load balancing across Google accounts.

${c.bold + c.cyan}USAGE${c.reset}
  ${c.bCyan}atc${c.reset} <command> [options]

${c.bold + c.bCyan}━━━ LIFECYCLE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
  ${c.cyan}init, initialize${c.reset}    Configure atc for Claude Code & Windows startup
  ${c.cyan}reinit${c.reset}              Repair configuration & restart proxy daemon
  ${c.cyan}defuse${c.reset}              Remove Windows startup & Claude Code integration
  ${c.cyan}start [--log]${c.reset}       Launch proxy daemon in background (or live log)
  ${c.cyan}stop${c.reset}                Shut down active proxy daemon
  ${c.cyan}restart${c.reset}             Restart proxy daemon
  ${c.cyan}daemon${c.reset}              Run deep health & latency diagnostic on daemon
  ${c.cyan}uninstall${c.reset}           Completely remove atc from PC (clean/keep config)

${c.bold + c.bCyan}━━━ DASHBOARD & ACCOUNTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
  ${c.cyan}atc, dash${c.reset}           Open interactive TUI dashboard (default)
  ${c.cyan}accounts, status${c.reset}    List all accounts with ID, Plan, 5h-Cap & Weekly
  ${c.cyan}add [--no-browser]${c.reset}  Link new Google account via OAuth browser or URL
  ${c.cyan}remove <id>${c.reset}         Remove account from pool by index (1-9) or email
  ${c.cyan}switch <id>${c.reset}         Switch active account by index (1-9) or email
  ${c.cyan}toggle <id>${c.reset}         Enable or disable account in rotation pool
  ${c.cyan}check, probe${c.reset}        Probe all accounts and refresh live quota stats

${c.bold + c.bCyan}━━━ MODELS & SETTINGS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
  ${c.cyan}models [--refresh]${c.reset}  List available Antigravity models (from top plan)
  ${c.cyan}mapid, map${c.reset}          List Claude Code fake model ID mappings
  ${c.cyan}flex${c.reset}                Auto-bind Claude 3.7 Sonnet & Opus to Google backend
  ${c.cyan}settings, config${c.reset}    Directly open proxy engine & secret key settings

${c.bold + c.bCyan}━━━ UPDATES & CHANGELOG ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
  ${c.cyan}changelog, cl${c.reset}       Browse version changelogs interactively (Book viewer)
  ${c.cyan}update, upgrade${c.reset}     Check and update atc to latest version from npm

${c.bold + c.bCyan}━━━ OPTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
  ${c.yellow}-h, -H, --help${c.reset}      Show this help
  ${c.yellow}-v, --version${c.reset}       Show version
  ${c.yellow}--log${c.reset}               Run in foreground with live stream logs
  ${c.yellow}--strategy=NAME${c.reset}     Load balancer strategy: pipelined (5%),
                      hybrid, round-robin, sticky
`);
}

function showVersion() {
  console.log(packageJson.version);
}

// Startup & Claude Code configuration paths
const STARTUP_DIR = join(
  process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
);
const STARTUP_VBS = join(STARTUP_DIR, 'atc-proxy.vbs');
const CLAUDE_DIR = join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
const CLAUDE_SETTINGS = join(CLAUDE_DIR, 'settings.json');

function configureClaudeCode(port = 43128) {
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }
  let settings = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    try {
      settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf-8'));
    } catch {
      settings = {};
    }
  }
  settings.env = settings.env || {};
  settings.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
  if (!settings.env.ANTHROPIC_API_KEY) {
    settings.env.ANTHROPIC_API_KEY = 'atc-local-key';
  }
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8');
}

function unconfigureClaudeCode() {
  if (existsSync(CLAUDE_SETTINGS)) {
    try {
      const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf-8'));
      if (settings.env) {
        delete settings.env.ANTHROPIC_BASE_URL;
        if (settings.env.ANTHROPIC_API_KEY === 'atc-local-key') {
          delete settings.env.ANTHROPIC_API_KEY;
        }
        writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8');
      }
    } catch {}
  }
}

function installWindowsStartup(cliPath) {
  if (process.platform !== 'win32') return false;
  if (!existsSync(STARTUP_DIR)) {
    mkdirSync(STARTUP_DIR, { recursive: true });
  }
  const cleanPath = cliPath.replace(/\\/g, '\\\\');
  const vbsContent = 'Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run "node """ & "' + cleanPath + '" & """ start", 0, False\r\n';
  writeFileSync(STARTUP_VBS, vbsContent, 'utf-8');
  return true;
}

function removeWindowsStartup() {
  if (existsSync(STARTUP_VBS)) {
    try {
      unlinkSync(STARTUP_VBS);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isWindowsStartupInstalled() {
  return existsSync(STARTUP_VBS);
}

async function initCommand() {
  console.log('');
  printBox([`  ⚡ ${c.bold + c.bCyan}Initializing atc (Antigravity to Claude)${c.reset}`], 67);
  console.log('');

  const port = getPort();

  // Singleton guard: if already initialized and healthy, prevent redundant spawns
  if (isConfigInitialized()) {
    const isHealthy = await checkProxyHealth(port, 2000);
    if (isHealthy) {
      console.log(`${c.green}✓${c.reset} ${c.bold + c.bGreen}atc is already initialized and proxy is running healthy!${c.reset}`);
      console.log(`  • Proxy endpoint: ${c.underline}http://localhost:${port}${c.reset}`);
      console.log(`  • TUI:            Run "atc" or "atc dash" in terminal\n`);
      console.log(`  To re-sync or change configuration, run: ${c.cyan}atc reinit${c.reset}`);
      console.log(`  To view current accounts and quota, run:  ${c.cyan}atc${c.reset} or ${c.cyan}atc status${c.reset}\n`);
      return;
    }
  }

  configureClaudeCode(port);
  console.log(`${c.green}✓${c.reset} ${c.bold}Configuration updated${c.reset} (~/.claude/settings.json):`);
  console.log(`  ${c.cyan}•${c.reset} ANTHROPIC_BASE_URL = http://localhost:${port}`);
  console.log(`  ${c.cyan}•${c.reset} ANTHROPIC_API_KEY  = atc-local-key\n`);

  if (process.platform === 'win32') {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(r => rl.question(`${c.bold}Do you want atc to start automatically on Windows boot? [Y/n]:${c.reset} `, r));
    rl.close();

    if (answer.trim().toLowerCase() !== 'n') {
      installWindowsStartup(join(__dirname, 'cli.js'));
      console.log(`${c.green}✓${c.reset} Added atc to Windows Startup (runs silently in background on PC boot).\n`);
    } else {
      console.log(`${c.gray}• Skipped Windows Startup configuration.${c.reset}\n`);
    }
  }

  console.log(`${c.bCyan}Starting atc proxy daemon...${c.reset}`);
  const result = await startServer();

  if (result && result.success) {
    setConfigInitialized(true);
    console.log(`\n🎉 ${c.bold + c.bGreen}Setup complete!${c.reset} Just run "${c.cyan}claude${c.reset}" in any terminal to start using Antigravity models.\n`);
  } else {
    console.log(`\n${c.yellow}▲${c.reset} ${c.bold + c.yellow}Proxy status unknown / launch timeout${c.reset}`);
    console.log(`  Configuration has been saved, but the proxy daemon is not responding yet.`);
    console.log(`  Verify manually: ${c.cyan}curl http://localhost:${port}/health${c.reset}`);
    console.log(`  Or run in foreground: ${c.cyan}atc start --log${c.reset}\n`);
  }
}

async function reinitCommand() {
  console.log('');
  printBox([`  ♻️   ${c.bold + c.bCyan}Reinitializing atc Configuration${c.reset}`], 67);
  console.log('');

  // Controlled cleanup of previous instance: ensure only 1 instance
  console.log(`${c.cyan}•${c.reset} Ensuring any existing proxy daemon is stopped...`);
  await stopServer({ silent: true });

  const port = getPort();
  configureClaudeCode(port);
  console.log(`${c.green}✓${c.reset} ${c.bold}Configuration updated:${c.reset} Claude Code re-synced to http://localhost:${port}`);

  if (process.platform === 'win32' && isWindowsStartupInstalled()) {
    installWindowsStartup(join(__dirname, 'cli.js'));
    console.log(`${c.green}✓${c.reset} Refreshed Windows Startup shortcut.`);
  }

  console.log(`\n${c.bCyan}Launching fresh atc proxy instance...${c.reset}`);
  const result = await startServer();

  if (result && result.success) {
    setConfigInitialized(true);
    console.log(`\n${c.green}✓${c.reset} ${c.bold + c.bGreen}atc proxy successfully reinitialized!${c.reset}\n`);
  } else {
    console.log(`\n${c.yellow}▲${c.reset} ${c.bold + c.yellow}Proxy status unknown / launch timeout${c.reset}`);
    console.log(`  Configuration was updated, but the fresh proxy instance timed out during health check.`);
    console.log(`  Run ${c.cyan}atc start --log${c.reset} to diagnose startup errors.\n`);
  }
}

async function defuseCommand() {
  console.log('');
  printBox([`  🛡️   ${c.bold + c.bMagenta}Defuse atc from Windows Startup / System${c.reset}`], 67);
  console.log('');

  let startupRemoved = false;
  if (process.platform === 'win32') {
    startupRemoved = removeWindowsStartup();
  }

  const running = isServiceRunning();
  let proxyStopped = false;

  if (running) {
    const readline = await import('readline');
    const rlDaemon = readline.createInterface({ input: process.stdin, output: process.stdout });
    const stopAns = await new Promise(r => rlDaemon.question(`${c.bold}Do you want to stop the currently running proxy daemon? [Y/n]:${c.reset} `, r));
    rlDaemon.close();

    if (stopAns.trim().toLowerCase() !== 'n') {
      await stopServer({ silent: true });
      proxyStopped = true;
    }
  }

  const readline = await import('readline');
  const rlClaude = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ansClaude = await new Promise(r => rlClaude.question(`\n${c.bold}Do you also want to remove atc proxy from Claude Code settings? [y/N]:${c.reset} `, r));
  rlClaude.close();

  let claudeRemoved = false;
  if (ansClaude.trim().toLowerCase() === 'y') {
    unconfigureClaudeCode();
    claudeRemoved = true;
  }

  setConfigInitialized(false);

  console.log('');
  if (startupRemoved) {
    console.log(`${c.green}✓${c.reset} Windows Startup integration removed.`);
  } else {
    console.log(`${c.gray}• Windows Startup integration was not present.${c.reset}`);
  }

  if (proxyStopped) {
    console.log(`${c.green}✓${c.reset} Active proxy daemon stopped.`);
  } else if (running) {
    console.log(`${c.gray}• Active proxy daemon preserved.${c.reset}`);
  }

  if (claudeRemoved) {
    console.log(`${c.green}✓${c.reset} Removed atc proxy configuration from Claude Code settings.`);
  } else {
    console.log(`${c.gray}• Claude Code configuration preserved.${c.reset}`);
  }

  console.log(`${c.green}•${c.reset} ${c.bold}Existing accounts and credentials preserved${c.reset} (~/.config/atc/).\n`);
  console.log(`${c.bold}atc has been safely defused.${c.reset}\n`);
}

async function flexCommand() {
  console.log('');
  printBox([`  ⚡ ${c.bold + c.bCyan}Claude Code Flagship Model Mapping${c.reset}`], 67);
  console.log('');

  // 1. Update ~/.config/atc/config.json with premier model mappings
  let cfg = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {}
  }
  cfg.modelMapping = cfg.modelMapping || {};
  cfg.modelMapping['claude-3-7-sonnet-20250219'] = 'gemini-3.8-flash-high';
  cfg.modelMapping['claude-3-5-sonnet-20241022'] = 'gemini-3.8-flash-high';
  cfg.modelMapping['claude-3-opus-20240229'] = 'gemini-3.8-flash-high';
  cfg.modelMapping['claude-3-5-haiku-20241022'] = 'gemini-3.1-flash-lite';
  cfg.modelMapping['claude-opus-5-5'] = 'gemini-3.8-flash-high';
  cfg.modelMapping['claude-sonnet-5-5'] = 'gemini-3.8-flash-high';
  cfg.modelMapping['claude-haiku-5-5'] = 'gemini-3.1-flash-lite';
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');

  // 2. Update ~/.claude/settings.json environment variables
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }
  let claudeSettings = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    try {
      claudeSettings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf-8'));
    } catch {}
  }
  claudeSettings.env = claudeSettings.env || {};
  claudeSettings.env.ANTHROPIC_MODEL = 'claude-3-7-sonnet-20250219';
  claudeSettings.env.ANTHROPIC_DEFAULT_SONNET = 'claude-3-7-sonnet-20250219';
  claudeSettings.env.ANTHROPIC_DEFAULT_OPUS = 'claude-3-opus-20240229';
  claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU = 'claude-3-5-haiku-20241022';
  claudeSettings.env.CLAUDE_CODE_SUBAGENT = 'claude-3-5-haiku-20241022';
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(claudeSettings, null, 2), 'utf-8');

  console.log(`${c.green}✓${c.reset} ${c.bold}Claude Code model variables updated:${c.reset}\n`);
  console.log(`  ${c.cyan}•${c.reset} ANTHROPIC_MODEL         : ${c.bYellow}claude-3-7-sonnet-20250219${c.reset} → gemini-3.8-flash-high`);
  console.log(`  ${c.cyan}•${c.reset} ANTHROPIC_DEFAULT_SONNET: ${c.bYellow}claude-3-7-sonnet-20250219${c.reset} → gemini-3.8-flash-high`);
  console.log(`  ${c.cyan}•${c.reset} ANTHROPIC_DEFAULT_OPUS  : ${c.bYellow}claude-3-opus-20240229${c.reset}     → gemini-3.8-flash-high`);
  console.log(`  ${c.cyan}•${c.reset} CLAUDE_CODE_SUBAGENT    : ${c.bYellow}claude-3-5-haiku-20241022${c.reset}  → gemini-3.1-flash-lite\n`);
  console.log(`  Mappings saved to ~/.config/atc/config.json and ~/.claude/settings.json.\n`);
}

async function daemonCheckCommand() {
  console.log('');
  printBox([`  🛰️   ${c.bold + c.bCyan}atc Proxy Daemon Diagnostic${c.reset}`], 67);
  console.log('');

  const port = getPort();
  const pid = getServicePid();

  const startPing = Date.now();
  let health = null;
  let limits = null;
  let latency = null;

  try {
    const [hRes, lRes] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) }),
      fetch(`http://127.0.0.1:${port}/account-limits`, { signal: AbortSignal.timeout(3000) })
    ]);
    if (hRes.ok) health = await hRes.json();
    if (lRes.ok) limits = await lRes.json();
    latency = Date.now() - startPing;
  } catch {}

  if (health) {
    console.log(`  ${c.bold}DAEMON HEALTH${c.reset}`);
    console.log(`  ${c.green}● ACTIVE & RESPONSIVE${c.reset}\n`);
    console.log(`  ${c.bold}METRICS${c.reset}`);
    console.log(`  ${c.cyan}├─${c.reset} Process PID:  ${c.bYellow}${pid || 'managed'}${c.reset}`);
    console.log(`  ${c.cyan}├─${c.reset} Listen Port:  ${c.bYellow}${port}${c.reset} (${c.underline}http://127.0.0.1:${port}${c.reset})`);
    console.log(`  ${c.cyan}├─${c.reset} Ping Latency: ${c.bGreen}${latency}ms${c.reset}`);
    if (health.activeEmail) {
      console.log(`  ${c.cyan}├─${c.reset} Active Account: ${c.bold + c.bCyan}${health.activeEmail}${c.reset}`);
    }
    if (health.summary) {
      console.log(`  ${c.cyan}├─${c.reset} Pool Summary: ${health.summary}`);
    }
    console.log(`  ${c.cyan}└─${c.reset} Strategy:     ${c.magenta}${health.strategy || 'pipelined'}${c.reset}\n`);
    console.log(`  ${c.bold}VERDICT${c.reset}`);
    console.log(`  ${c.green}✓ Daemon is completely healthy and serving Claude Code CLI traffic.${c.reset}\n`);
  } else {
    console.log(`  ${c.bold}DAEMON HEALTH${c.reset}`);
    console.log(`  ${c.red}○ OFFLINE / UNRESPONSIVE${c.reset}\n`);
    console.log(`  ${c.bold}DIAGNOSTIC${c.reset}`);
    console.log(`  ${c.cyan}├─${c.reset} Process PID:  ${pid ? c.yellow + pid + ' (stale)' + c.reset : c.gray + 'none' + c.reset}`);
    console.log(`  ${c.cyan}├─${c.reset} Listen Port:  ${port}`);
    console.log(`  ${c.cyan}└─${c.reset} HTTP Ping:    ${c.red}Failed / Timed out${c.reset}\n`);
    console.log(`  ${c.bold}REMEDY${c.reset}`);
    console.log(`  Run "${c.cyan}atc start${c.reset}" or "${c.cyan}atc restart${c.reset}" to bring proxy online.\n`);
  }
}

async function uninstallCommand() {
  console.log('');
  printBox([`  ⚠️   ${c.bold + c.bRed}Uninstall atc Completely from System${c.reset}`], 67);
  console.log('');

  const readline = await import('readline');
  const rlConfirm = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ansConfirm = await new Promise(r => rlConfirm.question(`${c.bold}Are you sure you want to uninstall atc from this system? [y/N]:${c.reset} `, r));
  rlConfirm.close();

  if (ansConfirm.trim().toLowerCase() !== 'y') {
    console.log(`\n${c.gray}• Uninstallation cancelled.${c.reset}\n`);
    return;
  }

  // 1. Stop daemon
  if (isServiceRunning()) {
    console.log(`${c.cyan}•${c.reset} Stopping active proxy daemon...`);
    await stopServer({ silent: true });
  }

  // 2. Remove Windows startup
  if (process.platform === 'win32') {
    removeWindowsStartup();
  }

  // 3. Unconfigure Claude Code settings
  unconfigureClaudeCode();

  // 4. Ask about ~/.config/atc
  const rlConfig = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ansConfig = await new Promise(r => rlConfig.question(`\n${c.bold}Do you also want to remove all saved accounts and configs (~/.config/atc)? [y/N]:${c.reset} `, r));
  rlConfig.close();

  let configRemoved = false;
  if (ansConfig.trim().toLowerCase() === 'y') {
    try {
      const { rmSync } = await import('fs');
      if (existsSync(CONFIG_DIR)) {
        rmSync(CONFIG_DIR, { recursive: true, force: true });
        configRemoved = true;
      }
    } catch {}
  }

  setConfigInitialized(false);

  console.log(`\n${c.green}✓${c.reset} Proxy daemon stopped.`);
  console.log(`${c.green}✓${c.reset} Windows Startup integration removed.`);
  console.log(`${c.green}✓${c.reset} Claude Code proxy configuration restored.`);
  if (configRemoved) {
    console.log(`${c.green}✓${c.reset} Saved accounts and configuration removed (~/.config/atc).`);
  } else {
    console.log(`${c.gray}• Saved accounts preserved at ~/.config/atc.${c.reset}`);
  }

  console.log(`\n${c.bold}To complete total uninstallation, remove the CLI package:${c.reset}`);
  console.log(`  ${c.bCyan}npm uninstall -g @8w6s/atc${c.reset}\n`);
}

async function main() {
  // Handle flags
  if (args.includes('--help') || args.includes('-h') || args.includes('-H') || command === 'help') {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    showVersion();
    process.exit(0);
  }

  // Handle commands
    switch (command) {
    case 'start':
      await startServer();
      break;

    case 'stop':
      await stopServer();
      break;

    case 'restart':
      await restartServer();
      break;

    case 'dash':
    case 'dashboard':
    case 'tui':
      await runInteractiveDashboard();
      break;

    case 'status':
    case 'list':
      await showAccountStatus();
      break;

    case 'switch':
      await switchAccount(args[1]);
      break;

    case 'check':
    case 'probe':
      await checkAccounts();
      break;

    case 'login':
    case 'add': {
      const noBrowser = args.includes('--no-browser');
      await loginAccount({ noBrowser });
      break;
    }

    case 'init':
    case 'initialize':
      await initCommand();
      break;

    case 'reinit':
    case 'reinitialize':
      await reinitCommand();
      break;

    case 'defuse':
      await defuseCommand();
      break;

    case 'uninstall':
      await uninstallCommand();
      break;

    case 'flex':
      await flexCommand();
      break;

    case 'daemon':
      await daemonCheckCommand();
      break;

    case 'settings':
    case 'config':
      await runInteractiveDashboard({ initialScreen: 'settings' });
      break;

    case 'remove':
    case 'rm':
    case 'del':
    case 'delete':
      await removeAccount(args[1]);
      break;

    case 'toggle':
      await toggleAccount(args[1]);
      break;

    case 'models':
      await showBackendModels({ refresh: args.includes('--refresh') });
      break;

    case 'mapid':
    case 'map':
      showModelMappings();
      break;

    case 'changelog':
    case 'changelogs':
    case 'cl':
      await showInteractiveChangelog();
      break;

    case 'update':
    case 'upgrade':
      await updateCommand();
      break;

    case 'ui':
      console.log(`\n${c.cyan}ℹ️  WebUI panel has been removed.${c.reset}`);
      console.log(`   Use the interactive terminal dashboard instead: ${c.bold + c.bGreen}atc${c.reset} (or ${c.cyan}atc dash${c.reset})\n`);
      break;

    case 'accounts': {
      const sub = args[1];
      if (sub === 'list') await showAccountStatus();
      else if (sub === 'switch') await switchAccount(args[2]);
      else if (sub === 'verify' || sub === 'check') await checkAccounts();
      else if (sub === 'remove') await removeAccount(args[2]);
      else if (sub === 'add') await loginAccount({ noBrowser: args.includes('--no-browser') });
      else await showAccountStatus();
      break;
    }

    case 'help':
      showHelp();
      break;

    case 'version':
      showVersion();
      break;

    case undefined:
      if (process.stdin.isTTY) {
        await runInteractiveDashboard();
      } else {
        await showAccountStatus();
      }
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "atc --help" for usage information.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

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
import {
  showAccountStatus,
  switchAccount,
  checkAccounts,
  loginAccount,
  removeAccount,
  toggleAccount,
  showModelMappings
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
 * Render a perfectly aligned cyberpunk/neon rounded box
 */
function printBox(contentLines, width = 58) {
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
        printBox([`  🛸 ${c.bold + c.bCyan}atc proxy is already in orbit${c.reset}`], 56);
        console.log('');
        const pid = getServicePid();
        if (pid) console.log(`   ${c.cyan}├─${c.reset} PID:       ${c.bYellow}${pid}${c.reset}`);
        console.log(`   ${c.cyan}├─${c.reset} Local:     ${c.underline}http://localhost:${port}${c.reset}`);
        console.log(`   ${c.cyan}└─${c.reset} Dashboard: ${c.underline}http://localhost:${port}/${c.reset}\n`);
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
      printBox([`  🛸 ${c.bold + c.bCyan}atc proxy is already in orbit${c.reset}`], 56);
      console.log('');
      const pid = getServicePid();
      console.log(`   ${c.cyan}├─${c.reset} PID:       ${c.bYellow}${pid}${c.reset}`);
      console.log(`   ${c.cyan}├─${c.reset} Local:     ${c.underline}http://localhost:${port}${c.reset}`);
      console.log(`   ${c.cyan}└─${c.reset} Dashboard: ${c.underline}http://localhost:${port}/${c.reset}\n`);
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
    printBox([`  ⚡ ${c.bold + c.bGreen}atc proxy is now in orbit!${c.reset}`], 56);
    console.log('');
    console.log(`   ${c.cyan}├─${c.reset} Process ID: ${c.bYellow}${serverProcess.pid}${c.reset}`);
    console.log(`   ${c.cyan}├─${c.reset} Local:      ${c.underline}http://localhost:${port}${c.reset}`);
    console.log(`   ${c.cyan}└─${c.reset} Dashboard:  ${c.underline}http://localhost:${port}/${c.reset}\n`);
    console.log(`   ${c.bold}Quick Commands:${c.reset}`);
    console.log(`   • ${c.cyan}atc${c.reset}           → Open interactive TUI`);
    console.log(`   • ${c.cyan}atc ui${c.reset}        → Open dashboard in browser`);
    console.log(`   • ${c.cyan}atc status${c.reset}    → View proxy health`);
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
  printBox([`  🛸 ${c.bold + c.bCyan}atc (Antigravity to Claude)${c.reset}`], 56);
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
    console.log(`  ${c.cyan}└─${c.reset} Dashboard: ${c.underline}http://localhost:${port}/${c.reset}\n`);
    console.log(`  ${c.bold}AVAILABLE COMMANDS${c.reset}`);
    console.log(`  • ${c.cyan}atc ui${c.reset}         Open dashboard in browser`);
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

/**
 * Open WebUI in browser
 */
async function openUI() {
  if (!isServiceRunning()) {
    console.log(`\n${c.bCyan}🌌 atc proxy offline - launching now...${c.reset}`);
    await startServer();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const port = getPort();
  const uiUrl = `http://localhost:${port}/`;

  console.log(`\n🖥️  Opening dashboard → ${c.underline}${uiUrl}${c.reset}\n`);

  const platform = process.platform;
  let openCommand = '';

  if (platform === 'win32') {
    openCommand = `start ${uiUrl}`;
  } else if (platform === 'darwin') {
    openCommand = `open ${uiUrl}`;
  } else if (platform === 'linux') {
    openCommand = `xdg-open ${uiUrl}`;
  } else {
    console.error(`${c.yellow}▲ Cannot auto-open browser on this platform${c.reset}`);
    console.log(`   Manual URL: ${uiUrl}\n`);
    return;
  }

  exec(openCommand, (error) => {
    if (error) {
      console.error(`${c.yellow}▲ Browser launch failed:${c.reset} ${error.message}`);
      console.log(`   Manual URL: ${uiUrl}\n`);
    }
  });
}

function showHelp() {
  console.log('');
  printBox([
    `  🛸 ${c.bold + c.bCyan}ATC — Antigravity to Claude ${c.bMagenta}v${packageJson.version}${c.reset}`
  ], 58);

  console.log(`
Route Claude Code CLI through Antigravity's multi-model API
with intelligent load balancing across Google accounts.

${c.bold + c.cyan}USAGE${c.reset}
  ${c.bCyan}atc${c.reset} <command> [options]

${c.bold + c.bCyan}━━━ LIFECYCLE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
  ${c.cyan}init, initialize${c.reset}    Configure atc for Claude Code & Windows startup
  ${c.cyan}reinit${c.reset}              Repair configuration & restart proxy daemon
  ${c.cyan}remove${c.reset}              Remove Windows startup integration
  ${c.cyan}start [--log]${c.reset}       Launch proxy daemon (background by default)
  ${c.cyan}stop${c.reset}                Shut down proxy daemon
  ${c.cyan}restart${c.reset}             Restart proxy daemon

${c.bold + c.bCyan}━━━ DASHBOARD & MANAGEMENT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
  ${c.cyan}atc, dash${c.reset}           Open interactive TUI dashboard (default)
  ${c.cyan}status${c.reset}              Show daemon health & active accounts overview
  ${c.cyan}ui${c.reset}                  Open WebUI dashboard in browser
  ${c.cyan}models${c.reset}              List available Claude/Gemini model mappings
  ${c.cyan}switch <id>${c.reset}         Switch active account by index (1-9) or email
  ${c.cyan}toggle <id>${c.reset}         Enable/disable account in round-robin pool

${c.bold + c.bCyan}━━━ OPTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
  ${c.yellow}-h, -H, --help${c.reset}      Show this help
  ${c.yellow}-v, --version${c.reset}       Show version
  ${c.yellow}--log${c.reset}               Run in foreground with live stream logs
  ${c.yellow}--strategy=NAME${c.reset}     Load balancer strategy: pipelined (default 5%),
                      hybrid (token-bucket), round-robin, sticky
  ${c.yellow}--fallback${c.reset}          Enable model fallback on errors
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
  printBox([`  ⚡ ${c.bold + c.bCyan}Initializing atc (Antigravity to Claude)${c.reset}`], 56);
  console.log('');

  const port = getPort();

  // Singleton guard: if already initialized and healthy, prevent redundant spawns
  if (isConfigInitialized()) {
    const isHealthy = await checkProxyHealth(port, 2000);
    if (isHealthy) {
      console.log(`${c.green}✓${c.reset} ${c.bold + c.bGreen}atc is already initialized and proxy is running healthy!${c.reset}`);
      console.log(`  • Proxy endpoint: ${c.underline}http://localhost:${port}${c.reset}`);
      console.log(`  • Dashboard:      ${c.underline}http://localhost:${port}/${c.reset}\n`);
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
  printBox([`  ♻️  ${c.bold + c.bCyan}Reinitializing atc Configuration${c.reset}`], 56);
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

async function removeCommand() {
  console.log('');
  printBox([`  🗑️  ${c.bold + c.bMagenta}Remove atc from Windows Startup / System${c.reset}`], 56);
  console.log('');

  let startupRemoved = false;
  if (process.platform === 'win32') {
    startupRemoved = removeWindowsStartup();
  }

  // Check if proxy daemon is currently running
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

  // Claude Code configuration cleanup
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

  // Transparent UX summary
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
  console.log(`${c.bold}atc has been removed from startup.${c.reset}\n`);
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

    case 'remove':
    case 'rm':
    case 'del':
    case 'delete':
      if (args[1]) {
        await removeAccount(args[1]);
      } else {
        await removeCommand();
      }
      break;

    case 'toggle':
      await toggleAccount(args[1]);
      break;

    case 'models':
      showModelMappings();
      break;

    case 'ui':
      await openUI();
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

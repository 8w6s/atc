/**
 * Antigravity Claude Proxy
 * Entry point - starts the proxy server
 */

// Initialize proxy support BEFORE any other imports that may use fetch
import './utils/proxy.js';

import app, { accountManager } from './server.js';
import { DEFAULT_PORT } from './constants.js';
import { logger } from './utils/logger.js';
import { config } from './config.js';
import { getStrategyLabel, STRATEGY_NAMES, DEFAULT_STRATEGY, isValidStrategy } from './account-manager/strategies/index.js';
import { getPackageVersion } from './utils/helpers.js';
import { renderDoubleBox } from './utils/terminal-box.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const packageVersion = getPackageVersion();

// Parse command line arguments
const args = process.argv.slice(2);
const isDebug = args.includes('--debug') || args.includes('--dev-mode') || process.env.DEBUG === 'true' || process.env.DEV_MODE === 'true';
const isFallbackEnabled = args.includes('--fallback') || process.env.FALLBACK === 'true';

// Parse --strategy flag (format: --strategy=sticky or --strategy sticky)
let strategyOverride = null;
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--strategy=')) {
        strategyOverride = args[i].split('=')[1];
    } else if (args[i] === '--strategy' && args[i + 1]) {
        strategyOverride = args[i + 1];
    }
}
// Validate strategy
if (strategyOverride && !isValidStrategy(strategyOverride, config.customModes || [])) {
    logger.warn(`[Startup] Invalid strategy "${strategyOverride}". Valid options: ${STRATEGY_NAMES.join(', ')} (or custom:<id>). Using default.`);
    strategyOverride = null;
}

// Initialize logger and devMode
logger.setDebug(isDebug);

if (isDebug) {
    config.devMode = true;
    config.debug = true;
    logger.debug('Developer mode enabled');
}

if (isFallbackEnabled) {
    logger.info('Model fallback mode enabled');
}

// Export fallback flag for server to use
export const FALLBACK_ENABLED = isFallbackEnabled;

/*
 * Namespace env overrides under ATC_PORT / ATC_HOST so ambient PORT or HOST
 * variables exported by unrelated dev environments or IDE shells cannot hijack
 * the proxy port or expose loopback endpoints to LAN.
 */
const PORT = parseInt(process.env.ATC_PORT, 10) || config?.port || DEFAULT_PORT;
const HOST = process.env.ATC_HOST || config?.bindHost || '127.0.0.1';

if (process.env.ATC_HOST) {
    logger.info(`[Startup] Using ATC_HOST environment variable: ${process.env.ATC_HOST}`);
}

// Home directory for account storage
const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.config', 'atc');
const LOCK_FILE = path.join(CONFIG_DIR, 'daemon.lock');
const PID_FILE = path.join(CONFIG_DIR, 'server.pid');

function acquireLock() {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(LOCK_FILE, process.pid.toString(), 'utf-8');
        fs.writeFileSync(PID_FILE, process.pid.toString(), 'utf-8');
    } catch {}
}

function releaseLock() {
    try {
        for (const f of [LOCK_FILE, PID_FILE]) {
            if (fs.existsSync(f)) {
                const cur = fs.readFileSync(f, 'utf-8');
                if (parseInt(cur, 10) === process.pid) {
                    fs.unlinkSync(f);
                }
            }
        }
    } catch {}
}

const server = app.listen(PORT, HOST, () => {
    acquireLock();
    // Get actual bound address
    const address = server.address();
    const boundHost = typeof address === 'string' ? address : address.address;
    const boundPort = typeof address === 'string' ? null : address.port;

    // Clear console for a clean start only if running in an interactive terminal
    if (process.stdout.isTTY) {
        console.clear();
    }

    const strategyLabel = accountManager.getStrategyLabel();
    const strategyLineA = `(${STRATEGY_NAMES.slice(0, 4).join('/')}`;
    const strategyLineB = `/${STRATEGY_NAMES.slice(4, 8).join('/')}`;
    const strategyLineC = `/${STRATEGY_NAMES.slice(8).join('/')}/custom:<id>)`;

    const bodyRows = [
        '',
        `  atc proxy daemon running at: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
        `  Bound to: ${boundHost}:${boundPort}`,
        '',
        '  Active Modes:',
        `    * Strategy: ${strategyLabel}`
    ];
    if (isDebug) bodyRows.push('    * Developer mode enabled');
    if (isFallbackEnabled) bodyRows.push('    * Model fallback enabled');
    if (process.env.CLAUDE_CONFIG_PATH) bodyRows.push(`    * Claude config: ${process.env.CLAUDE_CONFIG_PATH}`);

    bodyRows.push(
        '',
        '  Control:',
        '    --strategy=<s>     Set account selection strategy',
        `                       ${strategyLineA}`,
        `                       ${strategyLineB}`,
        `                       ${strategyLineC}`
    );
    if (!isDebug) bodyRows.push('    --dev-mode         Enable developer mode');
    if (!isFallbackEnabled) bodyRows.push('    --fallback         Enable model fallback on quota exhaust');
    bodyRows.push(
        '    Ctrl+C             Stop server',
        '',
        '  Endpoints:',
        '    POST /v1/messages         - Anthropic Messages API',
        '    POST /v1/messages/count_tokens - Token count estimator',
        '    GET  /v1/models           - List available models',
        '    GET  /health              - Cached health & pool status',
        '    GET  /account-limits      - Account status & quotas',
        '    POST /refresh-token       - Force token refresh',
        '',
        '  Configuration:',
        `    Storage: ${CONFIG_DIR}`,
        '',
        '  Usage with Claude Code:',
        `    export ANTHROPIC_BASE_URL=http://localhost:${PORT}`,
        `    export ANTHROPIC_API_KEY=${config.apiKey || 'atc-local-key'}`,
        '    claude',
        '',
        '  Environment Variables:',
        '    ATC_PORT            Server port (default: 43128)',
        '    ATC_HOST            Bind address (default: 127.0.0.1)',
        '    HTTP_PROXY          Route requests through a proxy',
        '    CLAUDE_CONFIG_PATH  Path to .claude dir (for systemd)'
    );

    const banner = renderDoubleBox(
        [
            [{ center: true, text: `atc (Antigravity to Claude) v${packageVersion}` }],
            bodyRows
        ],
        66
    );

    logger.log(`\n${banner}\n`);

    logger.success(`Server started successfully on port ${PORT}`);
    if (isDebug) {
        logger.warn('Running in DEVELOPER mode - verbose logs enabled');
    }
});

// Error handling (e.g. port already bound)
server.on('error', (err) => {
    releaseLock();
    if (err.code === 'EADDRINUSE') {
        logger.error(`[Singleton Guard] Port ${PORT} is already in use. Exiting to prevent duplicate daemon.`);
        process.exit(1);
    } else {
        logger.error(`Server error: ${err.message}`);
        process.exit(1);
    }
});

// Graceful shutdown
const shutdown = () => {
    logger.info('Shutting down server...');
    releaseLock();
    server.close(() => {
        logger.success('Server stopped');
        process.exit(0);
    });

    // Force close if it takes too long
    setTimeout(() => {
        releaseLock();
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

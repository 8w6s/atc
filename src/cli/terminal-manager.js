import readline from 'readline';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { spawn } from 'child_process';
import { ACCOUNT_CONFIG_PATH, DEFAULT_PORT } from '../constants.js';
import {
    getAuthorizationUrl,
    startCallbackServer,
    completeOAuthFlow,
    refreshAccessToken,
    getUserEmail,
    extractCodeFromInput
} from '../auth/oauth.js';
import { loadAccounts, saveAccounts } from '../account-manager/storage.js';
import { getTokenForAccount, getProjectForAccount } from '../account-manager/credentials.js';
import { fetchAvailableModels } from '../cloudcode/model-api.js';
import { sleep } from '../utils/helpers.js';
import { config } from '../config.js';

const CONFIG_DIR = dirname(ACCOUNT_CONFIG_PATH);
const PID_FILE = join(CONFIG_DIR, 'server.pid');

// ANSI Terminal Colors
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    brightGreen: '\x1b[92m',
    brightYellow: '\x1b[93m',
    brightCyan: '\x1b[96m',
    brightRed: '\x1b[91m'
};

/**
 * Read current proxy port from config or environment
 */
export function getProxyPort() {
    if (process.env.PORT) {
        return parseInt(process.env.PORT, 10);
    }
    const configPath = join(CONFIG_DIR, 'config.json');
    if (existsSync(configPath)) {
        try {
            const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
            if (raw.port) return parseInt(raw.port, 10);
        } catch {
            // fallback below
        }
    }
    return DEFAULT_PORT || 43128;
}

/**
 * Check if the background proxy service is active
 */
export function getServicePid() {
    if (!existsSync(PID_FILE)) return null;
    try {
        const pid = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);
        if (isNaN(pid)) return null;
        process.kill(pid, 0);
        return pid;
    } catch {
        return null;
    }
}

/**
 * Calculate human-readable duration
 */
function formatDuration(ms) {
    if (ms <= 0 || isNaN(ms)) return '0s';
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hrs = Math.floor(min / 60);
    const days = Math.floor(hrs / 24);

    if (days > 0) return `${days}d ${hrs % 24}h`;
    if (hrs > 0) return `${hrs}h ${min % 60}m`;
    if (min > 0) return `${min}m ${sec % 60}s`;
    return `${sec}s`;
}

/**
 * Calculate relative time string
 */
function formatTimeAgo(isoString) {
    if (!isoString) return 'never';
    const diff = Date.now() - new Date(isoString).getTime();
    if (diff < 0) return 'just now';
    return `${formatDuration(diff)} ago`;
}

/**
 * Format reset target time
 */
function formatResetTime(isoString) {
    if (!isoString) return `${c.gray}unknown${c.reset}`;
    const diff = new Date(isoString).getTime() - Date.now();
    if (diff <= 0) return `${c.green}now${c.reset}`;
    return `${c.brightYellow}in ${formatDuration(diff)}${c.reset} ${c.gray}(${isoString})${c.reset}`;
}

/**
 * Colorize percentage values
 */
function formatPercentage(str, fraction) {
    if (typeof fraction === 'number') {
        if (fraction >= 0.5) return `${c.green}${str}${c.reset}`;
        if (fraction >= 0.2) return `${c.yellow}${str}${c.reset}`;
        return `${c.red}${str}${c.reset}`;
    }
    return `${c.green}${str}${c.reset}`;
}

/**
 * Notify running proxy to reload accounts from disk
 */
async function notifyProxyReload(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/accounts/reload`, {
            method: 'POST',
            signal: AbortSignal.timeout(2000)
        });
        if (res.ok) {
            return true;
        }
    } catch {
        // proxy might be offline
    }
    return false;
}

/**
 * Open URL in system default browser
 */
function openBrowser(url) {
    const p = process.platform;
    let cmd = p === 'win32' ? 'cmd' : p === 'darwin' ? 'open' : 'xdg-open';
    let args = p === 'win32' ? ['/c', 'start', '', url.replace(/&/g, '^&')] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
}

/**
 * Display account status list formatted like terminal multi-auth
 */
export async function showAccountStatus() {
    const port = getProxyPort();
    const pid = getServicePid();
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);

    let proxyData = null;
    let pingLatency = null;

    // Direct HTTP ping to health endpoint
    const start = Date.now();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
            proxyData = await res.json();
            pingLatency = Date.now() - start;
        }
    } catch {
        // offline
    }

    console.log(`\n${c.bold}${c.brightCyan}atc${c.reset} ${c.gray}(Antigravity to Claude)${c.reset}`);
    console.log(`${c.bold}Accounts (${accounts.length})${c.reset}`);
    console.log(`${c.gray}Storage:${c.reset} ${ACCOUNT_CONFIG_PATH}`);
    if (proxyData) {
        const pidStr = pid ? `, pid: ${pid}` : '';
        console.log(`Proxy:   http://127.0.0.1:${port} [${c.brightGreen}active${c.reset}${pidStr}, latency: ${c.cyan}${pingLatency}ms${c.reset}]`);
        if (proxyData.summary) {
            // Colorize summary keywords
            const coloredSummary = proxyData.summary
                .replace(/(\d+ total)/, `${c.bold}$1${c.reset}`)
                .replace(/(\d+ available)/, `${c.green}$1${c.reset}`)
                .replace(/(\d+ rate-limited)/, (m) => m.startsWith('0') ? `${c.gray}${m}${c.reset}` : `${c.yellow}${m}${c.reset}`)
                .replace(/(\d+ invalid)/, (m) => m.startsWith('0') ? `${c.gray}${m}${c.reset}` : `${c.red}${m}${c.reset}`);
            console.log(`Summary: ${coloredSummary}`);
        }
    } else {
        console.log(`Proxy:   http://127.0.0.1:${port} [${c.red}offline${c.reset}]`);
    }

    if (accounts.length === 0) {
        console.log(`\n${c.yellow}No accounts configured. Run "atc login" to link a Google account.${c.reset}\n`);
        return;
    }

    // Map live health info if proxy responded
    const liveAccountsMap = new Map();
    if (proxyData && Array.isArray(proxyData.accounts)) {
        for (const la of proxyData.accounts) {
            liveAccountsMap.set(la.email, la);
        }
    }

    let bestCandidate = null;
    let bestScore = -1;

    console.log('');
    accounts.forEach((acc, i) => {
        const isCurrent = i === activeIndex;
        const live = liveAccountsMap.get(acc.email) || {};
        const isInvalid = acc.isInvalid || live.status === 'invalid';
        const isLimited = Object.values(acc.modelRateLimits || {}).some(
            l => l.isRateLimited && l.resetTime > Date.now()
        ) || (live.rateLimitCooldownRemaining > 0);

        let stateTags = [];
        if (isCurrent) stateTags.push(`${c.bold}${c.brightGreen}current${c.reset}`);
        if (!acc.enabled) stateTags.push(`${c.gray}disabled${c.reset}`);
        else if (isInvalid) stateTags.push(`${c.bold}${c.brightRed}invalid${c.reset}`);
        else if (isLimited) stateTags.push(`${c.yellow}rate-limited${c.reset}`);
        else stateTags.push(`${c.green}ready${c.reset}`);

        const tagStr = `[${stateTags.join(', ')}]`;
        const lastUsedStr = formatTimeAgo(acc.lastUsed);

        const planTier = (acc.subscription?.tier || 'free').toLowerCase();
        let planColor = c.gray;
        if (planTier === 'ultra') planColor = c.brightYellow;
        else if (planTier === 'pro' || planTier === 'standard') planColor = c.brightCyan;
        else if (planTier === 'plus') planColor = c.brightGreen;
        const planStr = `${planColor}[${planTier}]${c.reset}`;

        console.log(`${c.bold}${c.cyan}${i + 1}.${c.reset} Account ${i + 1} (${c.bold}${acc.email}${c.reset}) ${planStr} ${tagStr} ${c.gray}last used ${lastUsedStr}${c.reset}`);

        // Health and quota details (fallback to stored quota if live stats unavailable)
        const models = (live.models && Object.keys(live.models).length > 0) ? live.models : (acc.quota?.models || {});
        const modelKeys = Object.keys(models);

        let fiveHour = null;
        let weekly = null;

        if (modelKeys.length > 0) {
            const now = Date.now();
            for (const [mId, mInfo] of Object.entries(models)) {
                if (!mInfo || typeof mInfo.remainingFraction !== 'number') continue;
                const rMs = mInfo.resetTime ? Math.max(0, new Date(mInfo.resetTime).getTime() - now) : 0;
                const isWeekly = rMs > 24 * 3600 * 1000 || mId.toLowerCase().includes('argon') || mId.toLowerCase().includes('weekly');
                if (isWeekly) {
                    if (!weekly || mInfo.remainingFraction < weekly.remainingFraction) {
                        weekly = { ...mInfo, modelId: mId, resetMs: rMs };
                    }
                } else {
                    if (!fiveHour || mId.includes('flash-high') || mInfo.remainingFraction < fiveHour.remainingFraction) {
                        fiveHour = { ...mInfo, modelId: mId, resetMs: rMs };
                    }
                }
            }

            const fiveStr = fiveHour
                ? `${formatPercentage(`${Math.round(fiveHour.remainingFraction * 100)}%`, fiveHour.remainingFraction)} ${fiveHour.resetMs > 0 ? c.gray + '(resets in ' + formatDuration(fiveHour.resetMs) + ')' + c.reset : ''}`
                : `${c.gray}ready${c.reset}`;

            const weekStr = weekly
                ? (weekly.remainingFraction === 0
                    ? `${c.bold}${c.red}0% [EXHAUSTED - resets in ${formatDuration(weekly.resetMs)}]${c.reset}`
                    : `${formatPercentage(`${Math.round(weekly.remainingFraction * 100)}%`, weekly.remainingFraction)} ${c.gray}(resets in ${formatDuration(weekly.resetMs)})${c.reset}`)
                : `${c.gray}100% (unrestricted)${c.reset}`;

            console.log(`   ${c.gray}quota 5h:${c.reset} ${fiveStr}  ${c.gray}weekly:${c.reset} ${weekStr}`);
        } else if (acc.isInvalid) {
            console.log(`   ${c.red}status: invalid (${acc.invalidReason || 'verification needed'})${c.reset}`);
        } else {
            console.log(`   ${c.gray}quota: live stats not cached; run "atc check" to probe${c.reset}`);
        }

        // Forecast score calculation
        if (acc.enabled && !isInvalid && !isLimited) {
            let score = 50;
            if (fiveHour && typeof fiveHour.remainingFraction === 'number') {
                score += Math.round(fiveHour.remainingFraction * 40);
            }
            if (weekly) {
                if (weekly.remainingFraction === 0) {
                    score = Math.max(5, score - 60); // Severely penalize weekly exhaustion
                } else {
                    score += Math.round(weekly.remainingFraction * 10);
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = { index: i + 1, email: acc.email, score };
            }
        }
    });

    console.log('');
    if (bestCandidate) {
        console.log(`${c.bold}Forecast suggestion:${c.reset} ${c.brightCyan}Account ${bestCandidate.index} (${bestCandidate.email})${c.reset} [${c.green}readiness score ${bestCandidate.score}/100${c.reset}].`);
    }
    console.log(`${c.bold}Current active account:${c.reset} ${c.brightGreen}Account ${activeIndex + 1} (${accounts[activeIndex]?.email || 'none'})${c.reset}\n`);
}

/**
 * Switch active account by 1-based index or email pattern
 */
export async function switchAccount(target) {
    if (!target) {
        console.error(`${c.red}Usage:${c.reset} atc switch <number | email>`);
        process.exit(1);
    }

    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    if (accounts.length === 0) {
        console.error(`${c.red}Error:${c.reset} No accounts configured in proxy.`);
        process.exit(1);
    }

    let targetIndex = -1;
    const num = parseInt(target, 10);

    if (!isNaN(num) && num >= 1 && num <= accounts.length) {
        targetIndex = num - 1;
    } else {
        const lower = target.toLowerCase();
        targetIndex = accounts.findIndex(a => a.email.toLowerCase().includes(lower));
    }

    if (targetIndex === -1) {
        console.error(`${c.red}Error:${c.reset} Could not find account matching "${target}".`);
        console.log(`Available accounts: 1 to ${accounts.length}`);
        process.exit(1);
    }

    const targetAccount = accounts[targetIndex];
    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, targetIndex);

    const port = getProxyPort();
    const pid = getServicePid();
    let reloaded = false;

    if (pid || true) {
        reloaded = await notifyProxyReload(port);
    }

    console.log(`\n${c.green}✓${c.reset} Switched active account to: [${targetIndex + 1}] ${c.bold}${targetAccount.email}${c.reset}`);
    if (reloaded) {
        console.log(`  ${c.gray}Proxy daemon notified (hot-reloaded on port ${port}).${c.reset}\n`);
    } else if (pid) {
        console.log(`  ${c.gray}Proxy is running on port ${port}. Changes saved to disk.${c.reset}\n`);
    } else {
        console.log(`  ${c.yellow}Proxy is currently offline. Selection saved to disk.${c.reset}\n`);
    }
}

/**
 * Check and refresh all account credentials
 */
export async function checkAccounts() {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    if (accounts.length === 0) {
        console.log(`${c.yellow}No accounts configured to check.${c.reset}`);
        return;
    }

    console.log(`\n${c.bold}Probing ${accounts.length} account credential(s)...${c.reset}\n`);

    let probedCount = 0;

    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        process.stdout.write(`  [${i + 1}/${accounts.length}] ${c.bold}${acc.email}${c.reset} ... `);

        if (!acc.refreshToken) {
            console.log(`${c.gray}SKIPPED (no refresh token)${c.reset}`);
            continue;
        }

        const reasonLower = (acc.invalidReason || '').toLowerCase();
        if (acc.isInvalid && (
            reasonLower.includes('tos') ||
            reasonLower.includes('banned') ||
            reasonLower.includes('suspended') ||
            reasonLower.includes('terms of service')
        )) {
            console.log(`${c.red}SKIPPED (ToS restricted — refresh locked)${c.reset}`);
            continue;
        }

        if (probedCount > 0) {
            await sleep(350 + Math.floor(Math.random() * 350));
        }
        probedCount++;

        try {
            const tokens = await refreshAccessToken(acc.refreshToken);
            const email = await getUserEmail(tokens.accessToken);
            acc.isInvalid = false;
            acc.invalidReason = null;
            console.log(`${c.green}OK${c.reset} ${c.gray}(authenticated as ${email})${c.reset}`);
        } catch (err) {
            acc.isInvalid = true;
            acc.invalidReason = err.message;
            console.log(`${c.red}FAILED (${err.message})${c.reset}`);
        }
    }

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

    const port = getProxyPort();
    await notifyProxyReload(port);

    console.log(`\n${c.green}✓${c.reset} Probe completed. Run "atc status" to view updated account pool.\n`);
}

/**
 * Add account via OAuth without stopping the server
 */
export async function loginAccount(options = {}) {
    const noBrowser = !!options.noBrowser;
    const targetEmail = options.targetEmail || null;
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);

    if (targetEmail) {
        console.log(`\n${c.bold}${c.brightCyan}=== Re-authenticating: ${targetEmail} ===${c.reset}\n`);
        console.log(`Please select or log in to ${c.bold}${targetEmail}${c.reset} in the browser.\n`);
    } else {
        console.log(`\n${c.bold}${c.brightCyan}=== Antigravity Account Login ===${c.reset}\n`);
    }

    const { url, verifier, state } = getAuthorizationUrl();

    if (noBrowser) {
        console.log('Open this URL in a browser on any machine:\n');
        console.log(`   ${c.cyan}${url}${c.reset}\n`);
        console.log('After sign-in, copy the redirect URL or authorization code.\n');

        const rl = createInterface({ input: stdin, output: stdout });
        const input = await rl.question('Paste callback URL or code: ');
        rl.close();

        try {
            const { code } = extractCodeFromInput(input);
            console.log('\nExchanging authorization code...');
            const result = await completeOAuthFlow(code, verifier);
            await recordNewAccount(result, accounts, settings, activeIndex);
        } catch (err) {
            console.error(`\n${c.red}✗ Authentication failed: ${err.message}${c.reset}\n`);
        }
        return;
    }

    console.log('Opening browser for Google authorization...');
    console.log(`(Manual link if browser does not open: ${c.cyan}${url}${c.reset})\n`);
    openBrowser(url);

    const loginTimeoutSec = config?.loginTimeoutSec || 120;
    const timeoutMs = loginTimeoutSec * 1000;
    const timeoutDesc = loginTimeoutSec >= 60 && loginTimeoutSec % 60 === 0
        ? `${loginTimeoutSec / 60}m`
        : `${loginTimeoutSec}s`;

    console.log(`Listening for OAuth callback on localhost (timeout ${timeoutDesc})...`);
    console.log(`${c.dim}Press ESC or Q to cancel and return to Dashboard immediately...${c.reset}\n`);

    const { promise, abort } = startCallbackServer(state, timeoutMs);

    let keyListener = null;
    let isCancelled = false;

    const cancelPromise = new Promise((_, reject) => {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            readline.emitKeypressEvents(process.stdin);
            keyListener = (str, key) => {
                if (key && (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c'))) {
                    isCancelled = true;
                    abort();
                    reject(new Error('Login cancelled by user (ESC pressed)'));
                }
            };
            process.stdin.on('keypress', keyListener);
        }
    });

    try {
        const code = await Promise.race([promise, cancelPromise]);
        console.log('Authorization received. Exchanging for tokens...');
        const result = await completeOAuthFlow(code, verifier);
        await recordNewAccount(result, accounts, settings, activeIndex);
    } catch (err) {
        if (isCancelled || err.message.includes('cancelled') || err.message.includes('abort')) {
            console.log(`\n${c.yellow}⚠ Add Account cancelled by user.${c.reset}`);
        } else {
            console.error(`\n${c.red}✗ OAuth sign-in error: ${err.message}${c.reset}\n`);
        }
    } finally {
        if (keyListener) {
            process.stdin.removeListener('keypress', keyListener);
        }
    }
}

/**
 * Save new or updated account and hot-reload proxy
 */
async function recordNewAccount(result, accounts, settings, activeIndex) {
    const existingIndex = accounts.findIndex(a => a.email.toLowerCase() === result.email.toLowerCase());

    if (existingIndex !== -1) {
        accounts[existingIndex].refreshToken = result.refreshToken;
        accounts[existingIndex].isInvalid = false;
        accounts[existingIndex].invalidReason = null;
        accounts[existingIndex].verifyUrl = null;
        accounts[existingIndex].enabled = true;
        accounts[existingIndex].addedAt = new Date().toISOString();
        console.log(`\n${c.green}✓${c.reset} Refreshed credentials for existing account: ${c.bold}${result.email}${c.reset}`);
    } else {
        accounts.push({
            email: result.email,
            source: 'oauth',
            refreshToken: result.refreshToken,
            addedAt: new Date().toISOString(),
            enabled: true,
            isInvalid: false,
            invalidReason: null,
            modelRateLimits: {}
        });
        console.log(`\n${c.green}✓${c.reset} Successfully linked account: ${c.bold}${result.email}${c.reset}`);
    }

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

    const port = getProxyPort();
    const reloaded = await notifyProxyReload(port);
    if (reloaded) {
        console.log(`  ${c.gray}Hot-reloaded proxy pool on port ${port}.${c.reset}\n`);
    } else {
        console.log(`  ${c.gray}Accounts saved to disk.${c.reset}\n`);
    }
}

/**
 * Remove an account by index or email
 */
export async function removeAccount(target) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    if (accounts.length === 0) {
        console.log(`${c.yellow}No accounts configured to remove.${c.reset}`);
        return;
    }

    let idx = -1;
    const num = parseInt(target, 10);
    if (!isNaN(num) && num >= 1 && num <= accounts.length) {
        idx = num - 1;
    } else if (target) {
        idx = accounts.findIndex(a => a.email.toLowerCase().includes(target.toLowerCase()));
    }

    if (idx === -1) {
        console.error(`${c.red}Error:${c.reset} Could not find account matching "${target}".`);
        return;
    }

    const removed = accounts.splice(idx, 1)[0];
    const newActiveIndex = activeIndex >= accounts.length ? Math.max(0, accounts.length - 1) : activeIndex;

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, newActiveIndex);

    const port = getProxyPort();
    await notifyProxyReload(port);

    console.log(`\n${c.green}✓${c.reset} Unlinked account: ${c.bold}${removed.email}${c.reset} (${accounts.length} remaining)\n`);
}

/**
 * Toggle enable/disable status for an account
 */
export async function toggleAccount(target) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    if (accounts.length === 0) {
        console.log(`${c.yellow}No accounts configured.${c.reset}`);
        return;
    }

    let idx = -1;
    const num = parseInt(target, 10);
    if (!isNaN(num) && num >= 1 && num <= accounts.length) {
        idx = num - 1;
    } else if (target) {
        idx = accounts.findIndex(a => a.email.toLowerCase().includes(target.toLowerCase()));
    }

    if (idx === -1) {
        console.error(`${c.red}Error:${c.reset} Could not find account matching "${target}".`);
        return;
    }

    const acc = accounts[idx];
    acc.enabled = acc.enabled === false ? true : false;

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

    const port = getProxyPort();
    await notifyProxyReload(port);

    const stateLabel = acc.enabled ? `${c.green}ENABLED${c.reset}` : `${c.yellow}DISABLED${c.reset}`;
    console.log(`\n${c.green}✓${c.reset} Account [${idx + 1}] ${c.bold}${acc.email}${c.reset} is now ${stateLabel}.\n`);
}

/**
 * Show active model mapping table
 */
export function showModelMappings() {
    const configPath = join(CONFIG_DIR, 'config.json');
    let mapping = {};
    if (existsSync(configPath)) {
        try {
            const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
            mapping = raw.modelMapping || {};
        } catch {}
    }

    console.log(`\n${c.bold}Claude CLI Alias → Backend Model Mappings:${c.reset}`);
    console.log(`${c.gray}${'─'.repeat(60)}${c.reset}`);
    const entries = Object.entries(mapping);
    if (entries.length === 0) {
        console.log('No custom mappings defined in config.json.');
        return;
    }

    for (const [alias, target] of entries) {
        const dest = typeof target === 'string' ? target : (target.mapping || JSON.stringify(target));
        console.log(`  ${c.cyan}${alias.padEnd(28)}${c.reset} ${c.gray}→${c.reset} ${c.brightGreen}${dest}${c.reset}`);
    }
    console.log(`${c.gray}${'─'.repeat(60)}${c.reset}`);
    console.log(`Total: ${c.bold}${entries.length}${c.reset} model aliases configured.\n`);
}

/**
 * Open Google Security Verification URL in default browser
 */
export async function verifyAccount(account) {
    if (!account || !account.verifyUrl) {
        console.log(`\n${c.yellow}No Google Verification URL required for this account.${c.reset}\n`);
        return;
    }
    console.log(`\n${c.bold}${c.brightCyan}=== Google Security Verification: ${account.email} ===${c.reset}\n`);
    console.log(`Google requires completing a security check or accepting Terms for this account.`);
    console.log(`Opening verification link in your browser:\n`);
    console.log(`   ${c.cyan}${account.verifyUrl}${c.reset}\n`);
    openBrowser(account.verifyUrl);
    console.log(`After completing verification in the browser, press Enter to probe and restore account.`);
    const rl = createInterface({ input: stdin, output: stdout });
    await new Promise(r => rl.once('line', r));
    rl.close();

    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const idx = accounts.findIndex(a => a.email.toLowerCase() === account.email.toLowerCase());
    if (idx !== -1) {
        accounts[idx].isInvalid = false;
        accounts[idx].invalidReason = null;
        accounts[idx].verifyUrl = null;
        await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
    }
    const port = getProxyPort();
    await notifyProxyReload(port);
    console.log(`\n${c.green}✓${c.reset} Verification marked complete. Refreshing account status...\n`);
}

/**
 * Probe and display available Antigravity models from a specific account or highest tier Google account
 */
export async function showBackendModels(target = null, { refresh = false } = {}) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    if (!accounts || accounts.length === 0) {
        console.log(`\n${c.yellow}▲ No Google accounts configured in ATC pool.${c.reset}`);
        console.log(`  To inspect and use Antigravity models, please add an account first:`);
        console.log(`  ${c.brightCyan}atc add${c.reset}\n`);
        return;
    }

    let bestAcc = null;
    let accountDesc = '';

    if (target) {
        let targetIndex = -1;
        const num = parseInt(target, 10);
        if (!isNaN(num) && num >= 1 && num <= accounts.length) {
            targetIndex = num - 1;
        } else {
            const lower = target.toLowerCase();
            targetIndex = accounts.findIndex(a => a.email && a.email.toLowerCase().includes(lower));
        }

        if (targetIndex === -1) {
            console.error(`\n${c.red}Error:${c.reset} Could not find account matching "${target}". Run "${c.cyan}atc accounts${c.reset}" to view account list.\n`);
            return;
        }

        bestAcc = accounts[targetIndex];
        accountDesc = `Account #${targetIndex + 1}`;
    } else {
        // Rank accounts by subscription tier: ultra > pro/standard > plus > free > unknown
        const tierRanks = { ultra: 5, pro: 4, standard: 4, plus: 3, free: 2, unknown: 1 };
        const candidates = [...accounts].sort((a, b) => {
            const tierA = (a.subscription?.tier || 'free').toLowerCase();
            const tierB = (b.subscription?.tier || 'free').toLowerCase();
            const diff = (tierRanks[tierB] || 1) - (tierRanks[tierA] || 1);
            if (diff !== 0) return diff;
            if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
            if (a.isInvalid !== b.isInvalid) return a.isInvalid ? 1 : -1;
            return 0;
        });

        bestAcc = candidates[0];
        accountDesc = 'Highest plan account in pool';
    }

    const bestTier = (bestAcc.subscription?.tier || 'unknown').toUpperCase();

    console.log(`\n${c.bold + c.brightCyan}atc${c.reset} ${c.gray}(Antigravity to Claude)${c.reset} — ${c.bold}Backend Model Catalog${c.reset}`);
    console.log(`${c.gray}Probing via:${c.reset} ${c.bold}${bestAcc.email}${c.reset} [${c.brightYellow}${bestTier}${c.reset}] (${accountDesc})`);
    console.log(`${c.gray}Status:${c.reset} ${refresh ? 'Fetching fresh model catalog from Google...' : 'Connecting to Antigravity API...'}`);

    try {
        const token = await getTokenForAccount(bestAcc, new Map());
        const project = await getProjectForAccount(bestAcc, token, new Map());
        const raw = await fetchAvailableModels(token, project);
        const models = raw.models || {};
        const entries = Object.entries(models);

        if (entries.length === 0) {
            console.log(`\n${c.yellow}No models returned from Antigravity backend API.${c.reset}\n`);
            return;
        }

        // Cache quotas into account for instant dashboard display
        bestAcc.quota = bestAcc.quota || {};
        bestAcc.quota.models = bestAcc.quota.models || {};
        for (const [mId, mData] of entries) {
            if (mData.quotaInfo) {
                bestAcc.quota.models[mId] = {
                    remainingFraction: mData.quotaInfo.remainingFraction ?? (mData.quotaInfo.resetTime ? 0 : null),
                    resetTime: mData.quotaInfo.resetTime ?? null
                };
            }
        }
        bestAcc.quota.lastChecked = Date.now();
        await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

        console.log(`\n${c.bold}Model ID                         Display Name                      Capabilities          5h-Cap   Weekly${c.reset}`);
        console.log(`${c.gray}${'─'.repeat(97)}${c.reset}`);

        const now = Date.now();
        for (const [mId, mData] of entries) {
            const paddedId = mId.padEnd(32, ' ');
            const dispName = (mData.displayName || mId).slice(0, 32).padEnd(33, ' ');

            let caps = [];
            if (mData.supportsThinking) caps.push('think');
            if (mData.supportsImages || mData.supportsVideo) caps.push('vision');
            if (mData.recommended) caps.push('rec');
            const capStr = (caps.length > 0 ? `[${caps.join(',')}]` : '').padEnd(20, ' ');

            let fiveStr = ' 100% ';
            let weekStr = ' 100% ';

            if (mData.quotaInfo) {
                const frac = mData.quotaInfo.remainingFraction;
                const rTime = mData.quotaInfo.resetTime;
                const rMs = rTime ? Math.max(0, new Date(rTime).getTime() - now) : 0;
                const isWeekly = rMs > 24 * 3600 * 1000 || mId.includes('argon') || mId.includes('weekly');

                if (typeof frac === 'number') {
                    const pct = Math.round(frac * 100);
                    const pctPadded = `${pct}%`.padStart(5, ' ');
                    if (isWeekly) {
                        weekStr = pct === 0 ? `${c.red}0%${c.reset}    ` : `${pctPadded} `;
                    } else {
                        fiveStr = pct === 0 ? `${c.red}0%${c.reset}    ` : `${pctPadded} `;
                    }
                }
            }

            console.log(`  ${c.cyan}${paddedId}${c.reset}${dispName}${c.gray}${capStr}${c.reset}  ${c.brightGreen}${fiveStr}${c.reset}   ${c.brightGreen}${weekStr}${c.reset}`);
        }

        console.log(`${c.gray}${'─'.repeat(97)}${c.reset}`);
        console.log(`Total: ${c.bold}${entries.length}${c.reset} models active and accessible.\n`);
        console.log(`Manage models & shortcuts:`);
        console.log(`  • ${c.cyan}atc mapid${c.reset}        Show Claude Code fake model mappings`);
        console.log(`  • ${c.cyan}atc flex${c.reset}         Instantly map flagship Sonnet & Opus to Google infrastructure`);
        console.log(`  • ${c.cyan}atc${c.reset}              Open interactive dashboard\n`);

    } catch (err) {
        console.log(`\n${c.red}Failed to retrieve models from Antigravity API:${c.reset} ${err.message}`);
        console.log(`Try refreshing credentials with: ${c.cyan}atc check${c.reset} or ${c.cyan}atc add${c.reset}\n`);
    }
}

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

const CONFIG_DIR = dirname(ACCOUNT_CONFIG_PATH);
const PID_FILE = join(CONFIG_DIR, 'server.pid');

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
    if (!isoString) return 'unknown';
    const diff = new Date(isoString).getTime() - Date.now();
    if (diff <= 0) return 'now';
    return `in ${formatDuration(diff)} (${isoString})`;
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

    console.log('\natc (Antigravity to Claude)');
    console.log(`Accounts (${accounts.length})`);
    console.log(`Storage: ${ACCOUNT_CONFIG_PATH}`);
    if (proxyData) {
        const pidStr = pid ? `, pid: ${pid}` : '';
        console.log(`Proxy:   http://127.0.0.1:${port} [active${pidStr}, latency: ${pingLatency}ms]`);
        if (proxyData.summary) {
            console.log(`Summary: ${proxyData.summary}`);
        }
    } else {
        console.log(`Proxy:   http://127.0.0.1:${port} [offline]`);
    }

    if (accounts.length === 0) {
        console.log('\nNo accounts configured. Run "atc login" to link a Google account.\n');
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
        if (isCurrent) stateTags.push('current');
        if (!acc.enabled) stateTags.push('disabled');
        else if (isInvalid) stateTags.push('invalid');
        else if (isLimited) stateTags.push('rate-limited');
        else stateTags.push('ready');

        const tagStr = `[${stateTags.join(', ')}]`;
        const lastUsedStr = formatTimeAgo(acc.lastUsed);

        console.log(`${i + 1}. Account ${i + 1} (${acc.email}) ${tagStr} last used ${lastUsedStr}`);

        // Health and quota details
        const models = live.models || {};
        const modelKeys = Object.keys(models);

        if (modelKeys.length > 0) {
            const summaryParts = [];
            const keyModels = [
                'gemini-3.8-flash-high',
                'gemini-3.8-flash-medium',
                'gemini-3.1-flash-lite',
                'claude-sonnet-4-6'
            ];

            for (const km of keyModels) {
                if (models[km]) {
                    const label = km.replace('gemini-', '').replace('claude-', '');
                    summaryParts.push(`${label}: ${models[km].remaining} left`);
                }
            }

            if (summaryParts.length > 0) {
                console.log(`   quota: ${summaryParts.join(' · ')}`);
            }

            // Show reset time for primary flash model
            const primaryModel = models['gemini-3.8-flash-high'] || models['gemini-3.8-flash-medium'] || models[modelKeys[0]];
            if (primaryModel && primaryModel.resetTime) {
                console.log(`   resets: ${formatResetTime(primaryModel.resetTime)}`);
            }
        } else if (acc.isInvalid) {
            console.log(`   status: invalid (${acc.invalidReason || 'verification needed'})`);
        } else {
            console.log('   quota: live stats not cached; run "atc check" to probe');
        }

        // Forecast score calculation
        if (acc.enabled && !isInvalid && !isLimited) {
            let score = 50;
            const highModel = models['gemini-3.8-flash-high'];
            if (highModel && typeof highModel.remainingFraction === 'number') {
                score += Math.round(highModel.remainingFraction * 50);
            }
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = { index: i + 1, email: acc.email, score };
            }
        }
    });

    console.log('');
    if (bestCandidate) {
        console.log(`Forecast suggestion: Account ${bestCandidate.index} (${bestCandidate.email}) [readiness score ${bestCandidate.score}/100].`);
    }
    console.log(`Current active account: Account ${activeIndex + 1} (${accounts[activeIndex]?.email || 'none'})\n`);
}

/**
 * Switch active account by 1-based index or email pattern
 */
export async function switchAccount(target) {
    if (!target) {
        console.error('Usage: atc switch <number | email>');
        process.exit(1);
    }

    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    if (accounts.length === 0) {
        console.error('No accounts configured in proxy.');
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
        console.error(`Error: Could not find account matching "${target}".`);
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

    console.log(`\n✓ Switched active account to: [${targetIndex + 1}] ${targetAccount.email}`);
    if (reloaded) {
        console.log(`  Proxy daemon notified (hot-reloaded on port ${port}).\n`);
    } else if (pid) {
        console.log(`  Proxy is running on port ${port}. Changes saved to disk.\n`);
    } else {
        console.log('  Proxy is currently offline. Selection saved to disk.\n');
    }
}

/**
 * Check and refresh all account credentials
 */
export async function checkAccounts() {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    if (accounts.length === 0) {
        console.log('No accounts configured to check.');
        return;
    }

    console.log(`\nProbing ${accounts.length} account credential(s)...\n`);

    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        process.stdout.write(`  [${i + 1}/${accounts.length}] ${acc.email} ... `);

        if (!acc.refreshToken) {
            console.log('SKIPPED (no refresh token)');
            continue;
        }

        try {
            const tokens = await refreshAccessToken(acc.refreshToken);
            const email = await getUserEmail(tokens.accessToken);
            acc.isInvalid = false;
            acc.invalidReason = null;
            console.log(`OK (authenticated as ${email})`);
        } catch (err) {
            acc.isInvalid = true;
            acc.invalidReason = err.message;
            console.log(`FAILED (${err.message})`);
        }
    }

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

    const port = getProxyPort();
    await notifyProxyReload(port);

    console.log('\nProbe completed. Run "atc status" to view updated account pool.\n');
}

/**
 * Add account via OAuth without stopping the server
 */
export async function loginAccount(options = {}) {
    const noBrowser = !!options.noBrowser;
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);

    console.log('\n=== Antigravity Account Login ===\n');

    const { url, verifier, state } = getAuthorizationUrl();

    if (noBrowser) {
        console.log('Open this URL in a browser on any machine:\n');
        console.log(`   ${url}\n`);
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
            console.error(`\n✗ Authentication failed: ${err.message}\n`);
        }
        return;
    }

    console.log('Opening browser for Google authorization...');
    console.log(`(Manual link if browser does not open: ${url})\n`);
    openBrowser(url);

    console.log('Listening for OAuth callback on localhost (timeout 2m)...');
    try {
        const { promise } = startCallbackServer(state);
        const code = await promise;
        console.log('Authorization received. Exchanging for tokens...');
        const result = await completeOAuthFlow(code, verifier);
        await recordNewAccount(result, accounts, settings, activeIndex);
    } catch (err) {
        console.error(`\n✗ OAuth sign-in error: ${err.message}\n`);
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
        accounts[existingIndex].enabled = true;
        accounts[existingIndex].addedAt = new Date().toISOString();
        console.log(`\n✓ Refreshed credentials for existing account: ${result.email}`);
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
        console.log(`\n✓ Successfully linked account: ${result.email}`);
    }

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

    const port = getProxyPort();
    const reloaded = await notifyProxyReload(port);
    if (reloaded) {
        console.log(`  Hot-reloaded proxy pool on port ${port} (zero downtime).\n`);
    } else {
        console.log('  Accounts saved to disk.\n');
    }
}

/**
 * Remove an account by index or email
 */
export async function removeAccount(target) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    if (accounts.length === 0) {
        console.log('No accounts configured to remove.');
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
        console.error(`Error: Could not find account matching "${target}".`);
        return;
    }

    const removed = accounts.splice(idx, 1)[0];
    const newActiveIndex = activeIndex >= accounts.length ? Math.max(0, accounts.length - 1) : activeIndex;

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, newActiveIndex);

    const port = getProxyPort();
    await notifyProxyReload(port);

    console.log(`\n✓ Unlinked account: ${removed.email} (${accounts.length} remaining)\n`);
}

/**
 * Toggle enable/disable status for an account
 */
export async function toggleAccount(target) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    if (accounts.length === 0) {
        console.log('No accounts configured.');
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
        console.error(`Error: Could not find account matching "${target}".`);
        return;
    }

    const acc = accounts[idx];
    acc.enabled = acc.enabled === false ? true : false;

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

    const port = getProxyPort();
    await notifyProxyReload(port);

    console.log(`\n✓ Account [${idx + 1}] ${acc.email} is now ${acc.enabled ? 'ENABLED' : 'DISABLED'}.\n`);
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

    console.log('\nClaude CLI Alias → Backend Model Mappings:');
    console.log('─'.repeat(60));
    const entries = Object.entries(mapping);
    if (entries.length === 0) {
        console.log('No custom mappings defined in config.json.');
        return;
    }

    for (const [alias, target] of entries) {
        const dest = typeof target === 'string' ? target : (target.mapping || JSON.stringify(target));
        console.log(`  ${alias.padEnd(28)} → ${dest}`);
    }
    console.log('─'.repeat(60));
    console.log(`Total: ${entries.length} model aliases configured.\n`);
}

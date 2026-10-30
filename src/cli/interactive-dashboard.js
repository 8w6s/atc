import readline from 'readline';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { loadAccounts, saveAccounts } from '../account-manager/storage.js';
import { config, saveConfig } from '../config.js';
import {
    getProxyPort,
    getServicePid,
    loginAccount,
    checkAccounts,
    switchAccount,
    toggleAccount,
    removeAccount,
    showModelMappings,
    verifyAccount
} from './terminal-manager.js';

// Calibrated ANSI color palette for high contrast and readability on dark terminals
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',

    // Calibrated 256-color tones
    brandCyan: '\x1b[1;38;5;45m',     // Vivid sky cyan for primary title
    brandMint: '\x1b[38;5;49m',       // Soft mint for versioning
    brandGreen: '\x1b[38;5;48m',      // Emerald green for title / border
    actionGreen: '\x1b[38;5;42m',     // Soft readable green for actions
    activeBright: '\x1b[1;38;5;120m', // Highlighted text when selected
    cursorGreen: '\x1b[1;38;5;48m',   // Cursor arrow
    
    // Status tones
    statusOk: '\x1b[38;5;42m',        // [ok]
    statusCurrent: '\x1b[1;38;5;48m', // [current]
    statusWarn: '\x1b[38;5;214m',     // [rate-limited] warm amber
    statusDanger: '\x1b[38;5;196m',   // [invalid] crisp red
    statusMuted: '\x1b[38;5;244m',    // [disabled] slate gray
    
    // Google AI Plans (free < plus < pro < ultra)
    planUltra: '\x1b[1;38;5;220m',    // [ultra] bold gold
    planPro: '\x1b[1;38;5;141m',      // [pro] lavender purple
    planPlus: '\x1b[38;5;75m',        // [plus] sky cyan
    planFree: '\x1b[38;5;244m',       // [free] slate gray

    // Progress bar tones
    barFill: '\x1b[38;5;42m',         // ##########
    barEmpty: '\x1b[38;5;238m',       // ----------
    
    // UI neutrals
    textBright: '\x1b[38;5;254m',     // High-contrast off-white
    textNormal: '\x1b[38;5;250m',     // Normal body text
    textMuted: '\x1b[38;5;245m',      // Subtitle / hints
    textDark: '\x1b[38;5;240m',       // Dividers
    
    enterAltScreen: '\x1b[?1049h',
    exitAltScreen: '\x1b[?1049l',
    disableWrap: '\x1b[?7l',
    enableWrap: '\x1b[?7h',
    clearScreen: '\x1b[2J\x1b[H',
    cursorHome: '\x1b[H',
    clearToEndOfLine: '\x1b[K',
    clearToEndOfScreen: '\x1b[J',
    hideCursor: '\x1b[?25l',
    showCursor: '\x1b[?25h'
};

function formatDuration(ms) {
    if (ms <= 0 || isNaN(ms)) return '0s';
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hrs = Math.floor(min / 60);
    const days = Math.floor(hrs / 24);

    if (days > 0) return `${days}d`;
    if (hrs > 0) return `${hrs}h ${min % 60}m`;
    if (min > 0) return `${min}m`;
    return `${sec}s`;
}

function formatTimeAgo(isoString) {
    if (!isoString) return 'never';
    const diff = Date.now() - new Date(isoString).getTime();
    if (diff < 0) return 'just now';
    return `${formatDuration(diff)} ago`;
}

function formatPlanBadge(tier) {
    const t = (tier || 'unknown').toLowerCase();
    switch (t) {
        case 'ultra':
            return `${c.planUltra}[ultra]${c.reset}`;
        case 'pro':
            return `${c.planPro}[pro]${c.reset}`;
        case 'plus':
            return `${c.planPlus}[plus]${c.reset}`;
        case 'free':
            return `${c.planFree}[free]${c.reset}`;
        case 'standard':
            return `${c.planPro}[pro]${c.reset}`;
        default:
            return `${c.textMuted}[${t}]${c.reset}`;
    }
}

const STRATEGY_CYCLE = [
    { id: 'pipelined', label: 'Pipelined 5%', desc: 'Rotates every 5% quota to stagger 5h recovery windows in parallel' },
    { id: 'hybrid', label: 'Hybrid (Smart)', desc: 'Smart scoring combining health, token bucket, and quota' },
    { id: 'round-robin', label: 'Round-Robin', desc: 'Even rotation per-request across all available accounts' },
    { id: 'sticky', label: 'Sticky (Cache)', desc: 'Keeps using current account to maximize prompt caching' }
];


function getMappingTarget(mm, modelId) {
    if (!modelId) return 'none';
    const val = mm[modelId] || mm[modelId.toLowerCase()];
    if (!val) {
        if (modelId.includes('opus')) return getMappingTarget(mm, 'claude-opus-5-5') || 'gemini-3.8-flash-high';
        if (modelId.includes('sonnet')) return getMappingTarget(mm, 'claude-sonnet-5-5') || 'gemini-3.8-flash-high';
        if (modelId.includes('haiku')) return getMappingTarget(mm, 'claude-haiku-5-5') || 'gemini-3.1-flash-lite';
        return 'gemini-3.8-flash-high';
    }
    return typeof val === 'object' ? (val.mapping || 'unknown') : val;
}

function getClaudeSettingsPath() {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    return join(home, '.claude', 'settings.json');
}

function readClaudeSettings() {
    try {
        const p = getClaudeSettingsPath();
        if (existsSync(p)) {
            return JSON.parse(readFileSync(p, 'utf-8'));
        }
    } catch {
        // ignore
    }
    return { env: {} };
}

function writeClaudeSettings(settings) {
    try {
        const p = getClaudeSettingsPath();
        writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8');
        return true;
    } catch {
        return false;
    }
}


// Brand-accurate gradient color palette and shimmer animation
const TITLE_CHARS = [
    // Antigravity (11 chars + space): Bright Sky Blue 40% -> Green 20% -> Yellow 20% -> Red 20% (true linear gradient)
    { ch: 'A', r:  56, g: 189, b: 248 },
    { ch: 'n', r:  56, g: 189, b: 248 },
    { ch: 't', r:  56, g: 189, b: 248 },
    { ch: 'i', r:  56, g: 189, b: 248 },
    { ch: 'g', r:  56, g: 189, b: 248 },
    { ch: 'r', r:  45, g: 193, b: 171 },
    { ch: 'a', r:  34, g: 197, b:  94 },
    { ch: 'v', r: 142, g: 200, b:  58 },
    { ch: 'i', r: 250, g: 204, b:  21 },
    { ch: 't', r: 244, g: 136, b:  44 },
    { ch: 'y', r: 239, g:  68, b:  68 },
    { ch: ' ', r: 255, g: 255, b: 255 },

    // to (pure white)
    { ch: 't', r: 255, g: 255, b: 255 },
    { ch: 'o', r: 255, g: 255, b: 255 },
    { ch: ' ', r: 255, g: 255, b: 255 },

    // Claude Code (11 chars): Bright Orange 60% -> Warm Yellow 40% (true linear gradient)
    { ch: 'C', r: 249, g: 115, b:  22 },
    { ch: 'l', r: 249, g: 120, b:  28 },
    { ch: 'a', r: 250, g: 125, b:  35 },
    { ch: 'u', r: 250, g: 130, b:  41 },
    { ch: 'd', r: 250, g: 136, b:  47 },
    { ch: 'e', r: 251, g: 141, b:  54 },
    { ch: ' ', r: 251, g: 146, b:  60 },
    { ch: 'C', r: 251, g: 160, b:  50 },
    { ch: 'o', r: 250, g: 175, b:  40 },
    { ch: 'd', r: 250, g: 190, b:  31 },
    { ch: 'e', r: 250, g: 204, b:  21 }
];

function getShimmerTitle() {
    const cycleMs = 3000; // 3 seconds sweep period across the whole text
    const t = (Date.now() % cycleMs) / cycleMs;
    const total = TITLE_CHARS.length;
    const center = t * (total + 8) - 4; // smooth sweep from left into right

    let out = '\x1b[1m';
    for (let i = 0; i < total; i++) {
        const item = TITLE_CHARS[i];
        if (item.ch === ' ') {
            out += ' ';
            continue;
        }
        const dist = Math.abs(i - center);
        if (dist < 2.6) {
            const factor = Math.cos((dist / 2.6) * (Math.PI / 2));
            // Shimmer xám sáng ánh kim tinh tế (subtle silver-gray gleam)
            const silverR = 220, silverG = 226, silverB = 236;
            const r = Math.round(item.r + (silverR - item.r) * factor * 0.65);
            const g = Math.round(item.g + (silverG - item.g) * factor * 0.65);
            const b = Math.round(item.b + (silverB - item.b) * factor * 0.65);
            out += `\x1b[38;2;${r};${g};${b}m${item.ch}`;
        } else {
            out += `\x1b[38;2;${item.r};${item.g};${item.b}m${item.ch}`;
        }
    }
    out += '\x1b[0m';
    return out;
}

export async function runInteractiveDashboard() {
    let accountsData = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const port = getProxyPort();

    let proxyHealth = null;
    let proxyLimits = null;
    let statusMessage = '';
    let currentStrategy = config?.accountSelection?.strategy || 'pipelined';

    async function refreshData() {
        accountsData = await loadAccounts(ACCOUNT_CONFIG_PATH);
        try {
            const [healthRes, limitsRes] = await Promise.allSettled([
                fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) }),
                fetch(`http://127.0.0.1:${port}/account-limits`, { signal: AbortSignal.timeout(3000) })
            ]);

            if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
                proxyHealth = await healthRes.value.json();
            }
            if (limitsRes.status === 'fulfilled' && limitsRes.value.ok) {
                proxyLimits = await limitsRes.value.json();
            }
        } catch {
            proxyHealth = null;
            proxyLimits = null;
        }
    }

    await refreshData();

    function getItems() {
        const list = [];
        const stratObj = STRATEGY_CYCLE.find(s => s.id === currentStrategy) || STRATEGY_CYCLE[0];
        const customProject = config?.customProjectId || 'Default (auto)';

        list.push({ type: 'header', label: 'Quick Actions' });
        list.push({ type: 'action', id: 'add_account', label: 'Add New Account', desc: 'Link a new Google account via OAuth browser' });
        list.push({ type: 'action', id: 'lb_strategy', label: `Load Balancer: [${stratObj.label}]`, desc: stratObj.desc });
        list.push({ type: 'action', id: 'custom_project', label: `Custom GCP Project: [${customProject}]`, desc: 'Configure custom Google Cloud Project ID for quotas' });
        list.push({ type: 'action', id: 'model_mapping', label: 'Model Mappings', desc: 'Configure Claude Code models, subagents, and environment overrides' });
        list.push({ type: 'action', id: 'pick_best', label: 'Pick Best Account', desc: 'Automatically switch to healthiest account with highest quota' });
        list.push({ type: 'action', id: 'health_check', label: 'Run Health Check', desc: 'Inspect credentials, token validity, and proxy health' });

        list.push({ type: 'header', label: 'Advanced Checks' });
        list.push({ type: 'action', id: 'refresh_all', label: 'Refresh All Accounts', desc: 'Query Google API to update live quotas and tier info' });
        list.push({ type: 'action', id: 'check_problem', label: 'Check Problem Accounts', desc: 'Scan and review accounts needing re-login or verification' });

        list.push({ type: 'header', label: 'Saved Accounts' });
        const { accounts, activeIndex } = accountsData;
        accounts.forEach((acc, i) => {
            list.push({
                type: 'account',
                accountIndex: i,
                account: acc,
                isCurrent: i === activeIndex
            });
        });

        return list;
    }

    let items = getItems();
    let selectedIndex = items.findIndex(it => it.type === 'account' && it.isCurrent);
    if (selectedIndex === -1) selectedIndex = items.findIndex(it => it.type === 'account') || 1;
    if (selectedIndex === -1) selectedIndex = 1;

    // Enter alternate screen buffer, disable line wrap & hide cursor for 100% flicker-free isolated TUI
    process.stdout.write(c.enterAltScreen + c.disableWrap + c.hideCursor);

    let isSubScreenActive = false;

    // Fixed-height, 0% flicker render function
    function render() {
        if (isSubScreenActive) return;
        let buf = c.hideCursor + c.disableWrap + c.cursorHome;

        // Header Title
        buf += `${getShimmerTitle()} ${c.textMuted}(${c.brandMint}atc v1.0.0${c.textMuted})${c.reset}${c.clearToEndOfLine}\n`;

        const liveMap = new Map();
        if (proxyHealth && Array.isArray(proxyHealth.accounts)) {
            for (const a of proxyHealth.accounts) liveMap.set(a.email, a);
        }

        const limitsMap = new Map();
        if (proxyLimits && Array.isArray(proxyLimits.accounts)) {
            for (const a of proxyLimits.accounts) limitsMap.set(a.email, a);
        }

        let detailsLine = '';

        // Render main list (fixed item lines, no inline expanding rows)
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const isSelected = i === selectedIndex;

            if (it.type === 'header') {
                buf += `\x1b[1;38;5;110m${it.label}${c.reset}${c.clearToEndOfLine}\n`;
                if (it.label === 'Saved Accounts') {
                    buf += `    \x1b[38;5;241mAccount / Email                 Plan      Status      Active${c.reset}${c.clearToEndOfLine}\n`;
                }
                continue;
            }

            if (it.type === 'action') {
                let pointer = isSelected ? `\x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;
                let text = '';
                if (isSelected) {
                    text = `\x1b[1;38;5;255m${it.label}${c.reset}`;
                } else {
                    // Stylize label with balanced, elegant colors
                    if (it.label.includes(': [')) {
                        const parts = it.label.split(': [');
                        const prefix = parts[0];
                        const val = parts[1].replace(']', '');
                        text = `\x1b[38;5;250m${prefix}:\x1b[0m \x1b[38;5;147m[${val}]\x1b[0m`;
                    } else {
                        text = `\x1b[38;5;252m${it.label}${c.reset}`;
                    }
                }

                buf += `${pointer}${text}${c.clearToEndOfLine}\n`;
                if (isSelected) {
                    detailsLine = `${c.textMuted}Action:${c.reset} ${it.desc || it.label}`;
                }
                continue;
            }

            if (it.type === 'account') {
                const acc = it.account;
                const idx = it.accountIndex + 1;
                const live = liveMap.get(acc.email) || {};
                const lim = limitsMap.get(acc.email) || {};

                const isInvalid = acc.isInvalid || live.status === 'invalid';
                const hasVerifyUrl = !!acc.verifyUrl;
                const isLimited = Object.values(acc.modelRateLimits || {}).some(
                    l => l.isRateLimited && l.resetTime > Date.now()
                ) || (live.rateLimitCooldownRemaining > 0);

                // Column 1: Account / Email padded to 32 chars
                const rawEmail = `${idx}. ${acc.email}`;
                const paddedEmail = rawEmail.padEnd(32, ' ');
                const emailStr = isSelected
                    ? `${c.activeBright}${paddedEmail}${c.reset}`
                    : `${c.textNormal}${paddedEmail}${c.reset}`;

                // Column 2: Plan Badge padded to 10 chars
                const planTier = lim.subscription?.tier || acc.subscription?.tier || 'unknown';
                const planBadgeRawLen = planTier.length + 2; // e.g. [pro] is 5
                const planPad = ' '.repeat(Math.max(1, 10 - planBadgeRawLen));
                const planStr = formatPlanBadge(planTier) + planPad;

                // Column 3: Status Badge (strictly 12-char width)
                let statusLabel = '[ok]';
                let statusColor = c.statusOk;
                if (!acc.enabled) {
                    statusLabel = '[disabled]';
                    statusColor = c.statusMuted;
                } else if (hasVerifyUrl) {
                    statusLabel = '[verify-req]';
                    statusColor = c.statusDanger;
                } else if (isInvalid) {
                    statusLabel = '[invalid]';
                    statusColor = c.statusDanger;
                } else if (isLimited) {
                    statusLabel = '[rate-limit]';
                    statusColor = c.statusWarn;
                }
                const statusPad = ' '.repeat(Math.max(1, 12 - statusLabel.length));
                const statusStr = `${statusColor}${statusLabel}${c.reset}${statusPad}`;

                // Column 4: Role / Active tag on the outside (nằm ngoài cùng)
                const currentBadge = it.isCurrent ? ` ${c.statusCurrent}[current]${c.reset}` : '';

                let pointer = isSelected ? `\x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;
                buf += `${pointer}${emailStr} ${planStr} ${statusStr}${currentBadge}${c.clearToEndOfLine}\n`;

                if (isSelected) {
                    const models = live.models || lim.models || {};
                    const primary = models['gemini-3.8-flash-high'] || models['gemini-3.8-flash-medium'] || Object.values(models)[0] || {};
                    const frac = typeof primary.remainingFraction === 'number' ? primary.remainingFraction : 1.0;
                    const remainingPct = Math.round(frac * 100);
                    const usedPct = 100 - remainingPct;
                    const timeAgo = formatTimeAgo(acc.lastUsed);

                    let usageColor = c.statusOk;
                    if (usedPct >= 80) usageColor = c.statusDanger;
                    else if (usedPct >= 50) usageColor = c.statusWarn;

                    let resetStr = '';
                    if (primary.resetTime) {
                        const diff = new Date(primary.resetTime).getTime() - Date.now();
                        if (diff > 0) resetStr = ` ${c.textDark}|${c.reset} ${c.textMuted}Resets:${c.reset} in ${formatDuration(diff)}`;
                    }

                    if (hasVerifyUrl) {
                        detailsLine = `${c.textMuted}Details:${c.reset} ${timeAgo} ${c.textDark}|${c.reset} ${c.statusDanger}Google check needed - press V to verify in browser, or R to re-login${c.reset}`;
                    } else if (isInvalid) {
                        detailsLine = `${c.textMuted}Details:${c.reset} ${timeAgo} ${c.textDark}|${c.reset} ${c.statusDanger}invalid - press R to re-login${c.reset}`;
                    } else {
                        detailsLine = `${c.textMuted}Details:${c.reset} ${timeAgo} ${c.textDark}|${c.reset} ${usageColor}${usedPct}% used${c.reset} ${c.textDark}(${remainingPct}% left)${c.reset}${resetStr}`;
                    }
                }
            }
        }

        // Fixed bottom Info Bar (1 line)
        if (statusMessage) {
            buf += `${c.statusWarn}ℹ ${statusMessage}${c.reset}${c.clearToEndOfLine}\n`;
        } else {
            buf += `${detailsLine || `${c.textMuted}Select an option or account above`}${c.reset}${c.clearToEndOfLine}\n`;
        }

        // Fixed Footer line (no trailing newline to guarantee no terminal auto-scroll)
        buf += `${c.textMuted}↑↓ Move | Enter Select | 1-9 Switch | V Verify | R Re-login | T Toggle | D Delete | Q Back${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;

        process.stdout.write(buf);
    }

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const onResize = () => render();
    process.stdout.on('resize', onResize);

    let shimmerTimer = setInterval(() => render(), 75);

    render();

    return new Promise((resolve) => {
        function cleanupAndExit() {
            if (shimmerTimer) clearInterval(shimmerTimer);
            process.stdout.removeListener('resize', onResize);
            process.stdout.write(c.exitAltScreen + c.enableWrap + c.showCursor);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener('keypress', onKeypress);
            console.log('\nExited dashboard.\n');
            resolve();
        }

        async function onKeypress(str, key) {
            if (!key) return;

            if ((key.ctrl && key.name === 'c') || key.name === 'q' || key.name === 'escape') {
                cleanupAndExit();
                return;
            }

            // Quick switch 1-9
            if (/^[1-9]$/.test(str)) {
                const targetNum = parseInt(str, 10);
                const accountItems = items.filter(it => it.type === 'account');
                if (targetNum <= accountItems.length) {
                    statusMessage = `Switching to Account ${targetNum}...`;
                    render();
                    await switchAccount(targetNum.toString());
                    await refreshData();
                    items = getItems();
                    statusMessage = `Switched to Account ${targetNum}.`;
                    render();
                }
                return;
            }

            // 'V' or 'v': Open Google verification link for accounts needing check
            if (str === 'v' || str === 'V') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    if (cur.account.verifyUrl) {
                        process.stdout.write(c.exitAltScreen + c.enableWrap + c.showCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(false);
                        console.log(c.clearScreen);
                        await verifyAccount(cur.account);
                        process.stdout.write(c.enterAltScreen + c.disableWrap + c.hideCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(true);
                        process.stdin.resume();
                        await refreshData();
                        items = getItems();
                        statusMessage = `Verified account ${cur.account.email}.`;
                        render();
                        return;
                    } else {
                        statusMessage = `Account ${cur.account.email} does not require Google verification.`;
                        render();
                        return;
                    }
                }
            }

            // 'R' or 'r': Re-login account under cursor
            if (str === 'r' || str === 'R') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    const email = cur.account.email;
                    process.stdout.write(c.exitAltScreen + c.enableWrap + c.showCursor);
                    if (process.stdin.isTTY) process.stdin.setRawMode(false);
                    console.log(c.clearScreen);
                    await loginAccount({ targetEmail: email });
                    console.log(`\n${c.actionGreen}✓ Automatically returning to dashboard in 1s...${c.reset}`);
                    await new Promise(r => setTimeout(r, 1000));
                    process.stdout.write(c.enterAltScreen + c.disableWrap + c.hideCursor);
                    if (process.stdin.isTTY) process.stdin.setRawMode(true);
                    process.stdin.resume();
                    await refreshData();
                    items = getItems();
                    statusMessage = `Refreshed credentials for ${email}.`;
                    render();
                    return;
                }
            }

            // 'T' or 't': Toggle selected account (enable/disable)
            if (str === 't' || str === 'T') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    const target = (cur.accountIndex + 1).toString();
                    await toggleAccount(target);
                    await refreshData();
                    items = getItems();
                    statusMessage = `Toggled Account ${target} status.`;
                    render();
                    return;
                }
            }

            // 'D' or 'd': Delete selected account with prompt
            if (str === 'd' || str === 'D') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    const email = cur.account.email;
                    process.stdout.write(c.exitAltScreen + c.enableWrap + c.showCursor);
                    if (process.stdin.isTTY) process.stdin.setRawMode(false);
                    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                    const ans = await new Promise(r => rl.question(`\n${c.statusDanger}Are you sure you want to remove ${email}? [y/N]: ${c.reset}`, r));
                    rl.close();
                    if (ans.toLowerCase() === 'y') {
                        await removeAccount(email);
                        await refreshData();
                        items = getItems();
                        selectedIndex = Math.min(selectedIndex, items.length - 1);
                        statusMessage = `Deleted account ${email}.`;
                    }
                    process.stdout.write(c.enterAltScreen + c.disableWrap + c.hideCursor);
                    if (process.stdin.isTTY) process.stdin.setRawMode(true);
                    process.stdin.resume();
                    render();
                    return;
                }
            }

            // Navigation
            if (key.name === 'up' || key.name === 'k') {
                do {
                    selectedIndex = (selectedIndex - 1 + items.length) % items.length;
                } while (items[selectedIndex].type === 'header');
                statusMessage = '';
                render();
                return;
            }

            if (key.name === 'down' || key.name === 'j') {
                do {
                    selectedIndex = (selectedIndex + 1) % items.length;
                } while (items[selectedIndex].type === 'header');
                statusMessage = '';
                render();
                return;
            }

            // Enter key
            if (key.name === 'return' || key.name === 'enter') {
                const cur = items[selectedIndex];
                if (!cur) return;

                if (cur.type === 'account') {
                    const accNum = cur.accountIndex + 1;
                    statusMessage = `Switching to Account ${accNum}...`;
                    render();
                    await switchAccount(accNum.toString());
                    await refreshData();
                    items = getItems();
                    statusMessage = `Switched to Account ${accNum}.`;
                    render();
                    return;
                }

                if (cur.type === 'action') {
                    // 1. Toggle Load Balancer Strategy
                    if (cur.id === 'lb_strategy') {
                        const curIdx = STRATEGY_CYCLE.findIndex(s => s.id === currentStrategy);
                        const nextObj = STRATEGY_CYCLE[(curIdx + 1) % STRATEGY_CYCLE.length];
                        currentStrategy = nextObj.id;
                        saveConfig({ accountSelection: { strategy: nextObj.id } });
                        items = getItems();
                        statusMessage = `Strategy set to: ${nextObj.label}.`;
                        render();
                        return;
                    }

                    // 2. Custom GCP Project Setup
                    if (cur.id === 'custom_project') {
                        isSubScreenActive = true;
                        if (shimmerTimer) clearInterval(shimmerTimer);
                        process.stdout.write(c.exitAltScreen + c.enableWrap + c.showCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(false);
                        console.log(c.clearScreen);
                        console.log(`${c.brandGreen}╭─────────────────────────────────────────────────────────────────╮${c.reset}`);
                        console.log(`${c.brandGreen}│  Custom Google Cloud Project Setup Guide                        │${c.reset}`);
                        console.log(`${c.brandGreen}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n`);
                        console.log('You can use your own GCP Project instead of default project:');
                        console.log('  1. Visit: https://console.cloud.google.com/');
                        console.log('  2. Create or select a Google Cloud Project (e.g. "my-atc-agent")');
                        console.log('  3. In "APIs & Services", enable "Cloud AI Companion API"');
                        console.log('  4. Enter your Project ID below:\n');
                        const curProj = config?.customProjectId || 'Default (auto-managed)';
                        console.log(`Current Project ID: ${c.activeBright}${curProj}${c.reset}\n`);

                        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                        const ans = await new Promise(r => rl.question(`Enter Project ID (leave blank to cancel, 'default' to reset): `, r));
                        rl.close();

                        const trimmed = ans.trim();
                        if (trimmed === 'default') {
                            saveConfig({ customProjectId: '' });
                            statusMessage = 'Reset project to auto-managed default.';
                        } else if (trimmed) {
                            saveConfig({ customProjectId: trimmed });
                            statusMessage = `Configured custom project ID: ${trimmed}.`;
                        }

                        isSubScreenActive = false;
                        process.stdout.write(c.enterAltScreen + c.disableWrap + c.hideCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(true);
                        process.stdin.resume();
                        shimmerTimer = setInterval(() => render(), 75);
                        items = getItems();
                        render();
                        return;
                    }

                    // 3. Custom Model Mappings
                    if (cur.id === 'model_mapping') {
                        isSubScreenActive = true;
                        if (shimmerTimer) clearInterval(shimmerTimer);
                        process.stdout.write(c.exitAltScreen + c.enableWrap + c.showCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(false);
                        console.log(c.clearScreen);
                        console.log(`${c.brandGreen}╭─────────────────────────────────────────────────────────────────╮${c.reset}`);
                        console.log(`${c.brandGreen}│  Model Configuration & Environment Management                   │${c.reset}`);
                        console.log(`${c.brandGreen}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n`);

                        const claudeSettings = readClaudeSettings();
                        const cEnv = claudeSettings.env || {};
                        const mm = config.modelMapping || {};

                        const mainModel = cEnv.ANTHROPIC_MODEL || '';
                        const opusModel = cEnv.ANTHROPIC_DEFAULT_OPUS_MODEL || cEnv.ANTHROPIC_CLAUDE_OPUS_MODEL || '';
                        const sonnetModel = cEnv.ANTHROPIC_DEFAULT_SONNET_MODEL || cEnv.ANTHROPIC_CLAUDE_SONNET_MODEL || '';
                        const haikuModel = cEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL || '';
                        const subagentModel = cEnv.CLAUDE_CODE_SUBAGENT_MODEL || '';

                        console.log(`Claude Code Model Environment (${c.textDark}~/.claude/settings.json${c.reset}):\n`);
                        console.log(`  1. Main Model     (ANTHROPIC_MODEL):           ${mainModel ? `${c.activeBright}${mainModel}${c.reset} -> ${c.actionGreen}${getMappingTarget(mm, mainModel)}${c.reset}` : `${c.textMuted}(not set - uses Claude default)${c.reset}`}`);
                        console.log(`  2. Opus Override  (ANTHROPIC_DEFAULT_OPUS):    ${opusModel ? `${c.activeBright}${opusModel}${c.reset} -> ${c.actionGreen}${getMappingTarget(mm, opusModel)}${c.reset}` : `${c.textMuted}(not set)${c.reset}`}`);
                        console.log(`  3. Sonnet Override(ANTHROPIC_DEFAULT_SONNET):  ${sonnetModel ? `${c.activeBright}${sonnetModel}${c.reset} -> ${c.actionGreen}${getMappingTarget(mm, sonnetModel)}${c.reset}` : `${c.textMuted}(not set)${c.reset}`}`);
                        console.log(`  4. Haiku Override (ANTHROPIC_DEFAULT_HAIKU):   ${haikuModel ? `${c.activeBright}${haikuModel}${c.reset} -> ${c.actionGreen}${getMappingTarget(mm, haikuModel)}${c.reset}` : `${c.textMuted}(not set)${c.reset}`}`);
                        console.log(`  5. Subagent Model (CLAUDE_CODE_SUBAGENT_MODEL):${subagentModel ? `${c.activeBright}${subagentModel}${c.reset} -> ${c.actionGreen}${getMappingTarget(mm, subagentModel)}${c.reset}` : `${c.textMuted}(not set - falls back to Haiku)${c.reset}`}\n`);

                        console.log('Options:');
                        console.log('  [1] Max Performance Preset (Sonnet/Opus -> Flash-High, Subagent/Haiku -> Flash-Lite)');
                        console.log('  [2] Balanced Preset        (Opus -> Flash-High, Sonnet -> Flash-Medium, Subagent -> Flash-Lite)');
                        console.log('  [3] Set Subagent Model     (Configure CLAUDE_CODE_SUBAGENT_MODEL, blank to delete)');
                        console.log('  [4] Edit Specific Variable (Choose 1-5 to edit, or leave blank to delete env)');
                        console.log('  [5] Clean All Model Envs   (Remove all model env overrides from settings.json)');
                        console.log('  [Enter] Return to Dashboard\n');

                        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                        const opt = await new Promise(r => rl.question('Select option [1-5] or press Enter: ', r));

                        if (opt === '1') {
                            claudeSettings.env = claudeSettings.env || {};
                            claudeSettings.env.ANTHROPIC_MODEL = 'claude-sonnet-5-5';
                            claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5-5';
                            claudeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5-5';
                            claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5';
                            claudeSettings.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-haiku-5-5';
                            claudeSettings.env.ANTHROPIC_CLAUDE_OPUS_MODEL = 'claude-opus-5-5';
                            claudeSettings.env.ANTHROPIC_CLAUDE_SONNET_MODEL = 'claude-sonnet-5-5';
                            writeClaudeSettings(claudeSettings);

                            const newMm = { ...(config.modelMapping || {}) };
                            newMm['claude-opus-5-5'] = { mapping: 'gemini-3.8-flash-high' };
                            newMm['claude-sonnet-5-5'] = { mapping: 'gemini-3.8-flash-high' };
                            newMm['claude-haiku-5-5'] = { mapping: 'gemini-3.1-flash-lite' };
                            saveConfig({ modelMapping: newMm });
                            statusMessage = 'Applied Preset 1: Max Performance models in Claude Code.';
                        } else if (opt === '2') {
                            claudeSettings.env = claudeSettings.env || {};
                            claudeSettings.env.ANTHROPIC_MODEL = 'claude-sonnet-5-5';
                            claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5-5';
                            claudeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5-5';
                            claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5';
                            claudeSettings.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-haiku-5-5';
                            writeClaudeSettings(claudeSettings);

                            const newMm = { ...(config.modelMapping || {}) };
                            newMm['claude-opus-5-5'] = { mapping: 'gemini-3.8-flash-high' };
                            newMm['claude-sonnet-5-5'] = { mapping: 'gemini-3.8-flash-medium' };
                            newMm['claude-haiku-5-5'] = { mapping: 'gemini-3.1-flash-lite' };
                            saveConfig({ modelMapping: newMm });
                            statusMessage = 'Applied Preset 2: Balanced models in Claude Code.';
                        } else if (opt === '3') {
                            const curSub = cEnv.CLAUDE_CODE_SUBAGENT_MODEL || '';
                            console.log(`\nCurrent Subagent Model: ${curSub || '(not set)'}`);
                            const ans = await new Promise(r => rl.question('Enter model ID for subagents (leave blank to delete env): ', r));
                            const trimmed = ans.trim();
                            claudeSettings.env = claudeSettings.env || {};
                            if (trimmed) {
                                claudeSettings.env.CLAUDE_CODE_SUBAGENT_MODEL = trimmed;
                                statusMessage = `Set CLAUDE_CODE_SUBAGENT_MODEL to ${trimmed}.`;
                            } else {
                                delete claudeSettings.env.CLAUDE_CODE_SUBAGENT_MODEL;
                                statusMessage = 'Deleted CLAUDE_CODE_SUBAGENT_MODEL from settings.json.';
                            }
                            writeClaudeSettings(claudeSettings);
                        } else if (opt === '4') {
                            const envKeys = [
                                'ANTHROPIC_MODEL',
                                'ANTHROPIC_DEFAULT_OPUS_MODEL',
                                'ANTHROPIC_DEFAULT_SONNET_MODEL',
                                'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                                'CLAUDE_CODE_SUBAGENT_MODEL'
                            ];
                            const varNum = await new Promise(r => rl.question('Select variable number to edit [1-5]: ', r));
                            const idx = parseInt(varNum, 10) - 1;
                            if (idx >= 0 && idx < envKeys.length) {
                                const selectedKey = envKeys[idx];
                                const currentVal = cEnv[selectedKey] || '';
                                console.log(`Current value of ${selectedKey}: ${currentVal || '(not set)'}`);
                                const newVal = await new Promise(r => rl.question(`Enter new value (leave blank to delete ${selectedKey}): `, r));
                                const trimmed = newVal.trim();
                                claudeSettings.env = claudeSettings.env || {};
                                if (trimmed && trimmed.toLowerCase() !== 'delete' && trimmed.toLowerCase() !== 'none') {
                                    claudeSettings.env[selectedKey] = trimmed;
                                    statusMessage = `Updated ${selectedKey} = ${trimmed}.`;
                                } else {
                                    delete claudeSettings.env[selectedKey];
                                    statusMessage = `Deleted ${selectedKey} from settings.json.`;
                                }
                                writeClaudeSettings(claudeSettings);
                            }
                        } else if (opt === '5') {
                            const keysToRemove = [
                                'ANTHROPIC_MODEL',
                                'ANTHROPIC_DEFAULT_OPUS_MODEL',
                                'ANTHROPIC_DEFAULT_SONNET_MODEL',
                                'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                                'CLAUDE_CODE_SUBAGENT_MODEL',
                                'ANTHROPIC_CLAUDE_OPUS_MODEL',
                                'ANTHROPIC_CLAUDE_SONNET_MODEL',
                                'ANTHROPIC_CLAUDE_5_OPUS_MODEL',
                                'ANTHROPIC_CLAUDE_5_SONNET_MODEL'
                            ];
                            claudeSettings.env = claudeSettings.env || {};
                            keysToRemove.forEach(k => delete claudeSettings.env[k]);
                            writeClaudeSettings(claudeSettings);
                            statusMessage = 'Cleaned all model environment variables from settings.json.';
                        }

                        rl.close();
                        isSubScreenActive = false;
                        process.stdout.write(c.enterAltScreen + c.disableWrap + c.hideCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(true);
                        process.stdin.resume();
                        shimmerTimer = setInterval(() => render(), 75);
                        items = getItems();
                        render();
                        return;
                    }

                    if (cur.id === 'pick_best') {
                        const liveMap = new Map();
                        if (proxyHealth && Array.isArray(proxyHealth.accounts)) {
                            for (const a of proxyHealth.accounts) liveMap.set(a.email, a);
                        }
                        let bestIdx = 1;
                        let bestScore = -1;
                        const tierWeight = { ultra: 30, pro: 20, plus: 10, free: 0 };
                        accountsData.accounts.forEach((acc, i) => {
                            if (!acc.enabled || acc.isInvalid) return;
                            const live = liveMap.get(acc.email) || {};
                            const lim = limitsMap.get(acc.email) || {};
                            const tier = (lim.subscription?.tier || acc.subscription?.tier || 'free').toLowerCase();
                            const high = live.models?.['gemini-3.8-flash-high'] || lim.models?.['gemini-3.8-flash-high'];
                            const quotaScore = Math.round((high?.remainingFraction || 0.5) * 70);
                            const bonus = tierWeight[tier] !== undefined ? tierWeight[tier] : 0;
                            const totalScore = quotaScore + bonus;
                            if (totalScore > bestScore) {
                                bestScore = totalScore;
                                bestIdx = i + 1;
                            }
                        });
                        statusMessage = `Switched to best account: Account ${bestIdx}.`;
                        render();
                        await switchAccount(bestIdx.toString());
                        await refreshData();
                        items = getItems();
                        render();
                        return;
                    }

                    if (cur.id === 'refresh_all') {
                        statusMessage = 'Refreshing quotas and plans from proxy...';
                        render();
                        await refreshData();
                        statusMessage = 'Refreshed quotas and plans from proxy.';
                        render();
                        return;
                    }

                    if (cur.id === 'check_problem') {
                        const problems = accountsData.accounts.filter(a => a.isInvalid);
                        statusMessage = `Problem accounts: ${problems.length} invalid. Focus and press R to re-login.`;
                        render();
                        return;
                    }

                    if (cur.id === 'health_check') {
                        isSubScreenActive = true;
                        if (shimmerTimer) clearInterval(shimmerTimer);
                        process.stdout.write(c.exitAltScreen + c.enableWrap + c.showCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(false);
                        console.log(c.clearScreen);
                        await checkAccounts();
                        console.log(`\n${c.actionGreen}✓ Automatically returning to dashboard in 1s...${c.reset}`);
                        await new Promise(r => setTimeout(r, 1000));
                        process.stdout.write(c.enterAltScreen + c.disableWrap + c.hideCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(true);
                        process.stdin.resume();
                        await refreshData();
                        items = getItems();
                        render();
                        return;
                    }

                    if (cur.id === 'add_account') {
                        process.stdout.write(c.exitAltScreen + c.enableWrap + c.showCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(false);
                        console.log(c.clearScreen);
                        await loginAccount();
                        console.log(`\n${c.actionGreen}✓ Automatically returning to dashboard in 1s...${c.reset}`);
                        await new Promise(r => setTimeout(r, 1000));
                        process.stdout.write(c.enterAltScreen + c.disableWrap + c.hideCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(true);
                        process.stdin.resume();
                        await refreshData();
                        items = getItems();
                        render();
                        return;
                    }
                }
            }
        }

        process.stdin.on('keypress', onKeypress);
    });
}

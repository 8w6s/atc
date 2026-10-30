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

function getStrategyCycle() {
    const thresholdPct = Math.round((config?.accountSelection?.stepThreshold || 0.05) * 100);
    return [
        { id: 'pipelined', label: `Pipelined Quota Shift ${thresholdPct}%`, desc: `Staggers accounts: shifts to next account every ${thresholdPct}% quota drop` },
        { id: 'hybrid', label: 'Hybrid Score', desc: 'Balances health rating, quota availability, and token buckets' },
        { id: 'round-robin', label: 'Round-Robin', desc: 'Cycles sequentially per request across ready accounts' },
        { id: 'sticky', label: 'Sticky Cache', desc: 'Pins to current account until exhausted to maximize prompt caching' }
    ];
}


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
    // Antigravity (11 chars): Continuous Spectrum Linear Gradient
    // Blue 40% (#38bdf8) -> Green 20% (#22c55e) -> Yellow 20% (#eab308) -> Red 20% (#ef4444)
    { ch: 'A', r:  56, g: 189, b: 248 }, // Bright Sky Blue (0%)
    { ch: 'n', r:  50, g: 191, b: 210 }, // Blue-Cyan transition
    { ch: 't', r:  45, g: 193, b: 171 }, // Cyan-Aqua transition
    { ch: 'i', r:  40, g: 195, b: 132 }, // Aqua-Green transition
    { ch: 'g', r:  34, g: 197, b:  94 }, // Pure Vibrant Green (40%)
    { ch: 'r', r: 134, g: 188, b:  51 }, // Lime transition
    { ch: 'a', r: 234, g: 179, b:   8 }, // Pure Yellow (60%)
    { ch: 'v', r: 242, g: 147, b:  15 }, // Amber transition
    { ch: 'i', r: 249, g: 115, b:  22 }, // Orange transition (80%)
    { ch: 't', r: 244, g:  92, b:  45 }, // Red-Orange transition
    { ch: 'y', r: 239, g:  68, b:  68 }, // Pure Red (100%)
    { ch: ' ', r: 255, g: 255, b: 255 },

    // to: Pure Bright White
    { ch: 't', r: 255, g: 255, b: 255 },
    { ch: 'o', r: 255, g: 255, b: 255 },
    { ch: ' ', r: 255, g: 255, b: 255 },

    // Claude Code (11 chars): Smooth Anthropic Orange 60% (#f97316) -> Warm Yellow 40% (#facc15)
    { ch: 'C', r: 249, g: 115, b:  22 },
    { ch: 'l', r: 249, g: 115, b:  22 },
    { ch: 'a', r: 249, g: 115, b:  22 },
    { ch: 'u', r: 249, g: 115, b:  22 },
    { ch: 'd', r: 249, g: 115, b:  22 },
    { ch: 'e', r: 249, g: 115, b:  22 },
    { ch: ' ', r: 249, g: 115, b:  22 },
    { ch: 'C', r: 249, g: 137, b:  22 },
    { ch: 'o', r: 250, g: 160, b:  22 },
    { ch: 'd', r: 250, g: 182, b:  21 },
    { ch: 'e', r: 250, g: 204, b:  21 }
];

function getShimmerTitle() {
    const sweepMs = 3000; // 3 seconds sweep through the text
    const pauseMs = 5000; // 5 seconds wait after reaching the end
    const totalCycle = sweepMs + pauseMs; // 8000ms total
    const elapsed = Date.now() % totalCycle;

    // During the 5s pause window, render base continuous gradient without shimmer
    const isSweeping = elapsed < sweepMs;
    const t = isSweeping ? (elapsed / sweepMs) : 2.0; // 2.0 puts center far out of range
    const total = TITLE_CHARS.length;
    const center = t * (total + 6) - 3;

    let out = '\x1b[1m';
    for (let i = 0; i < total; i++) {
        const item = TITLE_CHARS[i];
        if (item.ch === ' ') {
            out += ' ';
            continue;
        }

        if (isSweeping) {
            const dist = Math.abs(i - center);
            if (dist < 2.5) {
                const factor = Math.cos((dist / 2.5) * (Math.PI / 2));
                // Silver-gray metallic sheen highlight
                const silverR = 220, silverG = 228, silverB = 240;
                const r = Math.round(item.r + (silverR - item.r) * factor * 0.7);
                const g = Math.round(item.g + (silverG - item.g) * factor * 0.7);
                const b = Math.round(item.b + (silverB - item.b) * factor * 0.7);
                out += `\x1b[38;2;${r};${g};${b}m${item.ch}`;
                continue;
            }
        }
        out += `\x1b[38;2;${item.r};${item.g};${item.b}m${item.ch}`;
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
    let statusTimer = null;

    function setStatus(msg, durationMs = 2000) {
        statusMessage = msg;
        if (statusTimer) clearTimeout(statusTimer);
        render();
        if (durationMs > 0) {
            statusTimer = setTimeout(() => {
                statusMessage = '';
                render();
            }, durationMs);
        }
    }
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
        const stratCycle = getStrategyCycle();
        const stratObj = stratCycle.find(s => s.id === currentStrategy) || stratCycle[0];
        const customProject = config?.customProjectId || 'Default (auto)';

        list.push({ type: 'header', label: 'Quick Actions' });
        list.push({ type: 'action', id: 'add_account', label: 'Add New Account', desc: 'Link a new Google account via OAuth browser' });
        list.push({ type: 'action', id: 'lb_strategy', label: `Load Balancer: [${stratObj.label}]`, desc: stratObj.desc });
        list.push({ type: 'action', id: 'custom_project', label: `Custom GCP Project: [${customProject}]`, desc: 'Configure custom Google Cloud Project ID for quotas' });
        list.push({ type: 'action', id: 'model_mapping', label: 'Model Mappings', desc: 'Configure Claude Code models, subagents, and environment overrides' });
        list.push({ type: 'action', id: 'pick_best', label: 'Pick Best Account', desc: 'Automatically switch to healthiest account with highest quota' });
        list.push({ type: 'action', id: 'check_problem', label: 'Check Problem Accounts', desc: 'Inspect problem accounts with detailed diagnostics & quick fixes' });
        list.push({ type: 'action', id: 'engine_settings', label: 'Settings', desc: 'Configure quota thresholds, request caps, and proxy engine parameters' });

        list.push({ type: 'header', label: 'Saved Accounts' });
        const { accounts, activeIndex } = accountsData;
        const liveActiveEmail = proxyHealth?.activeEmail || null;
        accounts.forEach((acc, i) => {
            const isLiveCurrent = liveActiveEmail
                ? (acc.email.toLowerCase() === liveActiveEmail.toLowerCase())
                : (i === activeIndex);
            list.push({
                type: 'account',
                accountIndex: i,
                account: acc,
                isCurrent: isLiveCurrent
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
        let isSubScreenActive = false;

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

        // Run interactive prompt screens cleanly inside Alternate Screen Buffer
        // without causing layer flickering, buffer jumps, or event listener conflicts
        async function runSubScreen(fn) {
            if (isSubScreenActive) return;
            isSubScreenActive = true;
            if (shimmerTimer) {
                clearInterval(shimmerTimer);
                shimmerTimer = null;
            }
            process.stdin.removeListener('keypress', onKeypress);
            process.stdout.write(c.clearScreen + c.cursorHome + c.enableWrap + c.showCursor);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            try {
                await fn();
            } catch (err) {
                console.error(`\n${c.statusDanger}Error: ${err.message}${c.reset}`);
                await new Promise(r => setTimeout(r, 1500));
            } finally {
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(true);
                }
                process.stdin.resume();
                process.stdin.on('keypress', onKeypress);
                process.stdout.write(c.clearScreen + c.cursorHome + c.disableWrap + c.hideCursor);
                isSubScreenActive = false;
                shimmerTimer = setInterval(() => render(), 75);
                await refreshData();
                items = getItems();
                render();
            }
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
                const target = accountItems.find(it => it.accountIndex === targetNum - 1);
                if (target) {
                    setStatus(`Switching to Account ${targetNum} (${target.account.email})...`, 2000);
                    await switchAccount(targetNum.toString());
                    await refreshData();
                    items = getItems();
                    render();
                }
                return;
            }

            // Navigation (safe check against undefined items)
            if (key.name === 'up' || key.name === 'k') {
                if (!items || items.length === 0) return;
                let prev = selectedIndex - 1;
                while (prev >= 0 && items[prev]?.type === 'header') prev--;
                if (prev >= 0 && items[prev]) selectedIndex = prev;
                render();
                return;
            }

            if (key.name === 'down' || key.name === 'j') {
                if (!items || items.length === 0) return;
                let next = selectedIndex + 1;
                while (next < items.length && items[next]?.type === 'header') next++;
                if (next < items.length && items[next]) selectedIndex = next;
                render();
                return;
            }

            if (key.name === 'home') {
                selectedIndex = items.findIndex(it => it.type !== 'header');
                render();
                return;
            }

            if (key.name === 'end') {
                for (let i = items.length - 1; i >= 0; i--) {
                    if (items[i].type !== 'header') {
                        selectedIndex = i;
                        break;
                    }
                }
                render();
                return;
            }

            // Enter Selection
            if (key.name === 'return' || key.name === 'enter') {
                const cur = items[selectedIndex];
                if (!cur) return;

                if (cur.type === 'account') {
                    const accNum = cur.accountIndex + 1;
                    setStatus(`Switching to Account ${accNum} (${cur.account.email})...`, 2000);
                    await switchAccount(accNum.toString());
                    await refreshData();
                    items = getItems();
                    render();
                    return;
                }

                if (cur.type === 'action') {
                    if (cur.id === 'lb_strategy') {
                        const stratCycle = getStrategyCycle();
                        const curIdx = stratCycle.findIndex(s => s.id === currentStrategy);
                        const nextObj = stratCycle[(curIdx + 1) % stratCycle.length];
                        currentStrategy = nextObj.id;
                        const accSel = { ...(config.accountSelection || {}), strategy: currentStrategy };
                        saveConfig({ accountSelection: accSel });
                        setStatus(`Strategy set to: ${nextObj.label}.`, 2000);
                        items = getItems();
                        render();
                        return;
                    }

                    if (cur.id === 'custom_project') {
                        await runSubScreen(async () => {
                            let customProj = config?.customProjectId || '';
                            let selectedIdx = 0;
                            let notice = '';

                            const items = [
                                { id: 'val', label: 'Custom GCP Project ID', getVal: () => customProj || 'Default (auto)', desc: 'Route Gemini API requests with your own Google Cloud project' },
                                { id: 'edit', label: 'Set Custom Project ID', getVal: () => '', desc: 'Enter custom project ID string (e.g. my-project-513208)' },
                                { id: 'reset', label: 'Reset to Default (auto)', getVal: () => '', desc: 'Revert to automatic default project routing' },
                                { id: 'save', label: 'Save & Return to Dashboard', getVal: () => '', desc: 'Write changes to ~/.config/atc/config.json' }
                            ];

                            function renderScreen() {
                                let out = c.clearScreen + c.cursorHome;
                                out += `${c.brandGreen}╭─────────────────────────────────────────────────────────────────╮${c.reset}\n`;
                                out += `${c.brandGreen}│  Custom GCP Project Configuration                               │${c.reset}\n`;
                                out += `${c.brandGreen}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n\n`;

                                for (let i = 0; i < items.length; i++) {
                                    const it = items[i];
                                    const isSel = i === selectedIdx;
                                    const pointer = isSel ? `\x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;
                                    const val = it.getVal();

                                    let line = '';
                                    if (val) {
                                        line = isSel
                                            ? `\x1b[1;38;5;255m${it.label}:\x1b[0m \x1b[1;38;5;120m[${val}]\x1b[0m`
                                            : `\x1b[38;5;250m${it.label}:\x1b[0m \x1b[38;5;147m[${val}]\x1b[0m`;
                                    } else {
                                        line = isSel
                                            ? `\x1b[1;38;5;255m${it.label}${c.reset}`
                                            : `\x1b[38;5;248m${it.label}${c.reset}`;
                                    }
                                    out += `${pointer}${line}${c.clearToEndOfLine}\n`;
                                }

                                out += `\n`;
                                const curIt = items[selectedIdx];
                                if (notice) {
                                    out += `${c.statusWarn}ℹ ${notice}${c.reset}${c.clearToEndOfLine}\n`;
                                } else {
                                    out += `${c.textMuted}Details:${c.reset} ${c.textNormal}${curIt.desc}${c.reset}${c.clearToEndOfLine}\n`;
                                }

                                out += `${c.textMuted}↑↓ Move | Enter Select/Edit | ESC Return${c.reset}${c.clearToEndOfLine}`;
                                process.stdout.write(out);
                            }

                            await new Promise((resolve) => {
                                if (process.stdin.isTTY) process.stdin.setRawMode(true);
                                readline.emitKeypressEvents(process.stdin);

                                async function onKey(str, key) {
                                    if (!key) return;

                                    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                                        process.stdin.removeListener('keypress', onKey);
                                        resolve();
                                        return;
                                    }

                                    if (key.name === 'up' || key.name === 'k') {
                                        notice = '';
                                        selectedIdx = (selectedIdx - 1 + items.length) % items.length;
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'down' || key.name === 'j') {
                                        notice = '';
                                        selectedIdx = (selectedIdx + 1) % items.length;
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'return' || key.name === 'enter') {
                                        if (selectedIdx === 0 || selectedIdx === 1) {
                                            process.stdin.removeListener('keypress', onKey);
                                            if (process.stdin.isTTY) process.stdin.setRawMode(false);
                                            process.stdout.write(c.showCursor);
                                            console.log(`\n\nEnter new GCP Project ID (leave empty to reset):`);
                                            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                                            const ans = await new Promise(r => rl.question('> ', r));
                                            rl.close();
                                            const trimmed = ans.trim();
                                            if (trimmed && trimmed.toLowerCase() !== 'clear' && trimmed.toLowerCase() !== 'reset') {
                                                customProj = trimmed;
                                                saveConfig({ customProjectId: trimmed });
                                                notice = `Saved Custom GCP Project ID: ${trimmed}`;
                                            } else {
                                                customProj = '';
                                                const next = { ...config };
                                                delete next.customProjectId;
                                                saveConfig(next);
                                                notice = 'Reset to default automatic project routing';
                                            }
                                            if (process.stdin.isTTY) process.stdin.setRawMode(true);
                                            process.stdout.write(c.hideCursor);
                                            process.stdin.on('keypress', onKey);
                                            renderScreen();
                                            return;
                                        }

                                        if (selectedIdx === 2) {
                                            customProj = '';
                                            const next = { ...config };
                                            delete next.customProjectId;
                                            saveConfig(next);
                                            notice = 'Reset to default automatic project routing';
                                            renderScreen();
                                            return;
                                        }

                                        if (selectedIdx === 3) {
                                            process.stdin.removeListener('keypress', onKey);
                                            resolve();
                                            return;
                                        }
                                    }
                                }

                                process.stdin.on('keypress', onKey);
                                renderScreen();
                            });

                            setStatus(`Custom GCP Project set to: ${customProj || 'Default'}.`, 2000);
                        });
                        return;
                    }

                    if (cur.id === 'model_mapping') {
                        await runSubScreen(async () => {
                            const claudeSettings = readClaudeSettings();
                            const cEnv = claudeSettings.env || {};
                            let selectedIdx = 0;
                            let notice = '';

                            function getItemsList() {
                                const env = claudeSettings.env || {};
                                const mm = config.modelMapping || {};

                                const defaultMain = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
                                const defaultSub = env.CLAUDE_CODE_SUBAGENT_MODEL || 'claude-haiku-5-5';
                                const defaultOpus = env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'claude-opus-5-5';
                                const defaultSonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-5-5';
                                const defaultHaiku = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-5-5';

                                return [
                                    {
                                        id: 'ANTHROPIC_MODEL',
                                        label: 'Main Model (ANTHROPIC_MODEL)',
                                        val: defaultMain,
                                        target: getMappingTarget(mm, defaultMain),
                                        desc: 'Fake ID sent by Claude Code → translated by ATC to target Google model'
                                    },
                                    {
                                        id: 'CLAUDE_CODE_SUBAGENT_MODEL',
                                        label: 'Subagent Model (CLAUDE_CODE_SUBAGENT)',
                                        val: defaultSub,
                                        target: getMappingTarget(mm, defaultSub),
                                        desc: 'Fake ID sent by subagents → translated by ATC to target Google model'
                                    },
                                    {
                                        id: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
                                        label: 'Opus Override (ANTHROPIC_DEFAULT_OPUS)',
                                        val: defaultOpus,
                                        target: getMappingTarget(mm, defaultOpus),
                                        desc: 'Opus request translation → translated by ATC to target Google model'
                                    },
                                    {
                                        id: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                                        label: 'Sonnet Override (ANTHROPIC_DEFAULT_SONNET)',
                                        val: defaultSonnet,
                                        target: getMappingTarget(mm, defaultSonnet),
                                        desc: 'Sonnet request translation → translated by ATC to target Google model'
                                    },
                                    {
                                        id: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                                        label: 'Haiku Override (ANTHROPIC_DEFAULT_HAIKU)',
                                        val: defaultHaiku,
                                        target: getMappingTarget(mm, defaultHaiku),
                                        desc: 'Haiku request translation → translated by ATC to target Google model'
                                    },
                                    {
                                        id: 'custom_fake',
                                        label: 'Add / Edit Custom Fake Model (e.g. gpt-6-sol)',
                                        val: '',
                                        target: '',
                                        desc: 'Create or update any arbitrary Fake Model ID mapping to a Gemini backend'
                                    },
                                    { id: 'preset_speed', label: 'Apply Preset: Max Performance', val: '', desc: 'Sonnet/Opus → Flash-High, Subagent/Haiku → Flash-Lite' },
                                    { id: 'preset_balanced', label: 'Apply Preset: Balanced', val: '', desc: 'Opus → Flash-High, Sonnet → Flash-Medium, Subagent/Haiku → Flash-Lite' },
                                    { id: 'preset_quality', label: 'Apply Preset: Gemini 3.8 Pro', val: '', desc: 'Route all model requests to high-reasoning Gemini 3.8 Pro' },
                                    { id: 'clean', label: 'Clean All Custom Model Overrides', val: '', desc: 'Remove all model environment variables from ~/.claude/settings.json' },
                                    { id: 'save', label: 'Save & Return to Dashboard', val: '', desc: 'Return to main dashboard' }
                                ];
                            }

                            function renderScreen() {
                                const list = getItemsList();
                                let out = c.clearScreen + c.cursorHome;
                                out += `${c.brandGreen}╭─────────────────────────────────────────────────────────────────╮${c.reset}\n`;
                                out += `${c.brandGreen}│  Model Mappings & Fake ID Routing                               │${c.reset}\n`;
                                out += `${c.brandGreen}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n\n`;

                                for (let i = 0; i < list.length; i++) {
                                    const it = list[i];
                                    const isSel = i === selectedIdx;
                                    const pointer = isSel ? `\x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;

                                    let line = '';
                                    if (it.val) {
                                        const targetTag = it.target ? ` \x1b[38;5;245m→\x1b[0m \x1b[1;38;5;51m${it.target}\x1b[0m` : '';
                                        line = isSel
                                            ? `\x1b[1;38;5;255m${it.label}:\x1b[0m \x1b[1;38;5;120m[${it.val}]\x1b[0m${targetTag}`
                                            : `\x1b[38;5;250m${it.label}:\x1b[0m \x1b[38;5;147m[${it.val}]\x1b[0m${targetTag}`;
                                    } else {
                                        line = isSel
                                            ? `\x1b[1;38;5;255m${it.label}${c.reset}`
                                            : `\x1b[38;5;248m${it.label}${c.reset}`;
                                    }
                                    out += `${pointer}${line}${c.clearToEndOfLine}\n`;
                                }

                                out += `\n`;
                                const curIt = list[selectedIdx];
                                if (notice) {
                                    out += `${c.statusWarn}ℹ ${notice}${c.reset}${c.clearToEndOfLine}\n`;
                                } else {
                                    out += `${c.textMuted}Details:${c.reset} ${c.textNormal}${curIt.desc}${c.reset}${c.clearToEndOfLine}\n`;
                                }

                                out += `${c.textMuted}↑↓ Move | Enter Select/Edit | ESC Return${c.reset}${c.clearToEndOfLine}`;
                                process.stdout.write(out);
                            }

                            await new Promise((resolve) => {
                                if (process.stdin.isTTY) process.stdin.setRawMode(true);
                                readline.emitKeypressEvents(process.stdin);

                                async function onKey(str, key) {
                                    if (!key) return;

                                    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                                        process.stdin.removeListener('keypress', onKey);
                                        resolve();
                                        return;
                                    }

                                    const list = getItemsList();
                                    if (key.name === 'up' || key.name === 'k') {
                                        notice = '';
                                        selectedIdx = (selectedIdx - 1 + list.length) % list.length;
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'down' || key.name === 'j') {
                                        notice = '';
                                        selectedIdx = (selectedIdx + 1) % list.length;
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'return' || key.name === 'enter') {
                                        const curIt = list[selectedIdx];

                                        // Editing model env variable and target mapping
                                        if (selectedIdx < 5) {
                                            process.stdin.removeListener('keypress', onKey);
                                            if (process.stdin.isTTY) process.stdin.setRawMode(false);
                                            process.stdout.write(c.showCursor);

                                            console.log(`\n\nConfigure Fake Model ID & Backend Target for ${curIt.id}:`);
                                            console.log(`Current: Fake ID = [${curIt.val}] → Backend = [${curIt.target}]`);

                                            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                                            console.log(`\nStep 1: Enter Fake Model ID (client requests this name, e.g. claude-sonnet-5-5, gpt-6-sol):`);
                                            const newFake = await new Promise(r => rl.question(`[default: ${curIt.val}] > `, r));

                                            console.log(`\nStep 2: Enter Google Backend Model to execute (e.g. gemini-3.8-flash-high, gemini-3.8-flash-medium, gemini-2.5-pro, gemini-3.1-flash-lite):`);
                                            const newBackend = await new Promise(r => rl.question(`[default: ${curIt.target}] > `, r));
                                            rl.close();

                                            const finalFake = newFake.trim() || curIt.val;
                                            const finalBackend = newBackend.trim() || curIt.target;

                                            claudeSettings.env = claudeSettings.env || {};
                                            claudeSettings.env[curIt.id] = finalFake;
                                            writeClaudeSettings(claudeSettings);

                                            const newMm = { ...(config.modelMapping || {}) };
                                            newMm[finalFake] = { mapping: finalBackend };
                                            saveConfig({ modelMapping: newMm });

                                            notice = `Mapped [${finalFake}] → [${finalBackend}] for ${curIt.id}`;

                                            if (process.stdin.isTTY) process.stdin.setRawMode(true);
                                            process.stdout.write(c.hideCursor);
                                            process.stdin.on('keypress', onKey);
                                            renderScreen();
                                            return;
                                        }

                                        if (curIt.id === 'custom_fake') {
                                            process.stdin.removeListener('keypress', onKey);
                                            if (process.stdin.isTTY) process.stdin.setRawMode(false);
                                            process.stdout.write(c.showCursor);

                                            console.log(`\n\nAdd Custom Fake Model ID Mapping:`);
                                            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                                            console.log(`Enter Fake Model ID (e.g. gpt-6-sol, my-custom-agent, claude-opus-5.5):`);
                                            const fakeName = await new Promise(r => rl.question(`> `, r));

                                            console.log(`Enter Google Gemini Backend Model (e.g. gemini-3.8-flash-high, gemini-3.8-flash-medium, gemini-2.5-pro, gemini-3.1-flash-lite):`);
                                            const backendName = await new Promise(r => rl.question(`[default: gemini-3.8-flash-high] > `, r));
                                            rl.close();

                                            const f = fakeName.trim();
                                            const b = backendName.trim() || 'gemini-3.8-flash-high';
                                            if (f) {
                                                const newMm = { ...(config.modelMapping || {}) };
                                                newMm[f] = { mapping: b };
                                                saveConfig({ modelMapping: newMm });
                                                notice = `Added custom fake mapping: [${f}] → [${b}]`;
                                            }

                                            if (process.stdin.isTTY) process.stdin.setRawMode(true);
                                            process.stdout.write(c.hideCursor);
                                            process.stdin.on('keypress', onKey);
                                            renderScreen();
                                            return;
                                        }

                                        // Presets
                                        if (curIt.id === 'preset_speed') {
                                            claudeSettings.env = claudeSettings.env || {};
                                            claudeSettings.env.ANTHROPIC_MODEL = 'claude-sonnet-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5';
                                            claudeSettings.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-haiku-5-5';
                                            writeClaudeSettings(claudeSettings);

                                            const newMm = { ...(config.modelMapping || {}) };
                                            newMm['claude-opus-5-5'] = { mapping: 'gemini-3.8-flash-high' };
                                            newMm['claude-sonnet-5-5'] = { mapping: 'gemini-3.8-flash-high' };
                                            newMm['claude-haiku-5-5'] = { mapping: 'gemini-3.1-flash-lite' };
                                            saveConfig({ modelMapping: newMm });
                                            notice = 'Applied Preset: Max Performance (Flash-High & Flash-Lite)';
                                            renderScreen();
                                            return;
                                        }

                                        if (curIt.id === 'preset_balanced') {
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
                                            notice = 'Applied Preset: Balanced (Flash-High, Medium & Lite)';
                                            renderScreen();
                                            return;
                                        }

                                        if (curIt.id === 'preset_quality') {
                                            claudeSettings.env = claudeSettings.env || {};
                                            claudeSettings.env.ANTHROPIC_MODEL = 'claude-opus-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-opus-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-sonnet-5-5';
                                            claudeSettings.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-sonnet-5-5';
                                            writeClaudeSettings(claudeSettings);

                                            const newMm = { ...(config.modelMapping || {}) };
                                            newMm['claude-opus-5-5'] = { mapping: 'gemini-3.8-pro' };
                                            newMm['claude-sonnet-5-5'] = { mapping: 'gemini-3.8-pro' };
                                            newMm['claude-haiku-5-5'] = { mapping: 'gemini-3.8-flash-high' };
                                            saveConfig({ modelMapping: newMm });
                                            notice = 'Applied Preset: Gemini 3.8 Pro for all models';
                                            renderScreen();
                                            return;
                                        }

                                        if (curIt.id === 'clean') {
                                            const keys = [
                                                'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
                                                'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                                                'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_CLAUDE_OPUS_MODEL',
                                                'ANTHROPIC_CLAUDE_SONNET_MODEL'
                                            ];
                                            claudeSettings.env = claudeSettings.env || {};
                                            keys.forEach(k => delete claudeSettings.env[k]);
                                            writeClaudeSettings(claudeSettings);
                                            notice = 'Cleaned all custom model variables from settings.json';
                                            renderScreen();
                                            return;
                                        }

                                        if (curIt.id === 'save') {
                                            process.stdin.removeListener('keypress', onKey);
                                            resolve();
                                            return;
                                        }
                                    }
                                }

                                process.stdin.on('keypress', onKey);
                                renderScreen();
                            });

                            setStatus('Model Mappings configuration updated.', 2000);
                        });
                        return;
                    }

                    if (cur.id === 'pick_best') {
                        const liveMap = new Map();
                        if (proxyHealth && Array.isArray(proxyHealth.accounts)) {
                            for (const a of proxyHealth.accounts) liveMap.set(a.email, a);
                        }
                        const limitsMap = new Map();
                        if (proxyLimits && Array.isArray(proxyLimits.accounts)) {
                            for (const a of proxyLimits.accounts) limitsMap.set(a.email, a);
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
                        setStatus(`Switched to best account: Account ${bestIdx}.`, 2000);
                        await switchAccount(bestIdx.toString());
                        await refreshData();
                        items = getItems();
                        render();
                        return;
                    }

                    if (cur.id === 'check_problem') {
                        await runSubScreen(async () => {
                            const liveMap = new Map();
                            if (proxyHealth && Array.isArray(proxyHealth.accounts)) {
                                for (const a of proxyHealth.accounts) liveMap.set(a.email, a);
                            }

                            const problems = [];
                            accountsData.accounts.forEach((acc, i) => {
                                const live = liveMap.get(acc.email) || {};
                                const isInvalid = acc.isInvalid || live.status === 'invalid';
                                const hasVerifyUrl = !!acc.verifyUrl;
                                const isLimited = live.status === 'rate-limit' || (live.rateLimitReset && live.rateLimitReset > Date.now());
                                const isDisabled = !acc.enabled;

                                if (isInvalid || hasVerifyUrl || isLimited || isDisabled) {
                                    problems.push({
                                        index: i + 1,
                                        account: acc,
                                        isInvalid,
                                        hasVerifyUrl,
                                        isLimited,
                                        isDisabled
                                    });
                                }
                            });

                            let selectedProblemIdx = 0;

                            function renderScreen() {
                                let out = c.clearScreen + c.cursorHome;
                                out += `${c.brandGreen}╭─────────────────────────────────────────────────────────────────╮${c.reset}\n`;
                                out += `${c.brandGreen}│  Problem Accounts Diagnostics & Resolution                      │${c.reset}\n`;
                                out += `${c.brandGreen}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n\n`;

                                if (problems.length === 0) {
                                    out += `  \x1b[1;38;5;48m✓ All accounts are active and ready in pool.${c.reset}\n`;
                                    out += `  ${c.textMuted}• ${accountsData.accounts.length} accounts configured for request routing.${c.reset}\n\n`;
                                    out += `${c.textMuted}───────────────────────────────────────────────────────────────────${c.reset}\n`;
                                    out += `${c.textMuted}Details:${c.reset} ${c.textNormal}All accounts are ready. Press Enter or ESC to return.${c.reset}\n`;
                                    out += `${c.textMuted}Enter / ESC Return to Dashboard${c.reset}`;
                                    process.stdout.write(out);
                                    return;
                                }

                                for (let i = 0; i < problems.length; i++) {
                                    const p = problems[i];
                                    const isSel = i === selectedProblemIdx;
                                    const pointer = isSel ? `\x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;

                                    let badge = '';
                                    if (p.hasVerifyUrl) badge = `${c.statusDanger}[verify-req]${c.reset}`;
                                    else if (p.isInvalid) badge = `${c.statusDanger}[invalid]${c.reset}`;
                                    else if (p.isLimited) badge = `${c.statusWarn}[rate-limit]${c.reset}`;
                                    else if (p.isDisabled) badge = `${c.statusMuted}[disabled]${c.reset}`;

                                    const line = isSel
                                        ? `\x1b[1;38;5;255mAccount ${p.index}: ${p.account.email}\x1b[0m  ${badge}`
                                        : `\x1b[38;5;250mAccount ${p.index}: ${p.account.email}\x1b[0m  ${badge}`;

                                    out += `${pointer}${line}${c.clearToEndOfLine}\n`;
                                }

                                const curP = problems[selectedProblemIdx];
                                let fixAction = '';
                                if (curP.hasVerifyUrl) fixAction = 'Press V on Dashboard to open Google Verification link in browser';
                                else if (curP.isInvalid) fixAction = 'Press R on Dashboard to re-authenticate via OAuth';
                                else if (curP.isLimited) fixAction = 'Account cooling down · Auto-recovers when quota resets';
                                else if (curP.isDisabled) fixAction = 'Press T on Dashboard to re-enable account in pool';

                                out += `\n${c.textMuted}───────────────────────────────────────────────────────────────────${c.reset}\n`;
                                out += `${c.textMuted}Details:${c.reset} ${c.textNormal}${fixAction}${c.reset}${c.clearToEndOfLine}\n`;
                                out += `${c.textMuted}↑↓ Move | Enter / ESC Return to Dashboard${c.reset}`;
                                process.stdout.write(out);
                            }

                            await new Promise((resolve) => {
                                if (process.stdin.isTTY) process.stdin.setRawMode(true);
                                readline.emitKeypressEvents(process.stdin);

                                function onKey(str, key) {
                                    if (!key) return;

                                    if (key.name === 'escape' || key.name === 'return' || key.name === 'enter' || (key.ctrl && key.name === 'c')) {
                                        process.stdin.removeListener('keypress', onKey);
                                        resolve();
                                        return;
                                    }

                                    if (problems.length > 0) {
                                        if (key.name === 'up' || key.name === 'k') {
                                            selectedProblemIdx = (selectedProblemIdx - 1 + problems.length) % problems.length;
                                            renderScreen();
                                            return;
                                        }

                                        if (key.name === 'down' || key.name === 'j') {
                                            selectedProblemIdx = (selectedProblemIdx + 1) % problems.length;
                                            renderScreen();
                                            return;
                                        }
                                    }
                                }

                                process.stdin.on('keypress', onKey);
                                renderScreen();
                            });
                        });
                        return;
                    }

                    if (cur.id === 'engine_settings') {
                        await runSubScreen(async () => {
                            let thresholdPct = Math.round((config?.accountSelection?.stepThreshold || 0.05) * 100);
                            let reqCap = config?.accountSelection?.requestThreshold || 20;
                            let cooldown = config?.switchAccountDelayMs || 5000;
                            let proxyPort = config?.port || 43128;
                            let activeSettingIdx = 0;
                            let isFocusEditing = false;
                            let editBuffer = '';
                            let notice = '';

                            const settingsMeta = [
                                {
                                    id: 'threshold',
                                    label: 'Quota Rotation Threshold',
                                    unit: '%',
                                    desc: 'Rotates account after using this quota % to stagger 5h recovery in parallel',
                                    min: 1, max: 50, step: 1,
                                    safeMin: 3, safeMax: 15,
                                    warnLow: 'Below 3%: rapid account cycling from same IP may trigger Google scrutiny',
                                    warnHigh: 'Above 15%: single account quota drains heavily before rotation'
                                },
                                {
                                    id: 'reqCap',
                                    label: 'Fallback Request Cap',
                                    unit: 'reqs',
                                    desc: 'Rotates account after this many requests if quota telemetry delayed',
                                    min: 5, max: 200, step: 5,
                                    safeMin: 10, safeMax: 50,
                                    warnLow: 'Below 10 reqs: switches accounts excessively during slow telemetry',
                                    warnHigh: 'Above 50 reqs: risk of depleting account quota before switching'
                                },
                                {
                                    id: 'cooldown',
                                    label: 'Switch Delay Cooldown',
                                    unit: 'ms',
                                    desc: 'Cooldown delay in milliseconds before switching account on error',
                                    min: 500, max: 30000, step: 500,
                                    safeMin: 2000, safeMax: 10000,
                                    warnLow: 'Below 2000ms: rapid failovers may trigger Google rate limit firewalls',
                                    warnHigh: 'Above 10000ms: sluggish error recovery time for user requests'
                                },
                                {
                                    id: 'port',
                                    label: 'Proxy Listen Port',
                                    unit: '',
                                    desc: 'Local HTTP proxy listen port (requires proxy restart to take effect)',
                                    min: 1024, max: 65535, step: 1,
                                    safeMin: 1024, safeMax: 65535,
                                    warnLow: 'Ports below 1024 require root/administrator privileges',
                                    warnHigh: 'Port number out of valid TCP range'
                                },
                                {
                                    id: 'reset',
                                    label: 'Reset All to Defaults',
                                    unit: '',
                                    desc: 'Restore recommended safe defaults (5% quota, 20 requests, 5000ms cooldown)'
                                },
                                {
                                    id: 'save',
                                    label: 'Save & Return to Dashboard',
                                    unit: '',
                                    desc: 'Save all parameters to ~/.config/atc/config.json'
                                }
                            ];

                            function getValNum(idx) {
                                if (idx === 0) return thresholdPct;
                                if (idx === 1) return reqCap;
                                if (idx === 2) return cooldown;
                                if (idx === 3) return proxyPort;
                                return 0;
                            }

                            function setValNum(idx, num) {
                                const meta = settingsMeta[idx];
                                const clamped = Math.max(meta.min, Math.min(meta.max, num));
                                if (idx === 0) thresholdPct = clamped;
                                else if (idx === 1) reqCap = clamped;
                                else if (idx === 2) cooldown = clamped;
                                else if (idx === 3) proxyPort = clamped;
                            }

                            function getWarning(idx) {
                                if (idx >= 4) return null;
                                const meta = settingsMeta[idx];
                                const val = getValNum(idx);
                                if (val < meta.safeMin) return meta.warnLow;
                                if (val > meta.safeMax) return meta.warnHigh;
                                return null;
                            }

                            function getDisplayVal(idx) {
                                if (idx === 0) return thresholdPct + '%';
                                if (idx === 1) return reqCap + ' reqs';
                                if (idx === 2) return cooldown + 'ms';
                                if (idx === 3) return proxyPort.toString();
                                return '';
                            }

                            function renderScreen() {
                                let out = c.clearScreen + c.cursorHome;
                                out += `${c.brandGreen}╭─────────────────────────────────────────────────────────────────╮${c.reset}\n`;
                                out += `${c.brandGreen}│  atc Engine Settings & Parameters                               │${c.reset}\n`;
                                out += `${c.brandGreen}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n\n`;

                                for (let i = 0; i < settingsMeta.length; i++) {
                                    const meta = settingsMeta[i];
                                    const isSel = i === activeSettingIdx;
                                    const pointer = isSel ? `\x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;
                                    const warn = getWarning(i);

                                    let line = '';
                                    if (i < 4) {
                                        let valBox = '';
                                        if (isSel && isFocusEditing) {
                                            // Focus / Editing Mode indicator
                                            valBox = `\x1b[1;38;5;226;48;5;236m[ ${editBuffer || '0'}_ ]\x1b[0m \x1b[38;5;220m✎ editing\x1b[0m`;
                                        } else {
                                            const displayStr = getDisplayVal(i);
                                            valBox = isSel
                                                ? `\x1b[1;38;5;120m[${displayStr}]\x1b[0m`
                                                : `\x1b[38;5;147m[${displayStr}]\x1b[0m`;
                                        }

                                        // Subtle non-emoji threshold warning indicator
                                        let warnBadge = '';
                                        if (warn) {
                                            warnBadge = ` \x1b[38;5;214m▲ outside safe zone\x1b[0m`;
                                        }

                                        line = isSel
                                            ? `\x1b[1;38;5;255m${meta.label}:\x1b[0m ${valBox}${warnBadge}`
                                            : `\x1b[38;5;250m${meta.label}:\x1b[0m ${valBox}${warnBadge}`;
                                    } else {
                                        line = isSel
                                            ? `\x1b[1;38;5;255m${meta.label}${c.reset}`
                                            : `\x1b[38;5;248m${meta.label}${c.reset}`;
                                    }

                                    out += `${pointer}${line}${c.clearToEndOfLine}\n`;
                                }

                                out += `\n`;
                                const curMeta = settingsMeta[activeSettingIdx];
                                const activeWarn = getWarning(activeSettingIdx);

                                if (notice) {
                                    out += `\x1b[38;5;153m› ${notice}${c.reset}${c.clearToEndOfLine}\n`;
                                } else if (activeWarn) {
                                    out += `${c.textMuted}Details:${c.reset} \x1b[1;38;5;214m▲ ${activeWarn}${c.reset}${c.clearToEndOfLine}\n`;
                                } else {
                                    out += `${c.textMuted}Details:${c.reset} ${c.textNormal}${curMeta.desc}${c.reset}${c.clearToEndOfLine}\n`;
                                }

                                if (isFocusEditing) {
                                    out += `${c.textMuted}0-9 Type Value | ←→ Adjust | Backspace Delete | Enter/ESC Confirm${c.reset}${c.clearToEndOfLine}`;
                                } else {
                                    out += `${c.textMuted}↑↓ Move | Enter Focus to Edit | ←→ Quick Step | ESC Return${c.reset}${c.clearToEndOfLine}`;
                                }

                                process.stdout.write(out);
                            }

                            await new Promise((resolve) => {
                                if (process.stdin.isTTY) process.stdin.setRawMode(true);
                                readline.emitKeypressEvents(process.stdin);

                                function onKey(str, key) {
                                    if (!key) return;

                                    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                                        if (isFocusEditing) {
                                            // Finish focus editing
                                            if (editBuffer) {
                                                const parsed = parseInt(editBuffer, 10);
                                                if (!isNaN(parsed)) setValNum(activeSettingIdx, parsed);
                                            }
                                            isFocusEditing = false;
                                            editBuffer = '';
                                            renderScreen();
                                            return;
                                        }

                                        // Exit screen and save
                                        const accSel = { ...(config.accountSelection || {}), stepThreshold: thresholdPct / 100, requestThreshold: reqCap };
                                        saveConfig({ accountSelection: accSel, switchAccountDelayMs: cooldown, port: proxyPort });
                                        cleanup();
                                        resolve();
                                        return;
                                    }

                                    // Mode 1: In Focus Editing Mode
                                    if (isFocusEditing) {
                                        if (key.name === 'return' || key.name === 'enter') {
                                            if (editBuffer) {
                                                const parsed = parseInt(editBuffer, 10);
                                                if (!isNaN(parsed)) setValNum(activeSettingIdx, parsed);
                                            }
                                            isFocusEditing = false;
                                            editBuffer = '';
                                            notice = `Updated ${settingsMeta[activeSettingIdx].label} to ${getDisplayVal(activeSettingIdx)}`;
                                            renderScreen();
                                            return;
                                        }

                                        if (key.name === 'backspace') {
                                            editBuffer = editBuffer.slice(0, -1);
                                            renderScreen();
                                            return;
                                        }

                                        if (/^[0-9]$/.test(str)) {
                                            if (editBuffer.length < 5) {
                                                editBuffer += str;
                                            }
                                            renderScreen();
                                            return;
                                        }

                                        if (key.name === 'left') {
                                            let current = parseInt(editBuffer, 10);
                                            if (isNaN(current)) current = getValNum(activeSettingIdx);
                                            const step = settingsMeta[activeSettingIdx].step;
                                            const updated = Math.max(settingsMeta[activeSettingIdx].min, current - step);
                                            editBuffer = updated.toString();
                                            renderScreen();
                                            return;
                                        }

                                        if (key.name === 'right') {
                                            let current = parseInt(editBuffer, 10);
                                            if (isNaN(current)) current = getValNum(activeSettingIdx);
                                            const step = settingsMeta[activeSettingIdx].step;
                                            const updated = Math.min(settingsMeta[activeSettingIdx].max, current + step);
                                            editBuffer = updated.toString();
                                            renderScreen();
                                            return;
                                        }
                                        return;
                                    }

                                    // Mode 2: Normal Navigation Mode
                                    if (key.name === 'up' || key.name === 'k') {
                                        notice = '';
                                        activeSettingIdx = (activeSettingIdx - 1 + settingsMeta.length) % settingsMeta.length;
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'down' || key.name === 'j') {
                                        notice = '';
                                        activeSettingIdx = (activeSettingIdx + 1) % settingsMeta.length;
                                        renderScreen();
                                        return;
                                    }

                                    // Quick Adjust with Left / Right
                                    if (key.name === 'left' && activeSettingIdx < 4) {
                                        notice = '';
                                        const meta = settingsMeta[activeSettingIdx];
                                        const cur = getValNum(activeSettingIdx);
                                        const next = Math.max(meta.min, cur - meta.step);
                                        setValNum(activeSettingIdx, next);
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'right' && activeSettingIdx < 4) {
                                        notice = '';
                                        const meta = settingsMeta[activeSettingIdx];
                                        const cur = getValNum(activeSettingIdx);
                                        const next = Math.min(meta.max, cur + meta.step);
                                        setValNum(activeSettingIdx, next);
                                        renderScreen();
                                        return;
                                    }

                                    // Enter Selection
                                    if (key.name === 'return' || key.name === 'enter') {
                                        notice = '';
                                        if (activeSettingIdx < 4) {
                                            // Focus into editing mode
                                            isFocusEditing = true;
                                            editBuffer = getValNum(activeSettingIdx).toString();
                                            renderScreen();
                                            return;
                                        }

                                        if (activeSettingIdx === 4) {
                                            // Reset to safe defaults
                                            thresholdPct = 5;
                                            reqCap = 20;
                                            cooldown = 5000;
                                            notice = 'Reset all settings to recommended safe defaults (5% quota, 20 reqs, 5000ms delay)';
                                            renderScreen();
                                            return;
                                        }

                                        if (activeSettingIdx === 5) {
                                            // Save and return
                                            const accSel = { ...(config.accountSelection || {}), stepThreshold: thresholdPct / 100, requestThreshold: reqCap };
                                            saveConfig({ accountSelection: accSel, switchAccountDelayMs: cooldown, port: proxyPort });
                                            cleanup();
                                            resolve();
                                            return;
                                        }
                                    }
                                }

                                function cleanup() {
                                    process.stdin.removeListener('keypress', onKey);
                                }

                                process.stdin.on('keypress', onKey);
                                renderScreen();
                            });

                            setStatus(`Saved Engine Settings: ${thresholdPct}% quota, ${reqCap} req cap.`, 2000);
                        });
                        return;
                    }

                    if (cur.id === 'add_account') {
                        await runSubScreen(async () => {
                            await loginAccount();
                            console.log(`\n${c.actionGreen}✓ Automatically returning to dashboard in 1.5s...${c.reset}`);
                            await new Promise(r => setTimeout(r, 1500));
                            setStatus('Account login completed.', 2000);
                        });
                        return;
                    }
                }
            }

            // Keyboard Shortcuts
            if (key.name === 'v') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    const acc = cur.account;
                    if (acc.verifyUrl) {
                        try {
                            const { exec } = await import('child_process');
                            const startCmd = process.platform === 'win32' ? `start "" "${acc.verifyUrl}"` : `open "${acc.verifyUrl}"`;
                            exec(startCmd);
                            setStatus(`Opened verification link for Account ${cur.accountIndex + 1}.`, 2000);
                        } catch {
                            setStatus('Could not open browser. Verify URL present in account.', 2000);
                        }
                    } else {
                        setStatus(`Account ${cur.accountIndex + 1} has no pending Google verification link.`, 2000);
                    }
                }
                return;
            }

            if (key.name === 'r') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    const accNum = cur.accountIndex + 1;
                    await runSubScreen(async () => {
                        console.log(`${c.actionGreen}Re-authenticating Account ${accNum} (${cur.account.email})...${c.reset}\n`);
                        await loginAccount();
                        console.log(`\n${c.actionGreen}✓ Re-authentication finished. Returning in 1.5s...${c.reset}`);
                        await new Promise(r => setTimeout(r, 1500));
                        setStatus(`Account ${accNum} re-authentication completed.`, 2000);
                    });
                }
                return;
            }

            if (key.name === 't') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    const accNum = cur.accountIndex + 1;
                    const newStatus = await toggleAccount(accNum.toString());
                    setStatus(`Toggled Account ${accNum}: ${newStatus}.`, 2000);
                    await refreshData();
                    items = getItems();
                    render();
                }
                return;
            }

            if (key.name === 'd') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    const accNum = cur.accountIndex + 1;
                    await runSubScreen(async () => {
                        console.log(`${c.statusDanger}Are you sure you want to delete Account ${accNum} (${cur.account.email})?${c.reset}`);
                        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                        const confirm = await new Promise(r => rl.question('Type "yes" to confirm deletion: ', r));
                        rl.close();
                        if (confirm.trim().toLowerCase() === 'yes') {
                            await deleteAccount(accNum.toString());
                            console.log(`\n${c.actionGreen}✓ Account deleted. Returning to dashboard in 1.5s...${c.reset}`);
                            await new Promise(r => setTimeout(r, 1500));
                            setStatus(`Deleted Account ${accNum}.`, 2000);
                        } else {
                            setStatus('Account deletion cancelled.', 2000);
                        }
                    });
                }
                return;
            }
        }

        process.stdin.on('keypress', onKeypress);
    });
}


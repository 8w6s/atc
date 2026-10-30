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
        { id: 'pipelined', label: `Pipelined ${thresholdPct}%`, desc: `Rotates every ${thresholdPct}% quota to stagger 5h recovery windows in parallel` },
        { id: 'hybrid', label: 'Hybrid (Smart)', desc: 'Smart scoring combining health, token bucket, and quota' },
        { id: 'round-robin', label: 'Round-Robin', desc: 'Even rotation per-request across all available accounts' },
        { id: 'sticky', label: 'Sticky (Cache)', desc: 'Keeps using current account to maximize prompt caching' }
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
                            console.log(`${c.brandGreen}╭─────────────────────────────────────────────────────────────────╮${c.reset}`);
                            console.log(`${c.brandGreen}│  Custom GCP Project Configuration                               │${c.reset}`);
                            console.log(`${c.brandGreen}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n`);

                            console.log(`Current GCP Project ID: ${c.activeBright}${config?.customProjectId || '(not set - using default auto project)'}${c.reset}\n`);
                            console.log('Set a custom GCP project to route Gemini API calls with your own Cloud Project.');
                            console.log('Leave empty or type "clear" to revert to default automatic project.\n');

                            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                            const answer = await new Promise(r => rl.question('Enter custom GCP Project ID or press Enter to keep current: ', r));
                            rl.close();

                            const trimmed = answer.trim();
                            if (trimmed.length > 0) {
                                if (trimmed.toLowerCase() === 'clear' || trimmed.toLowerCase() === 'reset' || trimmed.toLowerCase() === 'none') {
                                    const nextConfig = { ...config };
                                    delete nextConfig.customProjectId;
                                    saveConfig(nextConfig);
                                    console.log(`\n${c.actionGreen}✓ Cleared custom project ID. Returning to dashboard in 1.5s...${c.reset}`);
                                    await new Promise(r => setTimeout(r, 1500));
                                    setStatus('Reset GCP Project ID to default.', 2000);
                                } else {
                                    saveConfig({ customProjectId: trimmed });
                                    console.log(`\n${c.actionGreen}✓ Saved custom GCP Project: ${trimmed}. Returning to dashboard in 1.5s...${c.reset}`);
                                    await new Promise(r => setTimeout(r, 1500));
                                    setStatus(`Saved custom GCP project: ${trimmed}.`, 2000);
                                }
                            }
                        });
                        return;
                    }

                    if (cur.id === 'model_mapping') {
                        await runSubScreen(async () => {
                            console.log(`${c.brandGreen}╭─────────────────────────────────────────────────────────────────╮${c.reset}`);
                            console.log(`${c.brandGreen}│  Model Mappings                                                 │${c.reset}`);
                            console.log(`${c.brandGreen}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n`);

                            const claudeSettings = readClaudeSettings();
                            const cEnv = claudeSettings.env || {};
                            const mm = config.modelMapping || {};

                            const mainModel = cEnv.ANTHROPIC_MODEL || '';
                            const subagentModel = cEnv.CLAUDE_CODE_SUBAGENT_MODEL || '';
                            const opusModel = cEnv.ANTHROPIC_DEFAULT_OPUS_MODEL || cEnv.ANTHROPIC_CLAUDE_OPUS_MODEL || '';
                            const sonnetModel = cEnv.ANTHROPIC_DEFAULT_SONNET_MODEL || cEnv.ANTHROPIC_CLAUDE_SONNET_MODEL || '';
                            const haikuModel = cEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL || '';

                            console.log(`Current Claude Code Model Environment Variables (${c.textDark}~/.claude/settings.json${c.reset}):\n`);
                            console.log(`  1. Main Model (ANTHROPIC_MODEL):             ${mainModel ? `${c.activeBright}${mainModel}${c.reset} -> ${c.actionGreen}${getMappingTarget(mm, mainModel)}${c.reset}` : `${c.textMuted}(not set - uses default)${c.reset}`}`);
                            console.log(`  2. Subagent Model (CLAUDE_CODE_SUBAGENT):    ${subagentModel ? `${c.activeBright}${subagentModel}${c.reset} -> ${c.actionGreen}${getMappingTarget(mm, subagentModel)}${c.reset}` : `${c.textMuted}(not set - falls back to haiku)${c.reset}`}`);
                            console.log(`  3. Opus Override (ANTHROPIC_DEFAULT_OPUS):   ${opusModel ? `${c.activeBright}${opusModel}${c.reset} -> ${c.actionGreen}${getMappingTarget(mm, opusModel)}${c.reset}` : `${c.textMuted}(not set)${c.reset}`}`);
                            console.log(`  4. Sonnet Override (ANTHROPIC_DEFAULT_SONNET): ${sonnetModel ? `${c.activeBright}${sonnetModel}${c.reset} -> ${c.actionGreen}${getMappingTarget(mm, sonnetModel)}${c.reset}` : `${c.textMuted}(not set)${c.reset}`}`);
                            console.log(`  5. Haiku Override (ANTHROPIC_DEFAULT_HAIKU):  ${haikuModel ? `${c.activeBright}${haikuModel}${c.reset} -> ${c.actionGreen}${getMappingTarget(mm, haikuModel)}${c.reset}` : `${c.textMuted}(not set)${c.reset}`}\n`);

                            console.log('Options:');
                            console.log('  [1] Max Performance Preset (Sonnet/Opus -> Flash-High, Subagent/Haiku -> Flash-Lite)');
                            console.log('  [2] Balanced Preset        (Opus -> Flash-High, Sonnet -> Flash-Medium, Subagent/Haiku -> Flash-Lite)');
                            console.log('  [3] Quality Preset         (All models -> Gemini 3.8 Pro)');
                            console.log('  [4] Edit Variable [1-5]    (Enter variable number to update or leave blank to delete)');
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
                                writeClaudeSettings(claudeSettings);

                                const newMm = { ...(config.modelMapping || {}) };
                                newMm['claude-opus-5-5'] = { mapping: 'gemini-3.8-flash-high' };
                                newMm['claude-sonnet-5-5'] = { mapping: 'gemini-3.8-flash-high' };
                                newMm['claude-haiku-5-5'] = { mapping: 'gemini-3.1-flash-lite' };
                                saveConfig({ modelMapping: newMm });
                                console.log(`\n${c.actionGreen}✓ Applied Max Performance preset. Returning in 1.5s...${c.reset}`);
                                await new Promise(r => setTimeout(r, 1500));
                                setStatus('Applied Preset: Max Performance models in Claude Code.', 2000);
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
                                console.log(`\n${c.actionGreen}✓ Applied Balanced preset. Returning in 1.5s...${c.reset}`);
                                await new Promise(r => setTimeout(r, 1500));
                                setStatus('Applied Preset: Balanced models in Claude Code.', 2000);
                            } else if (opt === '3') {
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
                                console.log(`\n${c.actionGreen}✓ Applied Quality preset. Returning in 1.5s...${c.reset}`);
                                await new Promise(r => setTimeout(r, 1500));
                                setStatus('Applied Preset: Gemini 3.8 Pro in Claude Code.', 2000);
                            } else if (opt === '4') {
                                const varIndex = await new Promise(r => rl.question('Enter variable number to configure [1-5]: ', r));
                                const keyMap = {
                                    '1': 'ANTHROPIC_MODEL',
                                    '2': 'CLAUDE_CODE_SUBAGENT_MODEL',
                                    '3': 'ANTHROPIC_DEFAULT_OPUS_MODEL',
                                    '4': 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                                    '5': 'ANTHROPIC_DEFAULT_HAIKU_MODEL'
                                };
                                const selectedKey = keyMap[varIndex.trim()];
                                if (selectedKey) {
                                    const currentVal = cEnv[selectedKey] || '';
                                    console.log(`\nEditing ${selectedKey} (current: ${currentVal || 'not set'})`);
                                    console.log('Enter custom model ID, or leave blank to delete env:');
                                    const newVal = await new Promise(r => rl.question('> ', r));
                                    const trimmed = newVal.trim();
                                    claudeSettings.env = claudeSettings.env || {};
                                    if (trimmed.length > 0 && trimmed.toLowerCase() !== 'clear' && trimmed.toLowerCase() !== 'delete' && trimmed.toLowerCase() !== 'none') {
                                        claudeSettings.env[selectedKey] = trimmed;
                                        writeClaudeSettings(claudeSettings);
                                        console.log(`\n${c.actionGreen}✓ Updated ${selectedKey} = ${trimmed}. Returning in 1.5s...${c.reset}`);
                                        await new Promise(r => setTimeout(r, 1500));
                                        setStatus(`Updated ${selectedKey} = ${trimmed}.`, 2000);
                                    } else {
                                        delete claudeSettings.env[selectedKey];
                                        writeClaudeSettings(claudeSettings);
                                        console.log(`\n${c.actionGreen}✓ Deleted ${selectedKey} from settings.json. Returning in 1.5s...${c.reset}`);
                                        await new Promise(r => setTimeout(r, 1500));
                                        setStatus(`Deleted ${selectedKey} from settings.json.`, 2000);
                                    }
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
                                console.log(`\n${c.actionGreen}✓ Removed all custom model env variables. Returning in 1.5s...${c.reset}`);
                                await new Promise(r => setTimeout(r, 1500));
                                setStatus('Cleaned all model environment variables from settings.json.', 2000);
                            }
                            rl.close();
                        });
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
                        setStatus(`Switched to best account: Account ${bestIdx}.`, 2000);
                        await switchAccount(bestIdx.toString());
                        await refreshData();
                        items = getItems();
                        render();
                        return;
                    }

                    if (cur.id === 'check_problem') {
                        await runSubScreen(async () => {
                            console.log(`${c.brandGreen}╭─────────────────────────────────────────────────────────────────╮${c.reset}`);
                            console.log(`${c.brandGreen}│  Problem Accounts Diagnostics & Resolution                      │${c.reset}`);
                            console.log(`${c.brandGreen}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n`);

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

                            if (problems.length === 0) {
                                console.log(`${c.actionGreen}✨ All accounts are 100% healthy and ready in pool!${c.reset}`);
                                console.log(`   • ${accountsData.accounts.length} active accounts monitored with zero rate limits or errors.`);
                                console.log(`\n${c.textMuted}Press Enter to return to Dashboard...${c.reset}`);
                                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                                await new Promise(r => rl.once('line', r));
                                rl.close();
                                return;
                            }

                            console.log(`Found ${c.statusDanger}${problems.length} account(s)${c.reset} requiring attention:\n`);
                            problems.forEach((p, idx) => {
                                console.log(`${c.bold}${idx + 1}. Account ${p.index}: ${p.account.email}${c.reset}`);
                                if (p.hasVerifyUrl) {
                                    console.log(`   • Issue:  ${c.statusDanger}Google Security Checkpoint / Validation Required${c.reset}`);
                                    console.log(`   • Fix:    Press ${c.bold}V${c.reset} on Dashboard to open Google Verification link in browser.`);
                                } else if (p.isInvalid) {
                                    console.log(`   • Issue:  ${c.statusDanger}Credentials Invalid / Expired (${p.account.invalidReason || 'Auth Error'})${c.reset}`);
                                    console.log(`   • Fix:    Press ${c.bold}R${c.reset} on Dashboard to re-authenticate via OAuth.`);
                                } else if (p.isLimited) {
                                    console.log(`   • Issue:  ${c.statusWarn}Rate Limited / Quota Exhausted${c.reset}`);
                                    console.log(`   • Fix:    Account is cooling down. Proxy will auto-recover when quota resets.`);
                                } else if (p.isDisabled) {
                                    console.log(`   • Issue:  ${c.textMuted}Manually Disabled${c.reset}`);
                                    console.log(`   • Fix:    Press ${c.bold}T${c.reset} on Dashboard to re-enable account in pool.`);
                                }
                                console.log('');
                            });

                            console.log(`${c.textMuted}Press Enter to return to Dashboard...${c.reset}`);
                            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                            await new Promise(r => rl.once('line', r));
                            rl.close();
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
                            let editBuffer = '';
                            let isEditing = false;
                            let notice = '';

                            const settingsItems = [
                                { id: 'threshold', label: 'Quota Rotation Threshold', unit: '%', desc: 'Rotates account after consuming this quota %', min: 1, max: 100, step: 1 },
                                { id: 'reqCap', label: 'Fallback Request Cap', unit: 'reqs', desc: 'Rotates account after this many requests if quota delayed', min: 1, max: 500, step: 5 },
                                { id: 'cooldown', label: 'Switch Delay Cooldown', unit: 'ms', desc: 'Delay cooldown before switching account on error', min: 500, max: 60000, step: 500 },
                                { id: 'port', label: 'Proxy Listen Port', unit: '', desc: 'Local HTTP port (requires proxy restart to apply)', min: 1024, max: 65535, step: 1 },
                                { id: 'reset', label: '↺  Reset All to Defaults', desc: 'Restore defaults: 5% threshold, 20 reqs, 5000ms delay' },
                                { id: 'save', label: '✓  Save & Return to Dashboard', desc: 'Write changes to ~/.config/antigravity-proxy/config.json' }
                            ];

                            function getSettingVal(idx) {
                                if (idx === 0) return thresholdPct;
                                if (idx === 1) return reqCap;
                                if (idx === 2) return cooldown;
                                if (idx === 3) return proxyPort;
                                return '';
                            }

                            function setSettingVal(idx, val) {
                                if (idx === 0) thresholdPct = val;
                                else if (idx === 1) reqCap = val;
                                else if (idx === 2) cooldown = val;
                                else if (idx === 3) proxyPort = val;
                            }

                            function renderSettingsScreen() {
                                let out = c.clearScreen + c.cursorHome;
                                out += `${c.brandGreen}╭─────────────────────────────────────────────────────────────────╮${c.reset}\n`;
                                out += `${c.brandGreen}│  atc Engine Settings & Configuration (In-Place Editor)          │${c.reset}\n`;
                                out += `${c.brandGreen}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n\n`;

                                out += `${c.textMuted}Config file: ~/.config/antigravity-proxy/config.json${c.reset}\n\n`;

                                for (let i = 0; i < settingsItems.length; i++) {
                                    const item = settingsItems[i];
                                    const isSel = i === activeSettingIdx;
                                    const pointer = isSel ? `[1;38;5;48m> ` : `  [38;5;240m· `;

                                    if (item.id === 'reset' || item.id === 'save') {
                                        out += `\n`;
                                        if (isSel) {
                                            out += `${pointer}[1;38;5;255;48;5;236m ${item.label} ${c.reset}  ${c.textMuted}${item.desc}${c.reset}\n`;
                                        } else {
                                            out += `${pointer}[38;5;248m${item.label}${c.reset}\n`;
                                        }
                                        continue;
                                    }

                                    const currentVal = isSel && isEditing ? editBuffer : getSettingVal(i);
                                    const valBox = isSel
                                        ? `[1;38;5;120m[ [48;5;236m${currentVal}[0;1;38;5;120m ][0m ${c.bold}${item.unit}${c.reset}`
                                        : `[38;5;250m[ ${currentVal} ] ${item.unit}[0m`;

                                    const labelPad = item.label.padEnd(28, ' ');
                                    out += `${pointer}${isSel ? c.bold : ''}${labelPad}${c.reset} ${valBox}  ${c.textMuted}(${item.desc})${c.reset}\n`;
                                }

                                out += `\n`;
                                if (notice) {
                                    out += `${c.statusWarn}ℹ ${notice}${c.reset}\n\n`;
                                } else {
                                    out += `\n`;
                                }

                                out += `${c.textMuted}───────────────────────────────────────────────────────────────────${c.reset}\n`;
                                out += `${c.textMuted}↑↓ Scroll | ←→ Adjust | 0-9 Type | Backspace Delete | Enter Next/Save | ESC Return${c.reset}`;
                                process.stdout.write(out);
                            }

                            await new Promise((resolve) => {
                                if (process.stdin.isTTY) process.stdin.setRawMode(true);
                                readline.emitKeypressEvents(process.stdin);

                                function onSettingKey(str, key) {
                                    if (!key) return;

                                    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                                        // Save and return
                                        const accSel = { ...(config.accountSelection || {}), stepThreshold: thresholdPct / 100, requestThreshold: reqCap };
                                        saveConfig({ accountSelection: accSel, switchAccountDelayMs: cooldown, port: proxyPort });
                                        cleanup();
                                        resolve();
                                        return;
                                    }

                                    if (key.name === 'up' || key.name === 'k') {
                                        isEditing = false;
                                        editBuffer = '';
                                        notice = '';
                                        activeSettingIdx = (activeSettingIdx - 1 + settingsItems.length) % settingsItems.length;
                                        renderSettingsScreen();
                                        return;
                                    }

                                    if (key.name === 'down' || key.name === 'j') {
                                        isEditing = false;
                                        editBuffer = '';
                                        notice = '';
                                        activeSettingIdx = (activeSettingIdx + 1) % settingsItems.length;
                                        renderSettingsScreen();
                                        return;
                                    }

                                    // Left / Right adjustment
                                    if (key.name === 'left' && activeSettingIdx < 4) {
                                        isEditing = false;
                                        editBuffer = '';
                                        const item = settingsItems[activeSettingIdx];
                                        const curVal = getSettingVal(activeSettingIdx);
                                        const newVal = Math.max(item.min, curVal - item.step);
                                        setSettingVal(activeSettingIdx, newVal);
                                        notice = `Adjusted ${item.label} to ${newVal}${item.unit}`;
                                        renderSettingsScreen();
                                        return;
                                    }

                                    if (key.name === 'right' && activeSettingIdx < 4) {
                                        isEditing = false;
                                        editBuffer = '';
                                        const item = settingsItems[activeSettingIdx];
                                        const curVal = getSettingVal(activeSettingIdx);
                                        const newVal = Math.min(item.max, curVal + item.step);
                                        setSettingVal(activeSettingIdx, newVal);
                                        notice = `Adjusted ${item.label} to ${newVal}${item.unit}`;
                                        renderSettingsScreen();
                                        return;
                                    }

                                    // Numeric direct typing
                                    if (/^[0-9]$/.test(str) && activeSettingIdx < 4) {
                                        if (!isEditing) {
                                            isEditing = true;
                                            editBuffer = str;
                                        } else {
                                            editBuffer += str;
                                        }
                                        const parsed = parseInt(editBuffer, 10);
                                        const item = settingsItems[activeSettingIdx];
                                        if (!isNaN(parsed) && parsed <= item.max) {
                                            setSettingVal(activeSettingIdx, parsed);
                                        }
                                        renderSettingsScreen();
                                        return;
                                    }

                                    // Backspace deletion
                                    if (key.name === 'backspace' && activeSettingIdx < 4) {
                                        if (!isEditing) {
                                            isEditing = true;
                                            editBuffer = getSettingVal(activeSettingIdx).toString();
                                        }
                                        editBuffer = editBuffer.slice(0, -1);
                                        const parsed = parseInt(editBuffer, 10) || settingsItems[activeSettingIdx].min;
                                        setSettingVal(activeSettingIdx, parsed);
                                        renderSettingsScreen();
                                        return;
                                    }

                                    // Enter handling
                                    if (key.name === 'return' || key.name === 'enter') {
                                        isEditing = false;
                                        editBuffer = '';
                                        if (activeSettingIdx === 4) {
                                            // Reset to defaults
                                            thresholdPct = 5;
                                            reqCap = 20;
                                            cooldown = 5000;
                                            notice = 'Reset all settings to recommended defaults (5% quota, 20 requests).';
                                            renderSettingsScreen();
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

                                        // Move to next setting
                                        activeSettingIdx = (activeSettingIdx + 1) % settingsItems.length;
                                        renderSettingsScreen();
                                        return;
                                    }
                                }

                                function cleanup() {
                                    process.stdin.removeListener('keypress', onSettingKey);
                                }

                                process.stdin.on('keypress', onSettingKey);
                                renderSettingsScreen();
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


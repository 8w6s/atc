import readline from 'readline';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { loadAccounts, saveAccounts } from '../account-manager/storage.js';
import { config, saveConfig, reloadConfig } from '../config.js';
import { getPackageVersion } from '../utils/helpers.js';
import { renderRoundedBox, padEndVisible, truncateVisible } from '../utils/terminal-box.js';
import { syncClaudeDesktopIntegration } from '../utils/claude-config.js';
import { SAFETY_TIPS, getTipTickerFrame } from './tips.js';
import {
    normalizeCustomProfile,
    evaluateCustomProfileRisk,
    slugifyProfileId
} from '../account-manager/strategies/index.js';
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

function drawHeaderBox(titleText, innerWidth = 76) {
    return renderRoundedBox(`  \x1b[1;38;5;48m${titleText}\x1b[0m`, {
        innerWidth,
        borderColor: c.brandGreen,
        reset: c.reset,
        lineClear: c.clearToEndOfLine
    });
}

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

/**
 * Extract 5-hour quota and weekly quota metrics from models
 */
function getAccountQuotaSummary(models = {}) {
    let fiveHour = null;
    let weekly = null;
    const now = Date.now();

    for (const [mId, info] of Object.entries(models)) {
        if (!info || typeof info.remainingFraction !== 'number') continue;
        const pct = Math.round(info.remainingFraction * 100);
        const resetMs = info.resetTime ? Math.max(0, new Date(info.resetTime).getTime() - now) : 0;
        const isWeekly = resetMs > 24 * 3600 * 1000 || mId.toLowerCase().includes('argon') || mId.toLowerCase().includes('weekly');

        if (isWeekly) {
            if (!weekly || info.remainingFraction < weekly.remainingFraction) {
                weekly = { remainingPct: pct, remainingFraction: info.remainingFraction, resetMs, resetTime: info.resetTime, model: mId };
            }
        } else {
            if (!fiveHour || mId.includes('flash-high') || info.remainingFraction < fiveHour.remainingFraction) {
                fiveHour = { remainingPct: pct, remainingFraction: info.remainingFraction, resetMs, resetTime: info.resetTime, model: mId };
            }
        }
    }

    return { fiveHour, weekly };
}

function formatDisplayEmail(email) {
    const raw = String(email || '');
    if (!config?.maskEmails || !raw.includes('@')) return raw;
    const [local, domain] = raw.split('@');
    if (local.length <= 4) {
        return `${local[0] || '*'}***@${domain}`;
    }
    return `${local.slice(0, 2)}***${local.slice(-2)}@${domain}`;
}

function getTipBadgeStyle(badge) {
    const key = String(badge || '').toUpperCase();
    switch (key) {
        case 'ANTI-BAN':
            return '\x1b[1;38;5;16;48;5;214m'; // Bold black on vivid amber
        case 'SAFETY':
            return '\x1b[1;38;5;16;48;5;49m';  // Bold black on mint emerald
        case 'QUOTA':
            return '\x1b[1;38;5;16;48;5;75m';  // Bold black on sky blue
        case 'RECOVERY':
            return '\x1b[1;38;5;16;48;5;177m'; // Bold black on soft orchid
        default:
            return '\x1b[1;38;5;16;48;5;221m'; // Bold black on warm gold
    }
}

const FIXED_TIP_BADGE_WIDTH = Math.max(
    8,
    ...SAFETY_TIPS.map((t) => String(t.badge || 'TIP').length)
);

function getStrategyCycle() {
    const thresholdPct = Math.round((config?.accountSelection?.stepThreshold || 0.05) * 100);
    const builtIns = [
        {
            id: 'locked',
            label: 'Single-Account Lock',
            riskTag: 'safest',
            riskColor: '\x1b[1;38;5;49m',
            desc: 'Hard-pins 100% traffic to the active account; zero automatic multi-account hopping'
        },
        {
            id: 'day-split',
            label: 'Daily Primary + Standby',
            riskTag: 'low-risk',
            riskColor: '\x1b[38;5;120m',
            desc: 'Exposes at most 1 primary + 1 standby account per calendar day; keeps remaining accounts dormant'
        },
        {
            id: 'shift-split',
            label: 'Workday 2x12h Shift',
            riskTag: 'low-risk',
            riskColor: '\x1b[38;5;120m',
            desc: 'Splits day into 00:00–11:59 AM slot and 12:00–23:59 PM slot; single midday switch, max 2 accounts/day'
        },
        {
            id: 'session',
            label: 'Idle-Aware Session Shift',
            riskTag: 'low-risk',
            riskColor: '\x1b[38;5;120m',
            desc: 'Never switches mid-conversation; rotates only after ~45m work + natural idle gap between prompts'
        },
        {
            id: 'weekly-guard',
            label: 'Weekly-Cap Preserver',
            riskTag: 'low-risk',
            riskColor: '\x1b[38;5;120m',
            desc: 'Protects scarce weekly quotas (Gemini 4 Argon / Opus): holds >=15m blocks and preserves 20% weekly floor'
        },
        {
            id: 'sticky',
            label: 'Sticky Drain-to-Floor',
            riskTag: 'low-risk',
            riskColor: '\x1b[38;5;120m',
            desc: 'Stays on one account for hours until hitting Global 5h / Weekly Quota Floor or long rate-limit'
        },
        {
            id: 'warmup',
            label: 'Gradual Clone Warm-Up',
            riskTag: 'moderate',
            riskColor: '\x1b[38;5;220m',
            desc: 'Shields newly added clones (<48h old) with light 5-req warm-up drips while seasoned accounts carry load'
        },
        {
            id: 'pipelined',
            label: `Pipelined Quota Shift ${thresholdPct}%`,
            riskTag: 'moderate',
            riskColor: '\x1b[38;5;220m',
            desc: `Rotates after ${thresholdPct}% quota drop + min stay floor to stagger 5h recovery across separate plans`
        },
        {
            id: 'hybrid',
            label: 'Hybrid Smart Score',
            riskTag: 'elevated',
            riskColor: '\x1b[38;5;208m',
            desc: 'Scores health, token bucket, quota, and LRU; switches more frequently under heavy bursts'
        },
        {
            id: 'round-robin',
            label: 'Round-Robin',
            riskTag: 'high-risk',
            riskColor: '\x1b[1;38;5;196m',
            desc: 'Cycles accounts on EVERY single request from one IP — breaks prompt cache & looks automated'
        }
    ];

    const customList = Array.isArray(config?.customModes) ? config.customModes : [];
    const customs = customList.map((raw) => {
        const p = normalizeCustomProfile(raw);
        const risk = evaluateCustomProfileRisk(p);
        return {
            id: `custom:${p.id}`,
            label: p.name,
            isCustom: true,
            customProfile: p,
            riskTag: risk.riskTag,
            riskColor: risk.riskColor,
            desc: `${risk.summary} [Core: ${p.baseCore}, Max/Day: ${p.maxDailyAccounts || 'all'}, Stay: ${p.minStaySec}s]`
        };
    });

    return [...builtIns, ...customs];
}

function wrapPlainText(text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (words.length === 0) return [''];
    const lines = [];
    let cur = words[0];
    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (cur.length + 1 + w.length <= maxWidth) {
            cur += ' ' + w;
        } else {
            lines.push(cur);
            cur = w;
        }
    }
    if (cur) lines.push(cur);
    return lines;
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


// Brand-accurate gradient color palette and shimmer animation: atc (Antigravity to Claude)
const TITLE_CHARS = [
    { ch: 'a', r:  34, g: 197, b:  94 },
    { ch: 't', r:  45, g: 193, b: 171 },
    { ch: 'c', r:  56, g: 189, b: 248 },
    { ch: ' ', r: 255, g: 255, b: 255 },
    { ch: '(', r: 156, g: 163, b: 175 },
    { ch: 'A', r:  56, g: 189, b: 248 },
    { ch: 'n', r:  50, g: 191, b: 210 },
    { ch: 't', r:  45, g: 193, b: 171 },
    { ch: 'i', r:  40, g: 195, b: 132 },
    { ch: 'g', r:  34, g: 197, b:  94 },
    { ch: 'r', r: 134, g: 188, b:  51 },
    { ch: 'a', r: 234, g: 179, b:   8 },
    { ch: 'v', r: 242, g: 147, b:  15 },
    { ch: 'i', r: 249, g: 115, b:  22 },
    { ch: 't', r: 244, g:  92, b:  45 },
    { ch: 'y', r: 239, g:  68, b:  68 },
    { ch: ' ', r: 255, g: 255, b: 255 },
    { ch: 't', r: 255, g: 255, b: 255 },
    { ch: 'o', r: 255, g: 255, b: 255 },
    { ch: ' ', r: 255, g: 255, b: 255 },
    { ch: 'C', r: 249, g: 115, b:  22 },
    { ch: 'l', r: 249, g: 115, b:  22 },
    { ch: 'a', r: 249, g: 115, b:  22 },
    { ch: 'u', r: 249, g: 115, b:  22 },
    { ch: 'd', r: 250, g: 182, b:  21 },
    { ch: 'e', r: 250, g: 204, b:  21 },
    { ch: ')', r: 156, g: 163, b: 175 }
];

function getShimmerTitle() {
    const sweepMs = 3000; // 3 seconds sweep through the text
    const pauseMs = 5000; // 5 seconds wait after reaching the end
    const totalCycle = sweepMs + pauseMs; // 8000ms total
    const elapsed = Date.now() % totalCycle;

    // Respect Header Shimmer Effect setting while keeping static brand gradient
    const shimmerAllowed = config?.shimmerTitle !== false;
    const isSweeping = shimmerAllowed && elapsed < sweepMs;
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

export async function runInteractiveDashboard(options = {}) {
    let accountsData = await loadAccounts(ACCOUNT_CONFIG_PATH);
    let port = getProxyPort();

    let proxyHealth = null;
    let proxyLimits = null;
    let statusMessage = '';
    let statusTimer = null;
    let isSubScreenActive = false;
    let activeSubScreenRender = null;

    function setStatus(msg, durationMs = 2000) {
        statusMessage = msg;
        if (statusTimer) clearTimeout(statusTimer);
        if (!isSubScreenActive) render();
        if (durationMs > 0) {
            statusTimer = setTimeout(() => {
                statusMessage = '';
                if (!isSubScreenActive) render();
            }, durationMs);
        }
    }
    let currentStrategy = config?.accountSelection?.strategy || 'pipelined';
    const dashboardStartMs = Date.now();
    let tipsSessionOverride = null;
    let tipsVisible = config?.showTips !== false;
    let lastRenderedTipIdx = 0;

    async function refreshData(arg = false) {
        const forceLive = typeof arg === 'boolean' ? arg : !!arg?.forceLive;
        const showStatus = typeof arg === 'boolean' ? arg : !!arg?.showStatus;

        if (showStatus) {
            setStatus(forceLive ? 'Probing live quotas sequentially (anti-burst mode)...' : 'Reloading accounts & cached proxy state...', 0);
        }
        reloadConfig();
        port = getProxyPort();
        currentStrategy = config?.accountSelection?.strategy || 'pipelined';
        tipsVisible = tipsSessionOverride !== null ? tipsSessionOverride : (config?.showTips !== false);

        try {
            await fetch(`http://127.0.0.1:${port}/reload`, {
                method: 'POST',
                signal: AbortSignal.timeout(2000)
            });
        } catch {
            // daemon might be offline or busy
        }

        accountsData = await loadAccounts(ACCOUNT_CONFIG_PATH);
        const needsInitialSeed = accountsData.accounts.some(
            (acc) => acc.enabled !== false && !acc.isInvalid && (!acc.quota?.models || Object.keys(acc.quota.models).length === 0)
        );

        try {
            if (forceLive || needsInitialSeed) {
                const probeTimeoutMs = Math.max(12000, (accountsData.accounts.length + 1) * 3500);
                const limitsUrl = forceLive
                    ? `http://127.0.0.1:${port}/account-limits?refresh=true`
                    : `http://127.0.0.1:${port}/account-limits`;
                const limitsRes = await fetch(limitsUrl, { signal: AbortSignal.timeout(probeTimeoutMs) });
                if (limitsRes.ok) {
                    proxyLimits = await limitsRes.json();
                }
            }

            const healthRes = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
            if (healthRes.ok) {
                proxyHealth = await healthRes.json();
            } else {
                proxyHealth = null;
            }
        } catch {
            proxyHealth = null;
            if (forceLive) proxyLimits = null;
        }

        accountsData = await loadAccounts(ACCOUNT_CONFIG_PATH);

        if (showStatus) {
            const isOnline = !!proxyHealth;
            setStatus(isOnline ? '✓ Dashboard, proxy pool & live quotas reloaded.' : '✓ Reloaded from disk (Proxy daemon is offline).', 2000);
        }
    }

    await refreshData();

    function getItems() {
        const list = [];
        const stratCycle = getStrategyCycle();
        const effectiveStratId = config?.singleAccountLock ? 'locked' : currentStrategy;
        const stratObj = stratCycle.find(s => s.id === effectiveStratId) || stratCycle.find(s => s.id === 'pipelined') || stratCycle[0];
        const customProject = config?.customProjectId || 'Default (auto)';

        list.push({ type: 'header', label: 'Quick Actions' });
        list.push({ type: 'action', id: 'add_account', label: 'Add New Account', desc: 'Link a new Google account via OAuth browser' });
        const customTag = stratObj.isCustom ? `\x1b[38;5;141m[custom]\x1b[0m ` : '';
        list.push({
            type: 'action',
            id: 'lb_strategy',
            label: `Load Balancer: [${stratObj.label}]`,
            badgeStr: `${customTag}${stratObj.riskColor}[${stratObj.riskTag}]${c.reset}`,
            desc: `${stratObj.desc} (Enter to manage modes & custom profiles, ←/→ quick switch)`
        });
        list.push({ type: 'action', id: 'custom_project', label: `Custom GCP Project: [${customProject}]`, desc: 'Configure custom Google Cloud Project ID for quotas' });
        list.push({ type: 'action', id: 'model_mapping', label: 'Model Mappings', desc: 'Configure Claude Code models, subagents, and environment overrides' });
        list.push({ type: 'action', id: 'pick_best', label: 'Pick Best Account', desc: 'Automatically switch to healthiest account with highest quota' });
        list.push({ type: 'action', id: 'check_problem', label: 'Check Problem Accounts', desc: 'Inspect problem accounts with detailed diagnostics & quick fixes' });
        list.push({ type: 'action', id: 'engine_settings', label: 'Settings', desc: 'Configure quota thresholds, request caps, and proxy engine parameters' });
        list.push({ type: 'action', id: 'reload_dashboard', label: 'Reload & Refresh (Ctrl+R)', desc: 'Force clear terminal layers, probe live proxy quota, and redraw dashboard' });

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

    // Fixed-height, 0% flicker render function
    function render() {
        if (isSubScreenActive) return;
        let buf = c.hideCursor + c.disableWrap + c.cursorHome;

        // Header Title
        buf += `${getShimmerTitle()} ${c.textMuted}v${getPackageVersion()}${c.reset}${c.clearToEndOfLine}\n`;

        /*
         * High-contrast Safety & Operational Tip Ribbon.
         * Badge pill width and right action cap width are strictly constant across
         * all tips so viewportCols never changes between 2/4 and 3/4 — eliminating
         * schedule boundary oscillation / flicker.
         */
        if (tipsVisible && SAFETY_TIPS.length > 0) {
            const termCols = Math.max(72, Math.min(process.stdout.columns || 98, 118));
            const totalDigits = String(SAFETY_TIPS.length).length;
            const pillPlainLen = 3 + FIXED_TIP_BADGE_WIDTH + 1 + totalDigits + 1 + totalDigits + 1; // " ★ BADGE____ 1/4 "
            const capPlainLen = 22; // " Ctrl+D Info · X Hide "
            const viewportCols = Math.max(20, termCols - 2 - pillPlainLen - capPlainLen - 2);
            const frame = getTipTickerFrame(SAFETY_TIPS, Date.now() - dashboardStartMs, viewportCols, {
                speed: config?.tipsScrollSpeed || 'normal'
            });
            if (frame.tip) {
                lastRenderedTipIdx = frame.index;
                const paddedBadge = String(frame.tip.badge || 'TIP').padEnd(FIXED_TIP_BADGE_WIDTH, ' ');
                const idxStr = `${String(frame.index + 1).padStart(totalDigits, ' ')}/${SAFETY_TIPS.length}`;
                const pillStyle = getTipBadgeStyle(frame.tip.badge);
                const pillSeg = `${pillStyle} ★ ${paddedBadge} ${idxStr} \x1b[0m`;
                const isHighContrast = config?.tipsHighContrast !== false;
                const bodySeg = isHighContrast
                    ? `\x1b[1;38;5;255;48;5;17m ${frame.visibleText} \x1b[0m`
                    : `\x1b[38;5;230;48;5;236m ${frame.visibleText} \x1b[0m`;
                const capSeg = `\x1b[38;5;117;48;5;238m Ctrl+D\x1b[38;5;250;48;5;238m Info · \x1b[38;5;220;48;5;238mX\x1b[38;5;250;48;5;238m Hide \x1b[0m`;
                buf += `  ${pillSeg}${bodySeg}${capSeg}${c.clearToEndOfLine}\n`;
            }
        }

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
                    buf += `    \x1b[38;5;241mAccount / Email              Plan     5h-Cap  Weekly  Status      Active${c.reset}${c.clearToEndOfLine}\n`;
                }
                continue;
            }

            if (it.type === 'action') {
                let pointer = isSelected ? `  \x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;
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

                if (it.badgeStr) {
                    text += ` ${it.badgeStr}`;
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

                const isInvalid = acc.isInvalid || live.status === 'invalid' || live.status === 'banned' || live.status === 'verify-required';
                const hasVerifyUrl = !!(acc.verifyUrl || live.verifyUrl);
                const invalidReasonLower = (acc.invalidReason || live.error || '').toLowerCase();
                const isBanned = !hasVerifyUrl && (
                    live.status === 'banned' ||
                    invalidReasonLower.includes('tos') ||
                    invalidReasonLower.includes('banned') ||
                    invalidReasonLower.includes('suspended') ||
                    invalidReasonLower.includes('terms of service')
                );
                const isLimited = Object.values(acc.modelRateLimits || {}).some(
                    l => l.isRateLimited && l.resetTime > Date.now()
                ) || (live.rateLimitCooldownRemaining > 0);

                // Column 1: Account / Email padded to 28 chars
                const rawEmail = `${idx}. ${formatDisplayEmail(acc.email)}`;
                const paddedEmail = rawEmail.padEnd(28, ' ');
                const emailStr = isSelected
                    ? `${c.activeBright}${paddedEmail}${c.reset}`
                    : `${c.textNormal}${paddedEmail}${c.reset}`;

                // Column 2: Plan Badge padded to 8 chars
                const planTier = lim.subscription?.tier || acc.subscription?.tier || 'unknown';
                const planBadgeRawLen = planTier.length + 2; // e.g. [pro] is 5
                const planPad = ' '.repeat(Math.max(1, 8 - planBadgeRawLen));
                const planStr = formatPlanBadge(planTier) + planPad;

                // Column 3 & 4: 5h-Cap and Weekly Quota (strict 4-char formatted percentage + 4 spaces padding = 8 chars)
                const models = lim.limits || lim.models || acc.quota?.models || live.models || {};
                const qSummary = getAccountQuotaSummary(models);

                let fiveText = '100%';
                let fiveColor = '\x1b[38;5;120m';
                if (isInvalid) {
                    fiveText = '  --';
                    fiveColor = '\x1b[38;5;240m';
                } else if (qSummary.fiveHour) {
                    const p = qSummary.fiveHour.remainingPct;
                    fiveText = `${p}%`.padStart(4, ' ');
                    if (p === 0) fiveColor = '\x1b[1;31m';
                    else if (p < 20) fiveColor = '\x1b[38;5;214m';
                    else fiveColor = '\x1b[38;5;120m';
                }
                const fiveCol = `${fiveColor}${fiveText}\x1b[0m    `;

                let weekText = '100%';
                let weekColor = '\x1b[38;5;120m';
                if (isInvalid) {
                    weekText = '  --';
                    weekColor = '\x1b[38;5;240m';
                } else if (qSummary.weekly) {
                    const wp = qSummary.weekly.remainingPct;
                    weekText = `${wp}%`.padStart(4, ' ');
                    if (wp === 0) weekColor = '\x1b[1;31m';
                    else if (wp < 20) weekColor = '\x1b[38;5;214m';
                    else weekColor = '\x1b[38;5;120m';
                }
                const weekCol = `${weekColor}${weekText}\x1b[0m    `;

                // Column 5: Status Badge (strictly 12-char width)
                let statusLabel = '[ok]';
                let statusColor = c.statusOk;
                if (!acc.enabled) {
                    statusLabel = '[disabled]';
                    statusColor = c.statusMuted;
                } else if (hasVerifyUrl) {
                    statusLabel = '[verify-req]';
                    statusColor = c.statusDanger;
                } else if (isBanned) {
                    statusLabel = '[banned]';
                    statusColor = c.statusDanger;
                } else if (isInvalid) {
                    statusLabel = '[invalid]';
                    statusColor = c.statusDanger;
                } else if (isLimited || (qSummary.weekly && qSummary.weekly.remainingPct === 0)) {
                    statusLabel = '[rate-limit]';
                    statusColor = c.statusWarn;
                }
                const statusPad = ' '.repeat(Math.max(1, 12 - statusLabel.length));
                const statusStr = `${statusColor}${statusLabel}${c.reset}${statusPad}`;

                // Column 6: Role / Active tag
                const currentBadge = it.isCurrent ? ` ${c.statusCurrent}[current]${c.reset}` : '';

                let pointer = isSelected ? `  \x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;
                buf += `${pointer}${emailStr} ${planStr} ${fiveCol}${weekCol}${statusStr}${currentBadge}${c.clearToEndOfLine}\n`;

                if (isSelected) {
                    const timeAgo = formatTimeAgo(acc.lastUsed);

                    const fiveStr = qSummary.fiveHour
                        ? (qSummary.fiveHour.remainingPct === 0
                            ? `\x1b[1;31m5h: 0% (${qSummary.fiveHour.resetMs > 0 ? 'resets in ' + formatDuration(qSummary.fiveHour.resetMs) : 'exhausted'})\x1b[0m`
                            : `5h: ${qSummary.fiveHour.remainingPct}% (${qSummary.fiveHour.resetMs > 0 ? 'resets in ' + formatDuration(qSummary.fiveHour.resetMs) : 'ready'})`)
                        : '5h: ready';

                    const weekStr = qSummary.weekly
                        ? (qSummary.weekly.remainingPct === 0
                            ? `\x1b[1;31mWeekly: 0% [EXHAUSTED - resets in ${formatDuration(qSummary.weekly.resetMs)}]\x1b[0m`
                            : `Weekly: ${qSummary.weekly.remainingPct}% (resets in ${formatDuration(qSummary.weekly.resetMs)})`)
                        : 'Weekly: 100%';

                    if (hasVerifyUrl) {
                        detailsLine = `${c.textMuted}Details:${c.reset} ${timeAgo} ${c.textDark}|${c.reset} ${c.statusDanger}Google check needed - press [V] to verify in browser, or [Space] for Account Menu${c.reset}`;
                    } else if (isBanned) {
                        detailsLine = `${c.textMuted}Details:${c.reset} ${timeAgo} ${c.textDark}|${c.reset} ${c.statusDanger}ToS / service restricted by Google - auto-refresh locked${c.reset}`;
                    } else if (isInvalid) {
                        detailsLine = `${c.textMuted}Details:${c.reset} ${timeAgo} ${c.textDark}|${c.reset} ${c.statusDanger}Token invalid - press [R] to re-login, or [Space] for Account Menu${c.reset}`;
                    } else {
                        detailsLine = `${c.textMuted}Details:${c.reset} ${timeAgo} ${c.textDark}|${c.reset} ${fiveStr} ${c.textDark}|${c.reset} ${weekStr}`;
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

        /*
         * Fixed 2-line context-aware shortcut bar so account keys (Verify,
         * Re-login, Enable/Disable, Delete, Manage Menu) read as plain words
         * instead of cryptic "V/R/T/D Acct" abbreviations without shifting row count.
         */
        const termWidth = process.stdout.columns || 100;
        const fmtKey = (k, lbl) => `\x1b[38;5;252m[${k}]\x1b[0m \x1b[38;5;244m${lbl}\x1b[0m`;
        const sep = `\x1b[38;5;239m · \x1b[0m`;
        const selectedItem = items[selectedIndex];

        let contextBar = '';
        if (selectedItem?.type === 'account') {
            const toggleWord = selectedItem.account?.enabled === false ? 'Enable' : 'Disable';
            const hasVerify = !!(selectedItem.account?.verifyUrl || liveMap.get(selectedItem.account?.email)?.verifyUrl);
            const verifyLabel = termWidth >= 114 ? 'Verify Browser' : 'Verify';
            const verifyKey = hasVerify
                ? `\x1b[1;38;5;214m[V]\x1b[0m \x1b[38;5;220m${verifyLabel}\x1b[0m`
                : fmtKey('V', verifyLabel);
            if (termWidth >= 114) {
                contextBar = `\x1b[38;5;110mAccount:\x1b[0m ${[
                    fmtKey('Enter', 'Set Active'),
                    fmtKey('Space', 'Manage Menu'),
                    fmtKey('R', 'Re-login'),
                    fmtKey('T', toggleWord),
                    verifyKey,
                    fmtKey('D', 'Delete')
                ].join(sep)}`;
            } else {
                const prefix = termWidth >= 92 ? `\x1b[38;5;110mAccount:\x1b[0m ` : '';
                contextBar = `${prefix}${[
                    fmtKey('Enter', 'Use'),
                    fmtKey('Space', 'Menu'),
                    fmtKey('R', 'Re-login'),
                    fmtKey('T', toggleWord),
                    verifyKey,
                    fmtKey('D', 'Delete')
                ].join(sep)}`;
            }
        } else if (selectedItem?.id === 'lb_strategy') {
            contextBar = `\x1b[38;5;110mMode:\x1b[0m    ${[
                fmtKey('Enter', 'Open Mode Selector & Risk Guide'),
                fmtKey('←/→', 'Cycle Mode Inline')
            ].join(sep)}`;
        } else {
            contextBar = `\x1b[38;5;110mAction:\x1b[0m  ${[
                fmtKey('Enter', 'Open Selected Option'),
                fmtKey('1-9', 'Switch Active Account')
            ].join(sep)}`;
        }
        buf += `${contextBar}${c.clearToEndOfLine}\n`;

        const tipToggleLabel = tipsVisible ? 'Hide Tip' : 'Show Tip';
        const globalBar = termWidth >= 102
            ? [
                fmtKey('↑↓', 'Move'),
                fmtKey('1-9', 'Switch Account'),
                fmtKey('Ctrl+D', 'Safety Guide'),
                fmtKey('X', tipToggleLabel),
                fmtKey('Ctrl+R', 'Reload'),
                fmtKey('Q', 'Quit')
            ].join(sep)
            : [
                fmtKey('↑↓', 'Move'),
                fmtKey('1-9', 'Switch'),
                fmtKey('Ctrl+D', 'Guide'),
                fmtKey('X', tipToggleLabel),
                fmtKey('Ctrl+R', 'Reload'),
                fmtKey('Q', 'Quit')
            ].join(sep);

        // Fixed Footer line (no trailing newline to guarantee no terminal auto-scroll)
        buf += `${globalBar}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;

        process.stdout.write(buf);
    }

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const onResize = () => {
        if (isSubScreenActive) {
            if (typeof activeSubScreenRender === 'function') activeSubScreenRender();
        } else {
            render();
        }
    };
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

        /*
         * Sub-screen runner shares the outer isSubScreenActive guard so background
         * timers/resizes never paint dashboard rows on top of an open sub-screen.
         * TUI sub-screens stay in raw + nowrap + hidden-cursor mode without toggling
         * ConPTY line discipline; only readline prompts opt into lineMode = true.
         */
        async function runSubScreen(fn, { lineMode = false } = {}) {
            if (isSubScreenActive) return;
            isSubScreenActive = true;
            activeSubScreenRender = null;
            if (shimmerTimer) {
                clearInterval(shimmerTimer);
                shimmerTimer = null;
            }
            process.stdin.removeListener('keypress', onKeypress);
            if (lineMode) {
                process.stdout.write(c.cursorHome + c.clearScreen + c.enableWrap + c.showCursor);
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
            } else {
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(true);
                }
                readline.emitKeypressEvents(process.stdin);
                process.stdin.resume();
                process.stdout.write(c.hideCursor + c.disableWrap + c.cursorHome + c.clearScreen);
            }
            try {
                await fn();
            } catch (err) {
                console.error(`\n${c.statusDanger}Error: ${err.message}${c.reset}`);
                await new Promise(r => setTimeout(r, 1500));
            } finally {
                activeSubScreenRender = null;
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(true);
                }
                process.stdin.resume();
                process.stdin.on('keypress', onKeypress);
                process.stdout.write(c.hideCursor + c.disableWrap + c.cursorHome + c.clearScreen);
                await refreshData();
                items = getItems();
                isSubScreenActive = false;
                render();
                shimmerTimer = setInterval(() => render(), 75);
            }
        }

        async function openEngineSettings() {
            await runSubScreen(async () => {
                reloadConfig();

                const state = {
                    // Tab 1: Anti-Ban & Pacing
                    singleLock: !!config?.singleAccountLock,
                    pacerMs: config?.pacerDelayMs ?? 250,
                    pacerJitterPct: config?.pacerJitterPct ?? 30,
                    hourlyCap: config?.hourlyAccountCap ?? 120,
                    sanitizePrompts: config?.sanitizeClientPrompts !== false,
                    pauseOnVerify: config?.pauseOnVerifyReq !== false,
                    keepAliveSec: config?.keepAliveIdleSec ?? 30,

                    // Tab 2: Pool & Failover
                    quotaFloorPct: Math.round((config?.globalQuotaThreshold ?? 0.10) * 100),
                    weeklyFloorPct: Math.round((config?.weeklyQuotaThreshold ?? 0.05) * 100),
                    thresholdPct: Math.round((config?.accountSelection?.stepThreshold || 0.05) * 100),
                    minStaySec: config?.accountSelection?.minStaySec ?? 180,
                    idleBreakSec: config?.accountSelection?.idleBreakSec ?? 180,
                    reqCap: config?.accountSelection?.requestThreshold || 20,
                    cooldownMs: config?.switchAccountDelayMs ?? 5000,
                    maxRetriesVal: config?.maxRetries ?? 2,

                    // Tab 3: Proxy IP Pool
                    proxyPoolEnabled: !!config?.proxyPoolEnabled,
                    proxyStrategy: config?.proxyRotationStrategy || 'sticky-account',
                    proxyFallbackDirect: config?.proxyFallbackDirect !== false,
                    proxyTimeoutMs: config?.proxyTimeoutMs || 10000,

                    // Tab 4: Claude & Desktop
                    claudeDesktopSync: config?.claudeDesktopSync !== false,
                    proxyPort: config?.port || port || 43128,
                    bindHost: config?.bindHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
                    secretKey: config?.apiKey || 'atc-local-key',
                    streamTimeoutSec: config?.upstreamTimeoutSec ?? 300,
                    quotaTtlSec: config?.quotaRefreshTtlSec ?? 300,
                    loginTimeoutSec: config?.loginTimeoutSec || 120,
                    debugMode: !!config?.debug,

                    // Tab 5: UI & Tips Banner
                    showTips: config?.showTips !== false,
                    tipsDismissScope: config?.tipsDismissScope === 'permanent' ? 'permanent' : 'session',
                    tipsScrollSpeed: ['slow', 'normal', 'fast', 'static'].includes(config?.tipsScrollSpeed)
                        ? config.tipsScrollSpeed
                        : 'normal',
                    tipsHighContrast: config?.tipsHighContrast !== false,
                    maskEmails: !!config?.maskEmails,
                    shimmerTitle: config?.shimmerTitle !== false
                };

                const TABS = [
                    { id: 'anti_ban', title: 'Anti-Ban & Pacing' },
                    { id: 'pool', title: 'Pool & Failover' },
                    { id: 'proxy_pool', title: 'Proxy IP Pool' },
                    { id: 'claude', title: 'Claude & Desktop' },
                    { id: 'ui_tips', title: 'UI & Tips Banner' }
                ];

                const ALL_ITEMS = [
                    // --- Tab 1: Anti-Ban & Pacing ---
                    {
                        tab: 'anti_ban', key: 'singleLock', label: 'Single-Account Lock', type: 'bool',
                        onText: 'ON (Locked)', offText: 'OFF', onColor: '\x1b[1;38;5;49m',
                        guide: 'safest for 1 pool',
                        desc: 'Hard-pins 100% traffic to the active account; completely disables multi-account rotation'
                    },
                    {
                        tab: 'anti_ban', key: 'pacerMs', label: 'Per-Account Burst Pacer', type: 'num', unit: 'ms',
                        min: 0, max: 5000, step: 50, safeMin: 150, safeMax: 1000,
                        presets: [0, 150, 250, 350, 500, 1000],
                        guide: 'safe: 150–1000ms',
                        warnLow: 'Below 150ms: parallel subagent calls hit Cloud Code simultaneously in a tight spike',
                        warnHigh: 'Above 1000ms: parallel subagent tool calls queue noticeably slower',
                        desc: 'Minimum stagger gap between simultaneous subagent requests on the same account (0ms when idle)'
                    },
                    {
                        tab: 'anti_ban', key: 'pacerJitterPct', label: 'Burst Pacer Random Jitter', type: 'num', unit: '%',
                        min: 0, max: 80, step: 5, safeMin: 15, safeMax: 55,
                        presets: [0, 15, 20, 30, 40, 50],
                        guide: 'safe: 15–55%',
                        warnLow: 'Below 15%: burst spacing looks robotic and metronomic',
                        warnHigh: 'Above 55%: wide variance adds occasional extra latency on bursts',
                        desc: 'Randomizes per-account burst spacing so staggered requests never fire at fixed intervals'
                    },
                    {
                        tab: 'anti_ban', key: 'hourlyCap', label: 'Hourly Cap / Account', type: 'num', unit: '/h',
                        min: 0, max: 600, step: 10, safeMin: 30, safeMax: 240,
                        presets: [0, 30, 60, 120, 180, 240],
                        guide: 'safe: 30–240/h',
                        warnLow: '0 disables runaway loop protection; <30/h may cap active coding turns',
                        warnHigh: 'Above 240/h: permits sustained high-velocity automated bursts on one consumer account',
                        desc: 'Soft circuit breaker limiting successful requests per hour per account (0 = unlimited)'
                    },
                    {
                        tab: 'anti_ban', key: 'sanitizePrompts', label: 'Prompt Hygiene (Sanitize)', type: 'bool',
                        onText: 'Enabled', offText: 'Disabled',
                        guide: 'strips SDK markers',
                        desc: 'Strips third-party SDK billing headers and agent vendor strings that trigger opaque 429s'
                    },
                    {
                        tab: 'anti_ban', key: 'pauseOnVerify', label: 'Auto-Pause on [verify-req]', type: 'bool',
                        onText: 'Enabled', offText: 'Disabled',
                        guide: 'holds 403 accounts',
                        desc: 'Automatically halts routing to accounts flagged with 403 VALIDATION_REQUIRED until verified via [V]'
                    },
                    {
                        tab: 'anti_ban', key: 'keepAliveSec', label: 'Socket Keep-Alive Idle TTL', type: 'num', unit: 's',
                        min: 5, max: 180, step: 5, safeMin: 15, safeMax: 90,
                        presets: [15, 30, 45, 60, 90],
                        guide: 'safe: 15–90s',
                        warnLow: 'Below 15s: causes frequent TLS handshakes between consecutive prompts',
                        warnHigh: 'Above 90s: approaches Google Frontend idle socket cutoff (~240s)',
                        desc: 'Idle lifetime for isolated per-account HTTP/1.1 TLS sockets before clean close'
                    },

                    // --- Tab 2: Pool & Failover ---
                    {
                        tab: 'pool', key: 'quotaFloorPct', label: 'Global 5h Quota Floor', type: 'num', unit: '%',
                        min: 0, max: 50, step: 5, safeMin: 5, safeMax: 25,
                        presets: [0, 5, 10, 15, 20, 25],
                        guide: 'safe: 5–25%',
                        warnLow: '0%: accounts drain all the way into hard 0% 429 exhaustion',
                        warnHigh: 'Above 25%: leaves substantial 5h quota unused before rotating',
                        desc: 'Safety 5-hour quota reserve where healthy pool stops draining an account'
                    },
                    {
                        tab: 'pool', key: 'weeklyFloorPct', label: 'Weekly Quota Floor', type: 'num', unit: '%',
                        min: 0, max: 50, step: 5, safeMin: 5, safeMax: 25,
                        presets: [0, 5, 10, 15, 20],
                        guide: 'safe: 5–25%',
                        warnLow: '0%: allows flagship models (Argon / Opus) to burn 100% of weekly cap',
                        warnHigh: 'Above 25%: holds back a large portion of weekly model quota',
                        desc: 'Safety reserve protecting scarce 7-day model quotas (Gemini 4 Argon / Opus) when alternates exist'
                    },
                    {
                        tab: 'pool', key: 'thresholdPct', label: 'Quota Rotation Step', type: 'num', unit: '%',
                        min: 1, max: 50, step: 1, safeMin: 3, safeMax: 15,
                        presets: [3, 5, 7, 10, 15],
                        guide: 'safe: 3–15%',
                        warnLow: 'Below 3%: causes frequent multi-account cycling from one IP',
                        warnHigh: 'Above 15%: drains each account deeper before staggering 5h recovery',
                        desc: 'Quota drop percentage before Pipelined mode rotates to the next account'
                    },
                    {
                        tab: 'pool', key: 'minStaySec', label: 'Min Account Stay Time', type: 'num', unit: 's',
                        min: 0, max: 3600, step: 30, safeMin: 60, safeMax: 900,
                        presets: [0, 60, 120, 180, 300, 600],
                        guide: 'safe: 60–900s',
                        warnLow: 'Below 60s: rapid multi-account hopping under subagent bursts raises ban risk',
                        warnHigh: 'Above 900s: behaves closer to Sticky/Session mode with long single-account blocks',
                        desc: 'Minimum seconds (+random jitter) on a healthy account before proactive rotation is allowed'
                    },
                    {
                        tab: 'pool', key: 'idleBreakSec', label: 'Idle Session Break Gap', type: 'num', unit: 's',
                        min: 30, max: 1800, step: 30, safeMin: 90, safeMax: 600,
                        presets: [90, 180, 300, 600],
                        guide: 'safe: 90–600s',
                        warnLow: 'Below 90s: may mistake a long file read or user pause for a finished session',
                        warnHigh: 'Above 600s: requires >10m quiet break before Session mode rotates',
                        desc: 'Quiet pause required between turns before Idle-Aware Session mode hands off accounts'
                    },
                    {
                        tab: 'pool', key: 'reqCap', label: 'Fallback Request Cap', type: 'num', unit: ' reqs',
                        min: 5, max: 200, step: 5, safeMin: 10, safeMax: 50,
                        presets: [10, 20, 30, 50],
                        guide: 'safe: 10–50 reqs',
                        warnLow: 'Below 10 reqs: switches accounts too often when telemetry lags',
                        warnHigh: 'Above 50 reqs: single account may drain heavily before fallback rotation',
                        desc: 'Fallback request counter before rotating if upstream quota telemetry has not updated'
                    },
                    {
                        tab: 'pool', key: 'cooldownMs', label: 'Switch Delay Cooldown', type: 'num', unit: 'ms',
                        min: 500, max: 30000, step: 500, safeMin: 2000, safeMax: 10000,
                        presets: [2000, 3000, 5000, 7000, 10000],
                        guide: 'safe: 2000–10000ms',
                        warnLow: 'Below 2000ms: instant cross-account failover looks like automated credential rotation',
                        warnHigh: 'Above 10000ms: adds noticeable wait when failing over from a rate-limited account',
                        desc: 'Mandatory jittered pause before failing over to another account after an error'
                    },
                    {
                        tab: 'pool', key: 'maxRetriesVal', label: 'Max Failover Retries', type: 'num', unit: '',
                        min: 0, max: 5, step: 1, safeMin: 1, safeMax: 3,
                        presets: [0, 1, 2, 3],
                        guide: 'safe: 1–3',
                        warnLow: '0 retries: any transient error immediately fails the request',
                        warnHigh: 'Above 3 retries: fans a failing prompt across too many accounts in a single turn',
                        desc: 'Maximum failover attempts across accounts per request before returning an error'
                    },

                    // --- Tab 3: Proxy IP Pool ---
                    {
                        tab: 'proxy_pool', key: 'proxyPoolEnabled', label: 'Proxy Pool Master', type: 'bool',
                        onText: 'Enabled', offText: 'Disabled', onColor: '\x1b[1;38;5;49m',
                        guide: 'anti-IP-cluster ban',
                        desc: 'Distribute requests across forward proxies to avoid Google IP correlation and bulk account bans'
                    },
                    {
                        tab: 'proxy_pool', key: 'proxyStrategy', label: 'Proxy Rotation Mode', type: 'enum',
                        choices: [
                            { val: 'sticky-account', label: 'Sticky per Account (Safest)' },
                            { val: 'round-robin', label: 'Round-Robin Rotation' },
                            { val: 'random', label: 'Random IP Selection' }
                        ],
                        guide: 'rotation strategy',
                        desc: 'Sticky per Account pins each Google account to a consistent IP, preventing anomalous multi-IP hopping'
                    },
                    {
                        tab: 'proxy_pool', key: 'proxyFallbackDirect', label: 'Direct IP Fallback', type: 'bool',
                        onText: 'Enabled', offText: 'Disabled',
                        guide: 'failover safety',
                        desc: 'Automatically fallback to direct connection if all proxies in the pool fail or time out'
                    },
                    {
                        tab: 'proxy_pool', key: 'proxyTimeoutMs', label: 'Proxy Connect Timeout', type: 'num', unit: 'ms',
                        min: 2000, max: 30000, step: 1000, safeMin: 5000, safeMax: 20000,
                        presets: [5000, 10000, 15000, 20000],
                        guide: 'safe: 5000–20000ms',
                        warnLow: 'Below 5000ms: slow forward proxies may drop connections prematurely',
                        warnHigh: 'Above 20000ms: dead proxies delay failover routing',
                        desc: 'HTTP CONNECT tunnel socket timeout when establishing connection through proxy'
                    },

                    // --- Tab 4: Claude & Desktop ---
                    {
                        tab: 'claude', key: 'claudeDesktopSync', label: 'Claude Desktop Auto-Sync', type: 'bool',
                        onText: 'Enabled', offText: 'Disabled', onColor: '\x1b[1;38;5;49m',
                        guide: 'syncs Desktop app',
                        desc: 'Automatically synchronize proxy API port and MCP bridge into claude_desktop_config.json'
                    },
                    {
                        tab: 'claude', key: 'proxyPort', label: 'Proxy Listen Port', type: 'num', unit: '',
                        min: 1024, max: 65535, step: 1, safeMin: 1024, safeMax: 65535,
                        presets: [43128, 43129, 8080],
                        guide: 'syncs Claude Code & Desktop',
                        warnLow: 'Ports below 1024 require elevated OS privileges',
                        warnHigh: 'Port out of valid TCP range',
                        desc: 'Local HTTP listen port (auto-updates ANTHROPIC_BASE_URL; run atc restart to rebind socket)'
                    },
                    {
                        tab: 'claude', key: 'bindHost', label: 'Proxy Bind Address', type: 'enum',
                        choices: [
                            { val: '127.0.0.1', label: '127.0.0.1 (Loopback)' },
                            { val: '0.0.0.0', label: '0.0.0.0 (All NICs)' }
                        ],
                        guide: '127.0.0.1 recommended',
                        desc: 'Keep on 127.0.0.1 unless connecting from a local VM/WSL/container with a strong Secret API Key'
                    },
                    {
                        tab: 'claude', key: 'secretKey', label: 'Secret API Key', type: 'text',
                        guide: 'syncs ANTHROPIC_API_KEY',
                        desc: 'Local bearer key required on proxy requests; automatically synced to ~/.claude/settings.json'
                    },
                    {
                        tab: 'claude', key: 'streamTimeoutSec', label: 'Active Stream Timeout', type: 'num', unit: 's',
                        min: 60, max: 900, step: 30, safeMin: 120, safeMax: 600,
                        presets: [120, 180, 300, 450, 600],
                        guide: 'safe: 120–600s',
                        warnLow: 'Below 120s: long thinking models may time out mid-reasoning',
                        warnHigh: 'Above 600s: hung upstream sockets stay open longer',
                        desc: 'Maximum socket wait for active streaming/thinking responses before aborting'
                    },
                    {
                        tab: 'claude', key: 'quotaTtlSec', label: 'Quota Poll Cache TTL', type: 'num', unit: 's',
                        min: 30, max: 3600, step: 30, safeMin: 120, safeMax: 1800,
                        presets: [120, 300, 600, 1800],
                        guide: 'safe: 120–1800s',
                        warnLow: 'Below 120s: frequent multi-account quota probes from one IP increase noise',
                        warnHigh: 'Above 1800s: displayed quota percentages refresh less frequently',
                        desc: 'Cache lifetime for /account-limits probes to avoid multi-account polling bursts'
                    },
                    {
                        tab: 'claude', key: 'loginTimeoutSec', label: 'OAuth Login Timeout', type: 'num', unit: 's',
                        min: 30, max: 600, step: 15, safeMin: 60, safeMax: 300,
                        presets: [60, 120, 180, 300],
                        guide: 'safe: 60–300s',
                        warnLow: 'Below 60s: browser sign-in or 2FA may time out prematurely',
                        warnHigh: 'Above 300s: temporary OAuth callback port stays open longer if cancelled',
                        desc: 'Maximum wait time for Google OAuth browser callback during account login'
                    },
                    {
                        tab: 'claude', key: 'debugMode', label: 'Debug Verbose Logging', type: 'bool',
                        onText: 'Enabled', offText: 'Disabled',
                        guide: 'for troubleshooting',
                        desc: 'Emit detailed request conversion and strategy trace logs to server output'
                    },

                    // --- Tab 5: UI & Tips Banner ---
                    {
                        tab: 'ui_tips', key: 'showTips', label: 'Tips Banner on Startup', type: 'bool',
                        onText: 'Enabled', offText: 'Disabled',
                        guide: 'top safety ribbon',
                        desc: 'Enable or disable the high-contrast safety & operational tips ribbon whenever atc opens'
                    },
                    {
                        tab: 'ui_tips', key: 'tipsHighContrast', label: 'High-Contrast Banner', type: 'bool',
                        onText: 'Enabled (Navy/White)', offText: 'Standard',
                        guide: 'vivid readability',
                        desc: 'Use dual-tone deep navy background and bold white foreground for maximum contrast'
                    },
                    {
                        tab: 'ui_tips', key: 'tipsDismissScope', label: 'Dismiss Key [X] Behavior', type: 'enum',
                        choices: [
                            { val: 'session', label: 'Session Only' },
                            { val: 'permanent', label: 'Save Permanently' }
                        ],
                        guide: 'how [X] hides ribbon',
                        desc: 'Session Only hides the tip ribbon until atc exits; Save Permanently flips Startup setting to Disabled'
                    },
                    {
                        tab: 'ui_tips', key: 'tipsScrollSpeed', label: 'Tips Banner Scroll Speed', type: 'enum',
                        choices: [
                            { val: 'slow', label: 'Slow (240ms)' },
                            { val: 'normal', label: 'Normal (150ms)' },
                            { val: 'fast', label: 'Fast (85ms)' },
                            { val: 'static', label: 'Static Slides' }
                        ],
                        guide: 'zero-flicker ticker',
                        desc: 'Adjust horizontal marquee speed or switch to non-scrolling static slides (7s per tip)'
                    },
                    {
                        tab: 'ui_tips', key: 'maskEmails', label: 'Mask Account Emails', type: 'bool',
                        onText: 'Enabled (sa***21)', offText: 'Disabled',
                        guide: 'safe screenshots',
                        desc: 'Redact middle characters of emails on the dashboard so you can share screenshots safely'
                    },
                    {
                        tab: 'ui_tips', key: 'shimmerTitle', label: 'Header Shimmer Animation', type: 'bool',
                        onText: 'Enabled', offText: 'Disabled',
                        guide: 'metallic sweep',
                        desc: 'Toggle the periodic silver sheen sweep across the atc header title'
                    }
                ];

                let activeTabIdx = 0;
                let rowIdx = 0;
                let isFocusEditing = false;
                let editBuffer = '';
                let notice = '';

                function getVisibleRows() {
                    const tabId = TABS[activeTabIdx].id;
                    const tabSettings = ALL_ITEMS.filter((it) => it.tab === tabId);
                    return [
                        ...tabSettings,
                        { type: 'action', id: 'reset_tab', label: `Reset "${TABS[activeTabIdx].title}" to Defaults`, desc: 'Restore recommended values for this tab only' },
                        { type: 'action', id: 'reset_all', label: 'Reset All 5 Tabs to Defaults', desc: 'Restore recommended settings across all 5 tabs' },
                        { type: 'action', id: 'save', label: 'Save & Return to Dashboard', desc: 'Save settings to config, sync Claude Code & Desktop, and return to dashboard' }
                    ];
                }

                function resetTabDefaults(tabId) {
                    if (tabId === 'anti_ban' || tabId === 'all') {
                        state.singleLock = false;
                        state.pacerMs = 250;
                        state.pacerJitterPct = 30;
                        state.hourlyCap = 120;
                        state.sanitizePrompts = true;
                        state.pauseOnVerify = true;
                        state.keepAliveSec = 30;
                    }
                    if (tabId === 'pool' || tabId === 'all') {
                        state.quotaFloorPct = 10;
                        state.weeklyFloorPct = 5;
                        state.thresholdPct = 5;
                        state.minStaySec = 180;
                        state.idleBreakSec = 180;
                        state.reqCap = 20;
                        state.cooldownMs = 5000;
                        state.maxRetriesVal = 2;
                    }
                    if (tabId === 'proxy_pool' || tabId === 'all') {
                        state.proxyPoolEnabled = false;
                        state.proxyStrategy = 'sticky-account';
                        state.proxyFallbackDirect = true;
                        state.proxyTimeoutMs = 10000;
                    }
                    if (tabId === 'claude' || tabId === 'all') {
                        state.claudeDesktopSync = true;
                        state.proxyPort = port || 43128;
                        state.bindHost = '127.0.0.1';
                        state.secretKey = state.secretKey || 'atc-local-key';
                        state.streamTimeoutSec = 300;
                        state.quotaTtlSec = 300;
                        state.loginTimeoutSec = 120;
                        state.debugMode = false;
                    }
                    if (tabId === 'ui_tips' || tabId === 'all') {
                        state.showTips = true;
                        state.tipsHighContrast = true;
                        state.tipsDismissScope = 'session';
                        state.tipsScrollSpeed = 'normal';
                        state.maskEmails = false;
                        state.shimmerTitle = true;
                    }
                }

                function formatItemDisplay(it) {
                    const val = state[it.key];
                    if (it.type === 'bool') return val ? it.onText : it.offText;
                    if (it.type === 'enum') {
                        const found = it.choices.find((ch) => ch.val === val);
                        return found ? found.label : String(val);
                    }
                    if (it.type === 'num') {
                        if (it.key === 'hourlyCap' && val === 0) return 'Unlimited';
                        return it.unit ? `${val}${it.unit.startsWith(' ') ? it.unit : ' ' + it.unit}`.trim() : String(val);
                    }
                    if (it.type === 'text') return val || '(none)';
                    return '';
                }

                function getItemWarning(it) {
                    if (it.type !== 'num') {
                        if (it.key === 'bindHost' && state.bindHost === '0.0.0.0') {
                            return '0.0.0.0 exposes proxy on LAN — ensure Secret API Key is strong';
                        }
                        return null;
                    }
                    const val = state[it.key];
                    if (it.key === 'hourlyCap' && val === 0) return it.warnLow;
                    if (val < it.safeMin) return it.warnLow;
                    if (val > it.safeMax) return it.warnHigh;
                    return null;
                }

                function renderScreen() {
                    const rows = getVisibleRows();
                    if (rowIdx >= rows.length) rowIdx = rows.length - 1;
                    let out = c.cursorHome;
                    out += drawHeaderBox('atc Engine, Anti-Ban & Interface Settings', 76);

                    // Clean Category Tab Bar
                    let tabLine = '  ';
                    TABS.forEach((t, idx) => {
                        const active = idx === activeTabIdx;
                        const pill = active
                            ? `\x1b[1;38;5;16;48;5;48m  ${t.title}  \x1b[0m`
                            : `\x1b[38;5;246;48;5;236m  ${t.title}  \x1b[0m`;
                        tabLine += pill + ' ';
                    });
                    out += `${tabLine}${c.clearToEndOfLine}\n`;
                    out += `  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;
                    out += `    \x1b[38;5;242m${'Parameter'.padEnd(28, ' ')}  ${'Current Value'.padEnd(20, ' ')}  Guidance / Status\x1b[0m${c.clearToEndOfLine}\n`;

                    let renderedDivider = false;
                    for (let i = 0; i < rows.length; i++) {
                        const it = rows[i];
                        const isSel = i === rowIdx;
                        const pointer = isSel ? `  \x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;

                        if (it.type === 'action') {
                            if (!renderedDivider) {
                                out += `  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;
                                renderedDivider = true;
                            }
                            const actColor = it.id === 'save'
                                ? (isSel ? '\x1b[1;38;5;120m' : '\x1b[38;5;42m')
                                : (isSel ? '\x1b[1;38;5;255m' : '\x1b[38;5;246m');
                            out += `${pointer}${actColor}${it.label}${c.reset}${c.clearToEndOfLine}\n`;
                            continue;
                        }

                        const warn = getItemWarning(it);
                        const labelCol = isSel
                            ? `\x1b[1;38;5;255m${it.label.padEnd(28, ' ')}\x1b[0m`
                            : `\x1b[38;5;250m${it.label.padEnd(28, ' ')}\x1b[0m`;

                        let valStyled = '';
                        let valPlainLen = 0;
                        if (isSel && isFocusEditing) {
                            const rawBox = `[ ${editBuffer || ''}_ ]`;
                            valPlainLen = rawBox.length;
                            valStyled = `\x1b[1;38;5;226;48;5;236m${rawBox}\x1b[0m`;
                        } else {
                            const disp = formatItemDisplay(it);
                            const rawBox = `[${disp}]`;
                            valPlainLen = rawBox.length;
                            if (it.type === 'bool') {
                                const boolOn = !!state[it.key];
                                const col = boolOn ? (it.onColor || '\x1b[38;5;120m') : '\x1b[38;5;244m';
                                valStyled = `${col}${rawBox}\x1b[0m`;
                            } else if (it.type === 'enum') {
                                valStyled = isSel ? `\x1b[1;38;5;117m${rawBox}\x1b[0m` : `\x1b[38;5;110m${rawBox}\x1b[0m`;
                            } else {
                                valStyled = isSel ? `\x1b[1;38;5;120m${rawBox}\x1b[0m` : `\x1b[38;5;147m${rawBox}\x1b[0m`;
                            }
                        }
                        const valPad = ' '.repeat(Math.max(2, 22 - valPlainLen));

                        const statusCol = isSel && isFocusEditing
                            ? `\x1b[38;5;220m✎ type value, Enter confirm\x1b[0m`
                            : (warn
                                ? `\x1b[38;5;214m▲ outside safe zone\x1b[0m`
                                : `\x1b[38;5;241m${it.guide || ''}\x1b[0m`);

                        out += `${pointer}${labelCol}  ${valStyled}${valPad}${statusCol}${c.clearToEndOfLine}\n`;
                    }

                    const curIt = rows[rowIdx];
                    const curWarn = curIt && curIt.type !== 'action' ? getItemWarning(curIt) : null;
                    const wrapCols = Math.max(58, Math.min((process.stdout.columns || 88) - 6, 78));

                    out += `  ${c.clearToEndOfLine}\n`;
                    if (notice) {
                        out += `  \x1b[38;5;120m✓ ${notice}\x1b[0m${c.clearToEndOfLine}\n`;
                        out += `  ${c.clearToEndOfLine}\n`;
                    } else if (curWarn) {
                        const warnLines = wrapPlainText(`▲ ${curWarn}`, wrapCols);
                        for (const wl of warnLines) {
                            out += `  \x1b[1;38;5;214m${wl}\x1b[0m${c.clearToEndOfLine}\n`;
                        }
                        for (let k = warnLines.length; k < 2; k++) {
                            out += `  ${c.clearToEndOfLine}\n`;
                        }
                    } else if (curIt?.desc) {
                        const descLines = wrapPlainText(curIt.desc, wrapCols);
                        descLines.forEach((dl, i) => {
                            if (i === 0) {
                                out += `  ${c.textMuted}Info:${c.reset} ${c.textNormal}${dl}${c.reset}${c.clearToEndOfLine}\n`;
                            } else {
                                out += `        ${c.textNormal}${dl}${c.reset}${c.clearToEndOfLine}\n`;
                            }
                        });
                        for (let k = descLines.length; k < 2; k++) {
                            out += `  ${c.clearToEndOfLine}\n`;
                        }
                    } else {
                        out += `  ${c.clearToEndOfLine}\n`;
                        out += `  ${c.clearToEndOfLine}\n`;
                    }

                    if (isFocusEditing) {
                        out += `  ${c.textMuted}[0-9 / Text] Type  ·  [Backspace] Delete  ·  [Enter] Confirm  ·  [ESC] Cancel Edit${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                    } else {
                        out += `  ${c.textMuted}[←/→] Switch Tab  ·  [↑↓] Move  ·  [Enter / Space] Toggle  ·  [ESC] Save & Exit${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                    }

                    process.stdout.write(out);
                }

                async function saveAllSettings() {
                    const accSel = {
                        ...(config.accountSelection || {}),
                        stepThreshold: state.thresholdPct / 100,
                        requestThreshold: state.reqCap,
                        minStaySec: state.minStaySec,
                        idleBreakSec: state.idleBreakSec
                    };
                    saveConfig({
                        singleAccountLock: state.singleLock,
                        pacerDelayMs: state.pacerMs,
                        pacerJitterPct: state.pacerJitterPct,
                        hourlyAccountCap: state.hourlyCap,
                        sanitizeClientPrompts: state.sanitizePrompts,
                        pauseOnVerifyReq: state.pauseOnVerify,
                        keepAliveIdleSec: state.keepAliveSec,
                        globalQuotaThreshold: state.quotaFloorPct / 100,
                        weeklyQuotaThreshold: state.weeklyFloorPct / 100,
                        accountSelection: accSel,
                        switchAccountDelayMs: state.cooldownMs,
                        maxRetries: state.maxRetriesVal,
                        // Proxy IP Pool
                        proxyPoolEnabled: state.proxyPoolEnabled,
                        proxyRotationStrategy: state.proxyStrategy,
                        proxyFallbackDirect: state.proxyFallbackDirect,
                        proxyTimeoutMs: state.proxyTimeoutMs,
                        // Claude Desktop
                        claudeDesktopSync: state.claudeDesktopSync,
                        // UI & Tips
                        showTips: state.showTips,
                        tipsDismissScope: state.tipsDismissScope,
                        tipsScrollSpeed: state.tipsScrollSpeed,
                        tipsHighContrast: state.tipsHighContrast,
                        maskEmails: state.maskEmails,
                        shimmerTitle: state.shimmerTitle,
                        port: state.proxyPort,
                        bindHost: state.bindHost,
                        apiKey: state.secretKey,
                        upstreamTimeoutSec: state.streamTimeoutSec,
                        quotaRefreshTtlSec: state.quotaTtlSec,
                        loginTimeoutSec: state.loginTimeoutSec,
                        debug: state.debugMode
                    });

                    tipsSessionOverride = null;
                    tipsVisible = state.showTips;

                    const cs = readClaudeSettings();
                    cs.env = cs.env || {};
                    cs.env.ANTHROPIC_API_KEY = state.secretKey;
                    cs.env.ANTHROPIC_BASE_URL = `http://localhost:${state.proxyPort}`;
                    writeClaudeSettings(cs);

                    if (state.claudeDesktopSync) {
                        try {
                            await syncClaudeDesktopIntegration({
                                port: state.proxyPort,
                                apiKey: state.secretKey
                            });
                        } catch {}
                    }
                    port = state.proxyPort;
                    try {
                        await fetch(`http://127.0.0.1:${port}/reload`, {
                            method: 'POST',
                            signal: AbortSignal.timeout(1500)
                        });
                    } catch {}
                }

                await new Promise((resolve) => {
                    if (process.stdin.isTTY) process.stdin.setRawMode(true);
                    readline.emitKeypressEvents(process.stdin);

                    function toggleSetting(it) {
                        if (it.type === 'bool') {
                            state[it.key] = !state[it.key];
                            notice = `${it.label} -> ${formatItemDisplay(it)}`;
                        } else if (it.type === 'enum') {
                            const idx = Math.max(0, it.choices.findIndex((ch) => ch.val === state[it.key]));
                            const next = it.choices[(idx + 1) % it.choices.length];
                            state[it.key] = next.val;
                            notice = `${it.label} -> ${next.label}`;
                        } else if (it.type === 'num') {
                            if (Array.isArray(it.presets) && it.presets.length > 0) {
                                const curVal = state[it.key];
                                const pIdx = it.presets.indexOf(curVal);
                                const nextVal = pIdx >= 0 ? it.presets[(pIdx + 1) % it.presets.length] : it.presets[0];
                                state[it.key] = nextVal;
                            } else {
                                let nextVal = state[it.key] + it.step;
                                if (nextVal > it.max) nextVal = it.min;
                                state[it.key] = nextVal;
                            }
                            notice = `${it.label} -> ${formatItemDisplay(it)}`;
                        } else if (it.type === 'text') {
                            isFocusEditing = true;
                            editBuffer = String(state[it.key] ?? '');
                        }
                    }

                    function onKey(str, key) {
                        if (!key) return;
                        const rows = getVisibleRows();
                        const cur = rows[rowIdx];

                        if (isFocusEditing) {
                            if (key.name === 'escape') {
                                isFocusEditing = false;
                                editBuffer = '';
                                renderScreen();
                                return;
                            }
                            if (key.name === 'return' || key.name === 'enter') {
                                if (cur.type === 'text') {
                                    state[cur.key] = editBuffer.trim() || 'atc-local-key';
                                } else if (cur.type === 'num' && editBuffer.trim() !== '') {
                                    const parsed = parseInt(editBuffer.trim(), 10);
                                    if (!Number.isNaN(parsed)) {
                                        state[cur.key] = Math.max(cur.min, Math.min(cur.max, parsed));
                                    }
                                }
                                isFocusEditing = false;
                                editBuffer = '';
                                notice = `Updated ${cur.label} -> ${formatItemDisplay(cur)}`;
                                renderScreen();
                                return;
                            }
                            if (key.name === 'backspace') {
                                editBuffer = editBuffer.slice(0, -1);
                                renderScreen();
                                return;
                            }
                            if (cur.type === 'text') {
                                if (str && /^[a-zA-Z0-9_\-\.]$/.test(str) && editBuffer.length < 64) {
                                    editBuffer += str;
                                    renderScreen();
                                }
                            } else if (/^[0-9]$/.test(str) && editBuffer.length < 6) {
                                editBuffer += str;
                                renderScreen();
                            }
                            return;
                        }

                        if (key.name === 'escape' || (key.ctrl && key.name === 'c') || (key.ctrl && key.name === 's')) {
                            cleanup();
                            saveAllSettings().finally(resolve);
                            return;
                        }

                        // Arrow Left / Right and Tab switch between the 4 balanced categories
                        if (key.name === 'left' || key.name === 'h') {
                            notice = '';
                            activeTabIdx = (activeTabIdx - 1 + TABS.length) % TABS.length;
                            rowIdx = 0;
                            process.stdout.write(c.cursorHome + c.clearScreen);
                            renderScreen();
                            return;
                        }

                        if (key.name === 'right' || key.name === 'l') {
                            notice = '';
                            activeTabIdx = (activeTabIdx + 1) % TABS.length;
                            rowIdx = 0;
                            process.stdout.write(c.cursorHome + c.clearScreen);
                            renderScreen();
                            return;
                        }

                        if (key.name === 'tab') {
                            notice = '';
                            const dir = key.shift ? -1 : 1;
                            activeTabIdx = (activeTabIdx + dir + TABS.length) % TABS.length;
                            rowIdx = 0;
                            process.stdout.write(c.cursorHome + c.clearScreen);
                            renderScreen();
                            return;
                        }

                        if (key.name === 'up' || key.name === 'k') {
                            notice = '';
                            rowIdx = (rowIdx - 1 + rows.length) % rows.length;
                            renderScreen();
                            return;
                        }

                        if (key.name === 'down' || key.name === 'j') {
                            notice = '';
                            rowIdx = (rowIdx + 1) % rows.length;
                            renderScreen();
                            return;
                        }

                        // Enter or Space toggles setting or executes action
                        if (key.name === 'return' || key.name === 'enter' || key.name === 'space') {
                            if (!cur) return;
                            if (cur.type !== 'action') {
                                toggleSetting(cur);
                                renderScreen();
                                return;
                            }
                            if (cur.id === 'reset_tab') {
                                resetTabDefaults(TABS[activeTabIdx].id);
                                notice = `Reset "${TABS[activeTabIdx].title}" tab to safe defaults`;
                                renderScreen();
                                return;
                            }
                            if (cur.id === 'reset_all') {
                                resetTabDefaults('all');
                                notice = 'Reset all 4 tabs to recommended defaults';
                                renderScreen();
                                return;
                            }
                            if (cur.id === 'save') {
                                cleanup();
                                saveAllSettings().finally(resolve);
                            }
                        }
                    }

                    function cleanup() {
                        process.stdin.removeListener('keypress', onKey);
                    }

                    activeSubScreenRender = renderScreen;
                    process.stdin.on('keypress', onKey);
                    renderScreen();
                });

                setStatus('Saved Engine Settings & synced live daemon.', 2200);
            });
        }

        async function applyStrategyChoice(nextObj) {
            reloadConfig();
            currentStrategy = nextObj.id;
            const accSel = { ...(config.accountSelection || {}), strategy: currentStrategy };
            const updates = { accountSelection: accSel };
            if (currentStrategy === 'locked') {
                updates.singleAccountLock = true;
            } else if (config?.singleAccountLock) {
                updates.singleAccountLock = false;
            }
            saveConfig(updates);
            try {
                await fetch(`http://127.0.0.1:${port}/reload`, {
                    method: 'POST',
                    signal: AbortSignal.timeout(1500)
                });
            } catch {}
            items = getItems();
            setStatus(`Load Balancer -> ${nextObj.label} [${nextObj.riskTag}]`, 2500);
        }

        async function runCustomModeBuilderInline(initialProfile = null) {
            const draft = normalizeCustomProfile(initialProfile || {
                name: `My Safe Mode ${(Array.isArray(config?.customModes) ? config.customModes.length : 0) + 1}`,
                baseCore: 'day-slots',
                maxDailyAccounts: 2,
                requireIdleGap: true,
                minIdleSec: 180,
                minStaySec: 600,
                quotaStepPct: 10,
                floor5hPct: 15,
                floorWeeklyPct: 15,
                candidateOrder: 'highest-5h',
                onUnavailable: 'failover'
            });
            const originalId = initialProfile ? slugifyProfileId(initialProfile.id || initialProfile.name) : null;

            const FIELDS = [
                {
                    key: 'name', label: 'Profile Name', type: 'text',
                    guide: 'press Enter to rename',
                    desc: 'Display name shown on Dashboard and Load Balancer selector (saved in config.customModes)'
                },
                {
                    key: 'baseCore', label: 'Routing Core Engine', type: 'enum',
                    choices: [
                        { val: 'day-slots', label: 'Daily Slot Cap' },
                        { val: 'session-idle', label: 'Idle-Break Session' },
                        { val: 'sticky-floor', label: 'Sticky Drain-to-Floor' },
                        { val: 'quota-step', label: 'Quota Step Shift' },
                        { val: 'locked', label: 'Locked 1-Account' }
                    ],
                    guide: 'core switching behavior',
                    desc: 'Underlying rotation trigger: cap daily accounts, shift on idle breaks, drain to floor, or step by %'
                },
                {
                    key: 'maxDailyAccounts', label: 'Max Active Accounts / Day', type: 'num', unit: '/day',
                    min: 0, max: 10, step: 1,
                    guide: '1–2 safest (0 = all)',
                    desc: 'Maximum accounts exposed to Cloud Code per calendar day; extra accounts stay completely dormant'
                },
                {
                    key: 'requireIdleGap', label: 'Require Quiet Idle Gap', type: 'bool',
                    onText: 'Enabled', offText: 'Disabled',
                    guide: 'never switch mid-turn',
                    desc: 'Wait for a natural pause between prompts before performing any proactive account switch'
                },
                {
                    key: 'minIdleSec', label: 'Min Quiet Idle Gap', type: 'num', unit: 's',
                    min: 0, max: 3600, step: 30,
                    guide: 'rec: 120–300s',
                    desc: 'Seconds of user inactivity required when "Require Quiet Idle Gap" is Enabled'
                },
                {
                    key: 'minStaySec', label: 'Min Stay Time on Account', type: 'num', unit: 's',
                    min: 0, max: 7200, step: 60,
                    guide: 'rec: 300–1800s',
                    desc: 'Minimum duration to keep traffic bound to an account before any proactive handover'
                },
                {
                    key: 'quotaStepPct', label: 'Proactive Quota Drop Step', type: 'num', unit: '%',
                    min: 0, max: 80, step: 5,
                    guide: '0% = drain to floor',
                    desc: '5-hour quota % consumed before proactive rotation (used by Quota Step & Session cores)'
                },
                {
                    key: 'floor5hPct', label: '5h Quota Reserve Floor', type: 'num', unit: '%',
                    min: 0, max: 50, step: 5,
                    guide: 'rec: 10–20%',
                    desc: 'Stop draining the current account before hitting 0% 5-hour hard 429 exhaustion'
                },
                {
                    key: 'floorWeeklyPct', label: 'Weekly Quota Reserve Floor', type: 'num', unit: '%',
                    min: 0, max: 50, step: 5,
                    guide: 'rec: 10–25% (Argon)',
                    desc: 'Preserve weekly quota on flagship models (Gemini 4 Argon / Opus) by rotating early'
                },
                {
                    key: 'candidateOrder', label: 'Next Account Preference', type: 'enum',
                    choices: [
                        { val: 'highest-5h', label: 'Highest 5h Quota' },
                        { val: 'highest-weekly', label: 'Highest Weekly Quota' },
                        { val: 'lru', label: 'Longest Rested (LRU)' },
                        { val: 'sequential', label: 'Sequential Order' }
                    ],
                    guide: 'standby election rule',
                    desc: 'How the next healthy standby account is ranked when a handover occurs'
                },
                {
                    key: 'onUnavailable', label: 'When Active Hits Hard 429', type: 'enum',
                    choices: [
                        { val: 'failover', label: 'Failover to Standby' },
                        { val: 'wait', label: 'Wait in Place (No Hop)' }
                    ],
                    guide: 'wait = strictest safety',
                    desc: 'Either fail over to a healthy daily slot or wait on the current account without hopping'
                },
                { type: 'action', id: 'save_profile', label: 'Save Custom Profile & Activate Now', desc: 'Save profile into ~/.config/atc/config.json and activate it immediately on the proxy daemon' },
                { type: 'action', id: 'cancel_profile', label: 'Cancel & Back to Load Balancer List', desc: 'Discard unsaved edits and return to Load Balancer modes' }
            ];

            let fIdx = 0;
            let editingText = false;
            let bufText = '';

            function fmtVal(f) {
                const v = draft[f.key];
                if (f.type === 'bool') return v ? f.onText : f.offText;
                if (f.type === 'enum') return f.choices.find((c0) => c0.val === v)?.label || String(v);
                if (f.type === 'num') {
                    if (f.key === 'maxDailyAccounts' && v === 0) return 'All Accounts';
                    if (f.key === 'quotaStepPct' && v === 0) return 'Drain to Floor';
                    return `${v}${f.unit}`;
                }
                return String(v || '');
            }

            let savedResult = null;

            await new Promise((resolve) => {
                function renderBuilder() {
                    const risk = evaluateCustomProfileRisk(draft);
                    let out = c.cursorHome;
                    out += drawHeaderBox('Custom Load Balancer Profile Builder', 76);
                    out += `  ${c.textMuted}Live Risk Meter:${c.reset} ${risk.riskColor}[${risk.riskTag}]${c.reset} \x1b[38;5;245m— ${risk.summary}\x1b[0m${c.clearToEndOfLine}\n`;
                    out += `  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;

                    let drewSep = false;
                    for (let i = 0; i < FIELDS.length; i++) {
                        const f = FIELDS[i];
                        const isSel = i === fIdx;
                        const pointer = isSel ? `  \x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;

                        if (f.type === 'action') {
                            if (!drewSep) {
                                out += `  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;
                                drewSep = true;
                            }
                            const col = f.id === 'save_profile'
                                ? (isSel ? '\x1b[1;38;5;120m' : '\x1b[38;5;42m')
                                : (isSel ? '\x1b[1;38;5;255m' : '\x1b[38;5;245m');
                            out += `${pointer}${col}${f.label}${c.reset}${c.clearToEndOfLine}\n`;
                            continue;
                        }

                        const lbl = isSel
                            ? `\x1b[1;38;5;255m${f.label.padEnd(28, ' ')}\x1b[0m`
                            : `\x1b[38;5;250m${f.label.padEnd(28, ' ')}\x1b[0m`;

                        let valBox = '';
                        let plainLen = 0;
                        if (isSel && editingText) {
                            const raw = `[ ${bufText}_ ]`;
                            plainLen = raw.length;
                            valBox = `\x1b[1;38;5;226;48;5;236m${raw}\x1b[0m`;
                        } else {
                            const raw = `[${fmtVal(f)}]`;
                            plainLen = raw.length;
                            valBox = isSel ? `\x1b[1;38;5;120m${raw}\x1b[0m` : `\x1b[38;5;147m${raw}\x1b[0m`;
                        }
                        const pad = ' '.repeat(Math.max(2, 24 - plainLen));
                        out += `${pointer}${lbl}  ${valBox}${pad}\x1b[38;5;241m${f.guide || ''}\x1b[0m${c.clearToEndOfLine}\n`;
                    }

                    const curF = FIELDS[fIdx];
                    out += `\n  ${c.textMuted}Details:${c.reset} ${c.textNormal}${curF?.desc || ''}${c.reset}${c.clearToEndOfLine}\n`;
                    if (editingText) {
                        out += `  ${c.textMuted}Type value  ·  [Backspace] Delete  ·  [Enter] Confirm  ·  [ESC] Cancel${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                    } else {
                        out += `  ${c.textMuted}[↑↓] Move  ·  [←/→ / Space] Adjust  ·  [Enter] Edit / Save  ·  [ESC] Cancel${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                    }
                    process.stdout.write(out);
                }

                function onBuilderKey(str, key) {
                    if (!key) return;
                    const f = FIELDS[fIdx];

                    if (editingText) {
                        if (key.name === 'escape') {
                            editingText = false;
                            bufText = '';
                            renderBuilder();
                            return;
                        }
                        if (key.name === 'return' || key.name === 'enter') {
                            if (f.type === 'text') {
                                const cleaned = bufText.trim().slice(0, 30);
                                if (cleaned) draft.name = cleaned;
                            } else if (f.type === 'num' && bufText.trim() !== '') {
                                const n = parseInt(bufText.trim(), 10);
                                if (!Number.isNaN(n)) draft[f.key] = Math.max(f.min, Math.min(f.max, n));
                            }
                            editingText = false;
                            bufText = '';
                            renderBuilder();
                            return;
                        }
                        if (key.name === 'backspace') {
                            bufText = bufText.slice(0, -1);
                            renderBuilder();
                            return;
                        }
                        if (f.type === 'text') {
                            if (str && str.length === 1 && !key.ctrl && !key.meta && bufText.length < 30) {
                                bufText += str;
                                renderBuilder();
                            }
                        } else if (/^[0-9]$/.test(str) && bufText.length < 5) {
                            bufText += str;
                            renderBuilder();
                        }
                        return;
                    }

                    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                        process.stdin.removeListener('keypress', onBuilderKey);
                        resolve();
                        return;
                    }
                    if (key.name === 'up' || key.name === 'k') {
                        fIdx = (fIdx - 1 + FIELDS.length) % FIELDS.length;
                        renderBuilder();
                        return;
                    }
                    if (key.name === 'down' || key.name === 'j') {
                        fIdx = (fIdx + 1) % FIELDS.length;
                        renderBuilder();
                        return;
                    }

                    const adjust = (dir) => {
                        if (!f || f.type === 'action' || f.type === 'text') return;
                        if (f.type === 'bool') draft[f.key] = !draft[f.key];
                        else if (f.type === 'enum') {
                            const ci = Math.max(0, f.choices.findIndex((c0) => c0.val === draft[f.key]));
                            draft[f.key] = f.choices[(ci + dir + f.choices.length) % f.choices.length].val;
                        } else if (f.type === 'num') {
                            draft[f.key] = Math.max(f.min, Math.min(f.max, draft[f.key] + dir * f.step));
                        }
                    };

                    if (key.name === 'left') {
                        adjust(-1);
                        renderBuilder();
                        return;
                    }
                    if (key.name === 'right' || key.name === 'space') {
                        adjust(1);
                        renderBuilder();
                        return;
                    }

                    if (key.name === 'return' || key.name === 'enter') {
                        if (!f) return;
                        if (f.type === 'text' || f.type === 'num') {
                            editingText = true;
                            bufText = String(draft[f.key] ?? '');
                            renderBuilder();
                            return;
                        }
                        if (f.type === 'bool' || f.type === 'enum') {
                            adjust(1);
                            renderBuilder();
                            return;
                        }
                        if (f.id === 'save_profile') {
                            const finalProfile = normalizeCustomProfile({
                                ...draft,
                                id: slugifyProfileId(draft.name)
                            });
                            const existingList = Array.isArray(config?.customModes) ? [...config.customModes] : [];
                            const filtered = existingList.filter((item) => {
                                const itemSlug = slugifyProfileId(item?.id || item?.name);
                                return itemSlug !== finalProfile.id && (!originalId || itemSlug !== originalId);
                            });
                            filtered.push(finalProfile);
                            saveConfig({ customModes: filtered });
                            savedResult = finalProfile;
                            process.stdin.removeListener('keypress', onBuilderKey);
                            resolve();
                            return;
                        }
                        if (f.id === 'cancel_profile') {
                            process.stdin.removeListener('keypress', onBuilderKey);
                            resolve();
                        }
                    }
                }

                activeSubScreenRender = renderBuilder;
                process.stdin.on('keypress', onBuilderKey);
                renderBuilder();
            });

            return savedResult;
        }

        async function openLoadBalancerSelector() {
            await runSubScreen(async () => {
                reloadConfig();
                let chosen = null;
                let lbNotice = '';

                function buildRows() {
                    const stratCycle = getStrategyCycle();
                    return [
                        ...stratCycle,
                        { id: '__create_custom__', isBuilderAction: true, label: '+ Create New Custom Load Balancer Profile...', desc: 'Design your own anti-ban routing profile in a visual config table and save it' }
                    ];
                }

                let rows = buildRows();
                const effectiveId = config?.singleAccountLock ? 'locked' : currentStrategy;
                let selIdx = Math.max(0, rows.findIndex((s) => s.id === effectiveId));

                function renderScreen() {
                    rows = buildRows();
                    if (selIdx >= rows.length) selIdx = rows.length - 1;
                    const curEff = config?.singleAccountLock ? 'locked' : currentStrategy;

                    let out = c.cursorHome;
                    out += drawHeaderBox('Load Balancer Modes, Anti-Ban Risk Profiles & Custom Builder', 76);
                    out += `${c.clearToEndOfLine}\n`;

                    let drewCustomHeader = false;
                    for (let i = 0; i < rows.length; i++) {
                        const st = rows[i];
                        const isSel = i === selIdx;
                        const pointer = isSel ? `  \x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;

                        if (st.isCustom && !drewCustomHeader) {
                            out += `  \x1b[38;5;141mSaved Custom Profiles\x1b[0m${c.clearToEndOfLine}\n`;
                            drewCustomHeader = true;
                        }

                        if (st.isBuilderAction) {
                            out += `  \x1b[38;5;238m${'─'.repeat(74)}\x1b[0m${c.clearToEndOfLine}\n`;
                            const btnCol = isSel ? '\x1b[1;38;5;120m' : '\x1b[38;5;42m';
                            out += `${pointer}${btnCol}${st.label}\x1b[0m \x1b[38;5;244m[N]\x1b[0m${c.clearToEndOfLine}\n`;
                            continue;
                        }

                        const isActive = st.id === curEff;
                        const activeMark = isActive ? ` ${c.statusCurrent}[active]${c.reset}` : '';
                        const customMark = st.isCustom ? `\x1b[38;5;141m[custom]\x1b[0m ` : '';
                        const nameStyled = isSel
                            ? `\x1b[1;38;5;255m${st.label.padEnd(30, ' ')}${c.reset}`
                            : `\x1b[38;5;250m${st.label.padEnd(30, ' ')}${c.reset}`;
                        const riskStyled = `${st.riskColor}[${st.riskTag}]${c.reset}`;
                        out += `${pointer}${nameStyled} ${customMark}${riskStyled}${activeMark}${c.clearToEndOfLine}\n`;
                    }

                    const curSt = rows[selIdx];
                    const wrapCols = Math.max(58, Math.min((process.stdout.columns || 88) - 6, 78));
                    out += `\n  \x1b[38;5;238m${'─'.repeat(74)}\x1b[0m\n`;
                    if (lbNotice) {
                        out += `  \x1b[38;5;120m✓ ${lbNotice}\x1b[0m${c.clearToEndOfLine}\n`;
                    } else if (curSt?.riskTag) {
                        out += `  ${c.textMuted}Risk Profile:${c.reset} ${curSt.riskColor}[${curSt.riskTag}]${c.reset}${curSt.isCustom ? '  \x1b[38;5;244m([E] Edit Profile · [D] Delete Profile)\x1b[0m' : ''}${c.clearToEndOfLine}\n`;
                    }
                    for (const dl of wrapPlainText(curSt?.desc || '', wrapCols)) {
                        out += `  ${c.textNormal}${dl}${c.reset}${c.clearToEndOfLine}\n`;
                    }
                    out += `\n  ${c.textMuted}[↑↓] Move · [Enter] Activate · [N] New Custom Profile · [E/D] Edit/Delete Custom · [ESC] Back${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                    process.stdout.write(out);
                }

                await new Promise((resolve) => {
                    if (process.stdin.isTTY) process.stdin.setRawMode(true);
                    readline.emitKeypressEvents(process.stdin);

                    async function launchBuilder(existing = null) {
                        process.stdin.removeListener('keypress', onKey);
                        const saved = await runCustomModeBuilderInline(existing);
                        reloadConfig();
                        rows = buildRows();
                        if (saved) {
                            const newId = `custom:${saved.id}`;
                            const found = rows.find((r) => r.id === newId);
                            if (found) {
                                chosen = found;
                                resolve();
                                return;
                            }
                        }
                        activeSubScreenRender = renderScreen;
                        process.stdin.on('keypress', onKey);
                        process.stdout.write(c.clearScreen + c.cursorHome);
                        renderScreen();
                    }

                    function onKey(str, key) {
                        if (!key) return;
                        if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
                            process.stdin.removeListener('keypress', onKey);
                            resolve();
                            return;
                        }
                        if (key.name === 'up' || key.name === 'k') {
                            lbNotice = '';
                            selIdx = (selIdx - 1 + rows.length) % rows.length;
                            renderScreen();
                            return;
                        }
                        if (key.name === 'down' || key.name === 'j') {
                            lbNotice = '';
                            selIdx = (selIdx + 1) % rows.length;
                            renderScreen();
                            return;
                        }
                        if (!key.ctrl && !key.meta && key.name === 'n') {
                            launchBuilder(null);
                            return;
                        }
                        if (!key.ctrl && !key.meta && key.name === 'e' && rows[selIdx]?.isCustom) {
                            launchBuilder(rows[selIdx].customProfile);
                            return;
                        }
                        if (!key.ctrl && !key.meta && (key.name === 'd' || key.name === 'backspace') && rows[selIdx]?.isCustom) {
                            const target = rows[selIdx];
                            const remaining = (config?.customModes || []).filter(
                                (p) => `custom:${slugifyProfileId(p?.id || p?.name)}` !== target.id
                            );
                            const updates = { customModes: remaining };
                            if (currentStrategy === target.id) {
                                currentStrategy = 'day-split';
                                updates.accountSelection = { ...(config.accountSelection || {}), strategy: 'day-split' };
                            }
                            saveConfig(updates);
                            reloadConfig();
                            rows = buildRows();
                            selIdx = Math.max(0, Math.min(selIdx, rows.length - 1));
                            lbNotice = `Deleted custom profile "${target.label}"`;
                            renderScreen();
                            return;
                        }
                        if (key.name === 'return' || key.name === 'enter') {
                            const cur = rows[selIdx];
                            if (cur?.isBuilderAction) {
                                launchBuilder(null);
                                return;
                            }
                            chosen = cur;
                            process.stdin.removeListener('keypress', onKey);
                            resolve();
                        }
                    }

                    activeSubScreenRender = renderScreen;
                    process.stdin.on('keypress', onKey);
                    renderScreen();
                });

                if (chosen) {
                    await applyStrategyChoice(chosen);
                }
            });
        }

        async function openTipDetails(initialTipIdx = 0) {
            if (!SAFETY_TIPS.length) return;
            await runSubScreen(async () => {
                let tipIdx = Math.max(0, Math.min(SAFETY_TIPS.length - 1, initialTipIdx));
                let bannerNotice = '';

                function renderScreen() {
                    const tip = SAFETY_TIPS[tipIdx];
                    const wrapCols = Math.max(54, Math.min((process.stdout.columns || 88) - 6, 76));
                    let out = c.cursorHome;
                    out += drawHeaderBox(`atc Safety & Operational Guide — Tip ${tipIdx + 1} of ${SAFETY_TIPS.length}`, 76);
                    out += `${c.clearToEndOfLine}\n`;

                    const pillStyle = getTipBadgeStyle(tip.badge);
                    out += `  ${pillStyle} ★ ${tip.badge} \x1b[0m \x1b[1;38;5;255m${tip.title}${c.reset}${c.clearToEndOfLine}\n\n`;

                    for (const line of wrapPlainText(tip.summary, wrapCols)) {
                        out += `  \x1b[38;5;153m${line}${c.reset}${c.clearToEndOfLine}\n`;
                    }
                    out += `\n`;

                    for (const pt of tip.points || []) {
                        const wrapped = wrapPlainText(pt, wrapCols - 2);
                        wrapped.forEach((wl, idx) => {
                            const prefix = idx === 0 ? `  \x1b[38;5;48m•\x1b[0m ` : `    `;
                            out += `${prefix}${c.textNormal}${wl}${c.reset}${c.clearToEndOfLine}\n`;
                        });
                    }

                    if (Array.isArray(tip.sources) && tip.sources.length > 0) {
                        out += `\n  ${c.textMuted}Verified Sources:${c.reset}\n`;
                        for (const src of tip.sources) {
                            out += `  ${c.textMuted}- ${src}${c.reset}${c.clearToEndOfLine}\n`;
                        }
                    }

                    out += `\n${c.textMuted}───────────────────────────────────────────────────────────────────${c.reset}\n`;
                    if (bannerNotice) {
                        out += `  ${c.statusWarn}ℹ ${bannerNotice}${c.reset}${c.clearToEndOfLine}\n`;
                    } else {
                        const startupTxt = config?.showTips !== false ? 'Enabled on Startup' : 'Disabled on Startup';
                        out += `  ${c.textMuted}Banner: ${tipsVisible ? '\x1b[38;5;120mVISIBLE\x1b[0m' : '\x1b[38;5;242mHIDDEN\x1b[0m'}${c.textMuted} (${startupTxt} — configure in Settings → Tab 3)${c.reset}${c.clearToEndOfLine}\n`;
                    }
                    out += `  ${c.textMuted}←/→ Prev/Next Tip | X Toggle Banner | Enter / Ctrl+D / ESC Return${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                    process.stdout.write(out);
                }

                await new Promise((resolve) => {
                    if (process.stdin.isTTY) process.stdin.setRawMode(true);
                    readline.emitKeypressEvents(process.stdin);

                    function onKey(str, key) {
                        if (!key) return;
                        if (
                            key.name === 'escape' ||
                            key.name === 'return' ||
                            key.name === 'enter' ||
                            key.name === 'q' ||
                            (key.ctrl && (key.name === 'c' || key.name === 'd'))
                        ) {
                            process.stdin.removeListener('keypress', onKey);
                            resolve();
                            return;
                        }
                        if (key.name === 'left' || key.name === 'up' || key.name === 'p' || key.name === 'k') {
                            bannerNotice = '';
                            tipIdx = (tipIdx - 1 + SAFETY_TIPS.length) % SAFETY_TIPS.length;
                            renderScreen();
                            return;
                        }
                        if (key.name === 'right' || key.name === 'down' || key.name === 'n' || key.name === 'j') {
                            bannerNotice = '';
                            tipIdx = (tipIdx + 1) % SAFETY_TIPS.length;
                            renderScreen();
                            return;
                        }
                        if (!key.ctrl && !key.meta && key.name === 'x') {
                            tipsVisible = !tipsVisible;
                            tipsSessionOverride = tipsVisible;
                            if (config?.tipsDismissScope === 'permanent' || (tipsVisible && config?.showTips === false)) {
                                saveConfig({ showTips: tipsVisible });
                            }
                            bannerNotice = tipsVisible
                                ? 'Dashboard safety ribbon shown.'
                                : (config?.tipsDismissScope === 'permanent'
                                    ? 'Safety ribbon hidden permanently (re-enable in Settings → Tab 3).'
                                    : 'Safety ribbon hidden for this session.');
                            renderScreen();
                        }
                    }

                    activeSubScreenRender = renderScreen;
                    process.stdin.on('keypress', onKey);
                    renderScreen();
                });
            });
        }

        if (options && options.initialScreen === 'settings') {
            setTimeout(() => {
                openEngineSettings().catch(() => {});
            }, 50);
        }

        async function onKeypress(str, key) {
            if (!key) return;

            if ((key.ctrl && key.name === 'c') || key.name === 'q' || key.name === 'escape') {
                cleanupAndExit();
                return;
            }

            // Ctrl+R: force full reload and redraw
            if (key.ctrl && key.name === 'r') {
                process.stdout.write(c.clearScreen + c.cursorHome);
                await refreshData(true);
                items = getItems();
                render();
                return;
            }

            // Ctrl+D: open detailed view for currently scrolling safety tip
            if (key.ctrl && key.name === 'd') {
                await openTipDetails(lastRenderedTipIdx);
                return;
            }

            // X: toggle safety tip ribbon (respects Settings -> Dismiss Key [X] Behavior)
            if (!key.ctrl && !key.meta && key.name === 'x') {
                if (tipsVisible) {
                    tipsVisible = false;
                    tipsSessionOverride = false;
                    if (config?.tipsDismissScope === 'permanent') {
                        saveConfig({ showTips: false });
                        setStatus('Tip ribbon disabled on startup (change anytime in Settings → Tab 3).', 2500);
                    } else {
                        setStatus('Tip ribbon hidden for this session (startup default in Settings → Tab 3).', 2500);
                    }
                } else {
                    tipsVisible = true;
                    tipsSessionOverride = true;
                    if (config?.showTips === false) {
                        saveConfig({ showTips: true });
                    }
                    setStatus('Safety tips ribbon shown.', 2000);
                }
                render();
                return;
            }

            // Quick ←/→ cycle when standing on Load Balancer row
            if ((key.name === 'left' || key.name === 'right') && items[selectedIndex]?.id === 'lb_strategy') {
                const stratCycle = getStrategyCycle();
                const effectiveId = config?.singleAccountLock ? 'locked' : currentStrategy;
                const curIdx = Math.max(0, stratCycle.findIndex((s) => s.id === effectiveId));
                const step = key.name === 'right' ? 1 : -1;
                const nextObj = stratCycle[(curIdx + step + stratCycle.length) % stratCycle.length];
                await applyStrategyChoice(nextObj);
                render();
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
                        await openLoadBalancerSelector();
                        return;
                    }

                    if (cur.id === 'custom_project') {
                        await runSubScreen(async () => {
                            reloadConfig();
                            let customProj = config?.customProjectId || '';
                            let selectedIdx = 0;
                            let isEditingProj = false;
                            let projBuf = '';
                            let notice = '';

                            const projItems = [
                                { id: 'val', label: 'Active GCP Project ID', desc: 'Press Enter to edit custom Google Cloud project ID inline (leave empty to use auto)' },
                                { id: 'reset', label: 'Reset to Automatic Default Project', desc: 'Clear custom project override and let Cloud Code resolve default project automatically' },
                                { id: 'save', label: 'Save & Return to Dashboard', desc: 'Persist project routing configuration and reload proxy daemon' }
                            ];

                            function renderScreen() {
                                let out = c.cursorHome;
                                out += drawHeaderBox('Custom GCP Project Configuration', 76);
                                out += `    \x1b[38;5;242m${'Option'.padEnd(34, ' ')}  Current Routing Value\x1b[0m${c.clearToEndOfLine}\n`;
                                out += `  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;

                                for (let i = 0; i < projItems.length; i++) {
                                    const it = projItems[i];
                                    const isSel = i === selectedIdx;
                                    const pointer = isSel ? `  \x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;

                                    if (it.id === 'save') {
                                        out += `  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;
                                    }

                                    if (it.id === 'val') {
                                        const lbl = isSel
                                            ? `\x1b[1;38;5;255m${it.label.padEnd(34, ' ')}\x1b[0m`
                                            : `\x1b[38;5;250m${it.label.padEnd(34, ' ')}\x1b[0m`;
                                        const valStr = isEditingProj
                                            ? `\x1b[1;38;5;226;48;5;236m[ ${projBuf}_ ]\x1b[0m`
                                            : (isSel
                                                ? `\x1b[1;38;5;120m[${customProj || 'Default (auto)'}]\x1b[0m`
                                                : `\x1b[38;5;147m[${customProj || 'Default (auto)'}]\x1b[0m`);
                                        out += `${pointer}${lbl}  ${valStr}${c.clearToEndOfLine}\n`;
                                    } else {
                                        const col = it.id === 'save'
                                            ? (isSel ? '\x1b[1;38;5;120m' : '\x1b[38;5;42m')
                                            : (isSel ? '\x1b[1;38;5;255m' : '\x1b[38;5;248m');
                                        out += `${pointer}${col}${it.label}${c.reset}${c.clearToEndOfLine}\n`;
                                    }
                                }

                                out += `\n`;
                                const curIt = projItems[selectedIdx];
                                if (notice) {
                                    out += `  \x1b[38;5;120m✓ ${notice}\x1b[0m${c.clearToEndOfLine}\n`;
                                } else {
                                    out += `  ${c.textMuted}Info:${c.reset} ${c.textNormal}${curIt.desc}${c.reset}${c.clearToEndOfLine}\n`;
                                }

                                if (isEditingProj) {
                                    out += `  ${c.textMuted}Type GCP Project ID  ·  [Backspace] Delete  ·  [Enter] Save  ·  [ESC] Cancel${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                                } else {
                                    out += `  ${c.textMuted}[↑↓] Move  ·  [Enter] Edit / Apply  ·  [ESC] Return${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                                }
                                process.stdout.write(out);
                            }

                            await new Promise((resolve) => {
                                function onKey(str, key) {
                                    if (!key) return;

                                    if (isEditingProj) {
                                        if (key.name === 'escape') {
                                            isEditingProj = false;
                                            projBuf = '';
                                            renderScreen();
                                            return;
                                        }
                                        if (key.name === 'return' || key.name === 'enter') {
                                            const trimmed = projBuf.trim();
                                            isEditingProj = false;
                                            projBuf = '';
                                            if (trimmed && trimmed.toLowerCase() !== 'auto' && trimmed.toLowerCase() !== 'default') {
                                                customProj = trimmed;
                                                saveConfig({ customProjectId: trimmed });
                                                notice = `Saved Custom GCP Project ID: ${trimmed}`;
                                            } else {
                                                customProj = '';
                                                saveConfig({ customProjectId: undefined });
                                                notice = 'Reset to automatic default project routing';
                                            }
                                            renderScreen();
                                            return;
                                        }
                                        if (key.name === 'backspace') {
                                            projBuf = projBuf.slice(0, -1);
                                            renderScreen();
                                            return;
                                        }
                                        if (str && str.length === 1 && !key.ctrl && !key.meta && projBuf.length < 48) {
                                            projBuf += str;
                                            renderScreen();
                                        }
                                        return;
                                    }

                                    if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
                                        process.stdin.removeListener('keypress', onKey);
                                        resolve();
                                        return;
                                    }

                                    if (key.name === 'up' || key.name === 'k') {
                                        notice = '';
                                        selectedIdx = (selectedIdx - 1 + projItems.length) % projItems.length;
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'down' || key.name === 'j') {
                                        notice = '';
                                        selectedIdx = (selectedIdx + 1) % projItems.length;
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'return' || key.name === 'enter') {
                                        if (selectedIdx === 0) {
                                            isEditingProj = true;
                                            projBuf = customProj;
                                            notice = '';
                                            renderScreen();
                                            return;
                                        }
                                        if (selectedIdx === 1) {
                                            customProj = '';
                                            saveConfig({ customProjectId: undefined });
                                            notice = 'Reset to automatic default project routing';
                                            renderScreen();
                                            return;
                                        }
                                        if (selectedIdx === 2) {
                                            process.stdin.removeListener('keypress', onKey);
                                            resolve();
                                        }
                                    }
                                }

                                activeSubScreenRender = renderScreen;
                                process.stdin.on('keypress', onKey);
                                renderScreen();
                            });

                            try {
                                await fetch(`http://127.0.0.1:${port}/reload`, {
                                    method: 'POST',
                                    signal: AbortSignal.timeout(1500)
                                });
                            } catch {}
                            setStatus(`Custom GCP Project set to: ${customProj || 'Default (auto)'}.`, 2000);
                        });
                        return;
                    }

                    if (cur.id === 'model_mapping') {
                        await runSubScreen(async () => {
                            process.stdout.write(c.clearScreen + c.cursorHome);
                            reloadConfig();
                            let claudeSettings = readClaudeSettings();
                            claudeSettings.env = claudeSettings.env || {};

                            const MM_TABS = [
                                { id: 'slots', title: 'Claude Code Slots' },
                                { id: 'aliases', title: 'Custom Aliases' },
                                { id: 'presets', title: 'Quick Presets' }
                            ];

                            const SLOT_DEFS = [
                                {
                                    envKey: 'ANTHROPIC_MODEL',
                                    shortLabel: 'Main Model',
                                    defClient: 'claude-sonnet-5-5',
                                    defBackend: 'gemini-3.8-flash-high',
                                    desc: 'Primary interactive model slot (ANTHROPIC_MODEL in ~/.claude/settings.json)'
                                },
                                {
                                    envKey: 'CLAUDE_CODE_SUBAGENT_MODEL',
                                    shortLabel: 'Subagent Model',
                                    defClient: 'claude-haiku-5-5',
                                    defBackend: 'gemini-3.1-flash-lite',
                                    desc: 'Background subagent & search worker slot (CLAUDE_CODE_SUBAGENT_MODEL)'
                                },
                                {
                                    envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
                                    shortLabel: 'Opus Tier Slot',
                                    defClient: 'claude-opus-5-5',
                                    defBackend: 'gemini-3.8-pro',
                                    desc: 'Deep reasoning / architecture tier override (ANTHROPIC_DEFAULT_OPUS_MODEL)'
                                },
                                {
                                    envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                                    shortLabel: 'Sonnet Tier Slot',
                                    defClient: 'claude-sonnet-5-5',
                                    defBackend: 'gemini-3.8-flash-high',
                                    desc: 'Balanced coding tier override (ANTHROPIC_DEFAULT_SONNET_MODEL)'
                                },
                                {
                                    envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                                    shortLabel: 'Haiku Tier Slot',
                                    defClient: 'claude-haiku-5-5',
                                    defBackend: 'gemini-3.1-flash-lite',
                                    desc: 'Fast lightweight helper tier override (ANTHROPIC_DEFAULT_HAIKU_MODEL)'
                                }
                            ];

                            const STANDARD_SLOT_IDS = new Set([
                                'claude-opus-5-5',
                                'claude-sonnet-5-5',
                                'claude-haiku-5-5'
                            ]);

                            function getBackendCatalog() {
                                const core = [
                                    'gemini-3.8-flash-high',
                                    'gemini-3.8-pro',
                                    'gemini-2.5-flash',
                                    'gemini-2.5-pro',
                                    'gemini-3.1-flash-lite'
                                ];
                                const discovered = new Set(core);
                                for (const acc of accountsData.accounts || []) {
                                    for (const mId of Object.keys(acc.quota?.models || {})) {
                                        if (mId && !mId.startsWith('chat_')) discovered.add(mId);
                                    }
                                }
                                return Array.from(discovered);
                            }

                            let tabIdx = 0;
                            let rowIdx = 0;
                            let notice = '';
                            /*
                             * Inline 2-step editor state:
                             * mode: null | 'edit_slot' | 'edit_alias' | 'new_alias'
                             * step: 'client' | 'backend'
                             */
                            let editState = null;

                            function getCustomAliasEntries() {
                                const mm = config.modelMapping || {};
                                const slotVals = new Set(
                                    SLOT_DEFS.map((sd) => (claudeSettings.env || {})[sd.envKey] || sd.defClient)
                                );
                                const list = [];
                                for (const [alias, raw] of Object.entries(mm)) {
                                    if (STANDARD_SLOT_IDS.has(alias) && slotVals.has(alias)) continue;
                                    const target = typeof raw === 'object' ? (raw.mapping || 'gemini-3.8-flash-high') : String(raw);
                                    list.push({ alias, target });
                                }
                                return list;
                            }

                            function buildTabRows() {
                                const curTab = MM_TABS[tabIdx].id;
                                const env = claudeSettings.env || {};
                                const mm = config.modelMapping || {};

                                if (curTab === 'slots') {
                                    const rows = SLOT_DEFS.map((sd) => {
                                        const clientVal = env[sd.envKey] || sd.defClient;
                                        const backendVal = getMappingTarget(mm, clientVal) || sd.defBackend;
                                        return {
                                            type: 'slot',
                                            envKey: sd.envKey,
                                            label: sd.shortLabel,
                                            clientModel: clientVal,
                                            backendModel: backendVal,
                                            desc: `${sd.desc} — [←/→] cycle backend, [Enter] edit client ID & backend inline`
                                        };
                                    });
                                    rows.push({
                                        type: 'action',
                                        id: 'save_exit',
                                        label: 'Save & Return to Dashboard',
                                        desc: 'Sync model mappings with proxy daemon and return to main dashboard'
                                    });
                                    return rows;
                                }

                                if (curTab === 'aliases') {
                                    const aliases = getCustomAliasEntries();
                                    const rows = aliases.map((entry) => ({
                                        type: 'alias',
                                        alias: entry.alias,
                                        backendModel: entry.target,
                                        desc: `Routes client requests for "${entry.alias}" to Google "${entry.target}" — [←/→] change backend, [Enter] edit, [D] delete`
                                    }));
                                    if (editState?.mode === 'new_alias') {
                                        rows.push({
                                            type: 'new_alias_draft',
                                            alias: editState.clientBuf,
                                            backendModel: editState.backendBuf,
                                            desc: 'Type custom client alias ID, press Enter to choose Google backend, Enter again to save'
                                        });
                                    }
                                    rows.push({
                                        type: 'action',
                                        id: 'add_alias',
                                        label: '+ Register New Custom Model Alias... [N]',
                                        desc: 'Map any custom client model name (e.g. gpt-5-codex, claude-sonnet-4-5) to a Google backend model'
                                    });
                                    rows.push({
                                        type: 'action',
                                        id: 'save_exit',
                                        label: 'Save & Return to Dashboard',
                                        desc: 'Sync model mappings with proxy daemon and return to main dashboard'
                                    });
                                    return rows;
                                }

                                return [
                                    {
                                        type: 'preset',
                                        id: 'preset_default',
                                        label: 'Balanced Default Setup',
                                        summary: 'Sonnet 5.5 → 3.8-Flash-High  ·  Opus 5.5 → 3.8-Pro',
                                        desc: 'Recommended everyday coding setup: Flash-High for main/sonnet, 3.8-Pro for Opus, Flash-Lite for subagents'
                                    },
                                    {
                                        type: 'preset',
                                        id: 'preset_flex',
                                        label: 'Flagship Flex Signatures',
                                        summary: 'Claude 3.7 Sonnet & 3 Opus → 3.8-Pro / Flash-High',
                                        desc: 'Configures official Claude 3.7 Sonnet, 3.5 Haiku & 3 Opus model IDs backed by Gemini 3.8 Pro and Flash-High'
                                    },
                                    {
                                        type: 'preset',
                                        id: 'preset_pro',
                                        label: 'Deep Reasoning Pro Setup',
                                        summary: 'Main / Opus / Sonnet → 3.8-Pro  ·  Subagent → Flash-High',
                                        desc: 'Routes primary, Opus, and Sonnet tiers to Gemini 3.8 Pro for heavy architecture & debugging tasks'
                                    },
                                    {
                                        type: 'preset',
                                        id: 'clean_env',
                                        label: 'Clear Claude Code Model Overrides',
                                        summary: 'Remove model env vars from ~/.claude/settings.json',
                                        desc: 'Deletes ANTHROPIC_MODEL and tier override keys from ~/.claude/settings.json while keeping proxy endpoint active'
                                    },
                                    {
                                        type: 'action',
                                        id: 'save_exit',
                                        label: 'Save & Return to Dashboard',
                                        desc: 'Sync model mappings with proxy daemon and return to main dashboard'
                                    }
                                ];
                            }

                            function saveSlotMapping(envKey, clientModel, backendModel) {
                                claudeSettings.env = claudeSettings.env || {};
                                claudeSettings.env[envKey] = clientModel;
                                writeClaudeSettings(claudeSettings);

                                const newMm = { ...(config.modelMapping || {}) };
                                newMm[clientModel] = { mapping: backendModel };
                                config.modelMapping = newMm;
                                saveConfig({ modelMapping: newMm });
                            }

                            function saveCustomAlias(oldAlias, newAlias, backendModel) {
                                const newMm = { ...(config.modelMapping || {}) };
                                if (oldAlias && oldAlias !== newAlias) {
                                    delete newMm[oldAlias];
                                }
                                newMm[newAlias] = { mapping: backendModel };
                                config.modelMapping = newMm;
                                saveConfig({ modelMapping: newMm });
                            }

                            function renderScreen() {
                                const rows = buildTabRows();
                                if (rowIdx >= rows.length) rowIdx = Math.max(0, rows.length - 1);
                                const curTabId = MM_TABS[tabIdx].id;

                                let out = '\x1b[2J\x1b[H';
                                out += drawHeaderBox('Model Mappings, Claude Code Slots & Alias Routing', 76);

                                let tabBar = '  ';
                                MM_TABS.forEach((t, idx) => {
                                    const isAct = idx === tabIdx;
                                    const pill = isAct
                                        ? `\x1b[1;38;5;16;48;5;48m  ${t.title}  \x1b[0m`
                                        : `\x1b[38;5;249;48;5;236m  ${t.title}  \x1b[0m`;
                                    tabBar += pill + ' ';
                                });
                                out += `${tabBar}${c.clearToEndOfLine}\n`;
                                out += `  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;

                                if (curTabId === 'slots') {
                                    out += `    \x1b[38;5;242m${'Slot'.padEnd(20, ' ')}  ${'Client Model ID'.padEnd(28, ' ')}  Google Backend Engine\x1b[0m${c.clearToEndOfLine}\n`;
                                } else if (curTabId === 'aliases') {
                                    out += `    \x1b[38;5;242m${'Client Alias ID'.padEnd(32, ' ')}     Google Backend Engine\x1b[0m${c.clearToEndOfLine}\n`;
                                } else {
                                    out += `    \x1b[38;5;242m${'Preset Action'.padEnd(34, ' ')}  Target Routing Profile\x1b[0m${c.clearToEndOfLine}\n`;
                                }

                                /* Keep table height bounded inside small terminals */
                                const maxDataRows = 8;
                                const actionStartIdx = rows.findIndex((r) => r.type === 'action');
                                const dataRows = actionStartIdx === -1 ? rows : rows.slice(0, actionStartIdx);
                                const actionRows = actionStartIdx === -1 ? [] : rows.slice(actionStartIdx);

                                let winStart = 0;
                                if (dataRows.length > maxDataRows && rowIdx < actionStartIdx) {
                                    winStart = Math.max(0, Math.min(rowIdx - Math.floor(maxDataRows / 2), dataRows.length - maxDataRows));
                                }
                                const visibleData = dataRows.slice(winStart, winStart + maxDataRows);

                                if (curTabId === 'aliases' && dataRows.length === 0) {
                                    out += `    \x1b[38;5;243mNo custom model aliases configured yet. Press [N] to register one.\x1b[0m${c.clearToEndOfLine}\n`;
                                }

                                for (let v = 0; v < visibleData.length; v++) {
                                    const realIdx = winStart + v;
                                    const r = visibleData[v];
                                    const isSel = realIdx === rowIdx;
                                    const pointer = isSel ? `  \x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;

                                    if (r.type === 'slot') {
                                        const isEditingThis = isSel && editState?.mode === 'edit_slot';
                                        const col1Plain = padEndVisible(r.label, 20);
                                        const col1 = isSel ? `\x1b[1;38;5;255m${col1Plain}\x1b[0m` : `\x1b[38;5;250m${col1Plain}\x1b[0m`;

                                        let col2Raw = `[${truncateVisible(r.clientModel, 24)}]`;
                                        let col2Styled = isSel ? `\x1b[1;38;5;120m${col2Raw}\x1b[0m` : `\x1b[38;5;147m${col2Raw}\x1b[0m`;
                                        if (isEditingThis && editState.step === 'client') {
                                            col2Raw = `[ ${truncateVisible(editState.clientBuf, 22)}_ ]`;
                                            col2Styled = `\x1b[1;38;5;226;48;5;236m${col2Raw}\x1b[0m`;
                                        }
                                        const col2Pad = ' '.repeat(Math.max(1, 28 - col2Raw.length));

                                        let col3Styled = `\x1b[38;5;242m→\x1b[0m \x1b[1;38;5;51m[${r.backendModel}]\x1b[0m`;
                                        if (isEditingThis && editState.step === 'backend') {
                                            col3Styled = `\x1b[38;5;242m→\x1b[0m \x1b[1;38;5;226;48;5;236m[ ${editState.backendBuf}_ ]\x1b[0m`;
                                        }

                                        out += `${pointer}${col1}  ${col2Styled}${col2Pad}${col3Styled}${c.clearToEndOfLine}\n`;
                                    } else if (r.type === 'alias' || r.type === 'new_alias_draft') {
                                        const isEditingThis = isSel && (editState?.mode === 'edit_alias' || editState?.mode === 'new_alias');
                                        let col1Raw = `[${truncateVisible(r.alias || 'new-alias', 28)}]`;
                                        let col1Styled = isSel ? `\x1b[1;38;5;255m${col1Raw}\x1b[0m` : `\x1b[38;5;147m${col1Raw}\x1b[0m`;
                                        if (isEditingThis && editState.step === 'client') {
                                            col1Raw = `[ ${truncateVisible(editState.clientBuf, 26)}_ ]`;
                                            col1Styled = `\x1b[1;38;5;226;48;5;236m${col1Raw}\x1b[0m`;
                                        }
                                        const col1Pad = ' '.repeat(Math.max(2, 33 - col1Raw.length));

                                        let col2Styled = `\x1b[38;5;242m→\x1b[0m  \x1b[1;38;5;51m[${r.backendModel}]\x1b[0m`;
                                        if (isEditingThis && editState.step === 'backend') {
                                            col2Styled = `\x1b[38;5;242m→\x1b[0m  \x1b[1;38;5;226;48;5;236m[ ${editState.backendBuf}_ ]\x1b[0m`;
                                        }

                                        out += `${pointer}${col1Styled}${col1Pad}${col2Styled}${c.clearToEndOfLine}\n`;
                                    } else if (r.type === 'preset') {
                                        const col1Plain = padEndVisible(r.label, 34);
                                        const col1 = isSel ? `\x1b[1;38;5;255m${col1Plain}\x1b[0m` : `\x1b[38;5;250m${col1Plain}\x1b[0m`;
                                        out += `${pointer}${col1}  \x1b[38;5;244m${r.summary}\x1b[0m${c.clearToEndOfLine}\n`;
                                    }
                                }

                                if (dataRows.length > maxDataRows) {
                                    out += `    \x1b[38;5;241mShowing ${winStart + 1}–${Math.min(dataRows.length, winStart + maxDataRows)} of ${dataRows.length} entries\x1b[0m${c.clearToEndOfLine}\n`;
                                }

                                out += `  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;
                                for (let a = 0; a < actionRows.length; a++) {
                                    const realIdx = actionStartIdx + a;
                                    const act = actionRows[a];
                                    const isSel = realIdx === rowIdx;
                                    const pointer = isSel ? `  \x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;
                                    const col = act.id === 'save_exit'
                                        ? (isSel ? '\x1b[1;38;5;120m' : '\x1b[38;5;42m')
                                        : (isSel ? '\x1b[1;38;5;255m' : '\x1b[38;5;248m');
                                    out += `${pointer}${col}${act.label}${c.reset}${c.clearToEndOfLine}\n`;
                                }

                                const curRow = rows[rowIdx];
                                const wrapCols = Math.max(58, Math.min((process.stdout.columns || 88) - 6, 76));
                                out += `\n`;
                                if (editState) {
                                    const stepMsg = editState.step === 'client'
                                        ? 'Step 1/2: Type Client / Alias Model ID and press [Enter] (or [ESC] to cancel)'
                                        : 'Step 2/2: Use [←/→] to pick a Google Backend or type custom model ID, then press [Enter]';
                                    out += `  \x1b[1;38;5;220m✎ ${stepMsg}\x1b[0m${c.clearToEndOfLine}\n`;
                                } else if (notice) {
                                    out += `  \x1b[38;5;120m✓ ${notice}\x1b[0m${c.clearToEndOfLine}\n`;
                                } else if (curRow?.desc) {
                                    for (const dl of wrapPlainText(curRow.desc, wrapCols)) {
                                        out += `  ${c.textMuted}Info:${c.reset} ${c.textNormal}${dl}${c.reset}${c.clearToEndOfLine}\n`;
                                    }
                                }

                                if (editState) {
                                    out += `  ${c.textMuted}Type Model ID  ·  [←/→] Cycle Backend (Step 2)  ·  [Enter] Confirm  ·  [ESC] Cancel${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                                } else if (curTabId === 'aliases') {
                                    out += `  ${c.textMuted}[←/→] Switch Tab  ·  [↑↓] Move  ·  [Enter / Space] Cycle Backend  ·  [E] Edit  ·  [N] New  ·  [D] Delete  ·  [ESC] Exit${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                                } else {
                                    out += `  ${c.textMuted}[←/→] Switch Tab  ·  [↑↓] Move  ·  [Enter / Space] Cycle / Apply  ·  [E] Edit  ·  [ESC] Exit${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                                }

                                process.stdout.write(out);
                            }

                            await new Promise((resolve) => {
                                function cycleBackendValue(currentBackend, dir) {
                                    const catalog = getBackendCatalog();
                                    const curPos = catalog.indexOf(currentBackend);
                                    if (curPos === -1) return catalog[0];
                                    return catalog[(curPos + dir + catalog.length) % catalog.length];
                                }

                                function onKey(str, key) {
                                    if (!key) return;

                                    if (editState) {
                                        if (key.name === 'escape') {
                                            editState = null;
                                            notice = 'Cancelled inline edit.';
                                            renderScreen();
                                            return;
                                        }
                                        if (editState.step === 'backend' && (key.name === 'left' || key.name === 'right')) {
                                            const dir = key.name === 'right' ? 1 : -1;
                                            editState.backendBuf = cycleBackendValue(editState.backendBuf.trim(), dir);
                                            renderScreen();
                                            return;
                                        }
                                        if (key.name === 'backspace') {
                                            if (editState.step === 'client') {
                                                editState.clientBuf = editState.clientBuf.slice(0, -1);
                                            } else {
                                                editState.backendBuf = editState.backendBuf.slice(0, -1);
                                            }
                                            renderScreen();
                                            return;
                                        }
                                        if (key.name === 'return' || key.name === 'enter') {
                                            if (editState.step === 'client') {
                                                const cleanedClient = editState.clientBuf.trim();
                                                if (!cleanedClient) {
                                                    notice = 'Client Model ID cannot be empty.';
                                                    editState = null;
                                                    renderScreen();
                                                    return;
                                                }
                                                editState.clientBuf = cleanedClient;
                                                editState.step = 'backend';
                                                renderScreen();
                                                return;
                                            }

                                            const finalClient = editState.clientBuf.trim();
                                            const finalBackend = editState.backendBuf.trim() || 'gemini-3.8-flash-high';
                                            if (editState.mode === 'edit_slot') {
                                                saveSlotMapping(editState.envKey, finalClient, finalBackend);
                                                notice = `Updated ${editState.envKey}: [${finalClient}] -> [${finalBackend}]`;
                                            } else {
                                                saveCustomAlias(editState.origAlias || null, finalClient, finalBackend);
                                                notice = `Saved custom alias: [${finalClient}] -> [${finalBackend}]`;
                                            }
                                            editState = null;
                                            renderScreen();
                                            return;
                                        }
                                        if (str && str.length === 1 && !key.ctrl && !key.meta) {
                                            if (editState.step === 'client' && editState.clientBuf.length < 44) {
                                                editState.clientBuf += str;
                                                renderScreen();
                                            } else if (editState.step === 'backend' && editState.backendBuf.length < 44) {
                                                editState.backendBuf += str;
                                                renderScreen();
                                            }
                                        }
                                        return;
                                    }

                                    if (key.ctrl && key.name === 'r') {
                                        reloadConfig();
                                        claudeSettings = readClaudeSettings();
                                        claudeSettings.env = claudeSettings.env || {};
                                        notice = 'Reloaded model mappings from disk.';
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
                                        process.stdin.removeListener('keypress', onKey);
                                        resolve();
                                        return;
                                    }

                                    // Arrow Left / Right and Tab switch between tabs
                                    if (key.name === 'left' || key.name === 'h') {
                                        notice = '';
                                        tabIdx = (tabIdx - 1 + MM_TABS.length) % MM_TABS.length;
                                        rowIdx = 0;
                                        process.stdout.write(c.clearScreen + c.cursorHome);
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'right' || key.name === 'l') {
                                        notice = '';
                                        tabIdx = (tabIdx + 1) % MM_TABS.length;
                                        rowIdx = 0;
                                        process.stdout.write(c.clearScreen + c.cursorHome);
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'tab') {
                                        notice = '';
                                        const dir = key.shift ? -1 : 1;
                                        tabIdx = (tabIdx + dir + MM_TABS.length) % MM_TABS.length;
                                        rowIdx = 0;
                                        process.stdout.write(c.clearScreen + c.cursorHome);
                                        renderScreen();
                                        return;
                                    }

                                    const rows = buildTabRows();

                                    if (key.name === 'up' || key.name === 'k') {
                                        notice = '';
                                        rowIdx = (rowIdx - 1 + rows.length) % rows.length;
                                        renderScreen();
                                        return;
                                    }

                                    if (key.name === 'down' || key.name === 'j') {
                                        notice = '';
                                        rowIdx = (rowIdx + 1) % rows.length;
                                        renderScreen();
                                        return;
                                    }

                                    const curRow = rows[rowIdx];

                                    // Edit Model ID inline with 'e' / 'E'
                                    if ((str === 'e' || str === 'E') && curRow) {
                                        if (curRow.type === 'slot') {
                                            editState = {
                                                mode: 'edit_slot',
                                                step: 'client',
                                                envKey: curRow.envKey,
                                                clientBuf: curRow.clientModel,
                                                backendBuf: curRow.backendModel
                                            };
                                            renderScreen();
                                            return;
                                        }
                                        if (curRow.type === 'alias') {
                                            editState = {
                                                mode: 'edit_alias',
                                                step: 'client',
                                                origAlias: curRow.alias,
                                                clientBuf: curRow.alias,
                                                backendBuf: curRow.backendModel
                                            };
                                            renderScreen();
                                            return;
                                        }
                                    }

                                    // Enter or Space toggles / cycles backend or executes action
                                    if (key.name === 'return' || key.name === 'enter' || key.name === 'space') {
                                        if (!curRow) return;

                                        if (curRow.type === 'slot') {
                                            const nextBackend = cycleBackendValue(curRow.backendModel, 1);
                                            saveSlotMapping(curRow.envKey, curRow.clientModel, nextBackend);
                                            notice = `${curRow.label}: [${curRow.clientModel}] -> [${nextBackend}]`;
                                            renderScreen();
                                            return;
                                        }

                                        if (curRow.type === 'alias') {
                                            const nextBackend = cycleBackendValue(curRow.backendModel, 1);
                                            saveCustomAlias(curRow.alias, curRow.alias, nextBackend);
                                            notice = `Alias [${curRow.alias}] -> [${nextBackend}]`;
                                            renderScreen();
                                            return;
                                        }

                                        if (curRow.id === 'add_alias') {
                                            editState = {
                                                mode: 'new_alias',
                                                step: 'client',
                                                clientBuf: '',
                                                backendBuf: 'gemini-3.8-flash-high'
                                            };
                                            const updated = buildTabRows();
                                            rowIdx = Math.max(0, updated.findIndex((r) => r.type === 'new_alias_draft'));
                                            renderScreen();
                                            return;
                                        }

                                        if (curRow.id === 'preset_default') {
                                            claudeSettings.env = claudeSettings.env || {};
                                            claudeSettings.env.ANTHROPIC_MODEL = 'claude-sonnet-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5';
                                            claudeSettings.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-haiku-5-5';
                                            writeClaudeSettings(claudeSettings);

                                            const newMm = {
                                                ...(config.modelMapping || {}),
                                                'claude-opus-5-5': { mapping: 'gemini-3.8-pro' },
                                                'claude-sonnet-5-5': { mapping: 'gemini-3.8-flash-high' },
                                                'claude-haiku-5-5': { mapping: 'gemini-3.1-flash-lite' }
                                            };
                                            config.modelMapping = newMm;
                                            saveConfig({ modelMapping: newMm });
                                            notice = 'Applied Balanced Default Setup (Sonnet 5.5 -> Flash-High, Opus 5.5 -> 3.8-Pro)';
                                            renderScreen();
                                            return;
                                        }

                                        if (curRow.id === 'preset_flex') {
                                            claudeSettings.env = claudeSettings.env || {};
                                            claudeSettings.env.ANTHROPIC_MODEL = 'claude-3-7-sonnet-20250219';
                                            claudeSettings.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-3-5-haiku-20241022';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-3-opus-20240229';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-3-7-sonnet-20250219';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-3-5-haiku-20241022';
                                            writeClaudeSettings(claudeSettings);

                                            const newMm = {
                                                ...(config.modelMapping || {}),
                                                'claude-3-7-sonnet-20250219': { mapping: 'gemini-3.8-flash-high' },
                                                'claude-3-5-sonnet-20241022': { mapping: 'gemini-3.8-flash-high' },
                                                'claude-3-opus-20240229': { mapping: 'gemini-3.8-pro' },
                                                'claude-3-5-haiku-20241022': { mapping: 'gemini-3.1-flash-lite' },
                                                'claude-opus-5-5': { mapping: 'gemini-3.8-pro' },
                                                'claude-sonnet-5-5': { mapping: 'gemini-3.8-flash-high' },
                                                'claude-haiku-5-5': { mapping: 'gemini-3.1-flash-lite' }
                                            };
                                            config.modelMapping = newMm;
                                            saveConfig({ modelMapping: newMm });
                                            notice = 'Applied Flagship Flex Signatures (Claude 3.7 Sonnet & Claude 3 Opus)';
                                            renderScreen();
                                            return;
                                        }

                                        if (curRow.id === 'preset_pro') {
                                            claudeSettings.env = claudeSettings.env || {};
                                            claudeSettings.env.ANTHROPIC_MODEL = 'claude-opus-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5-5';
                                            claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5';
                                            claudeSettings.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-haiku-5-5';
                                            writeClaudeSettings(claudeSettings);

                                            const newMm = {
                                                ...(config.modelMapping || {}),
                                                'claude-opus-5-5': { mapping: 'gemini-3.8-pro' },
                                                'claude-sonnet-5-5': { mapping: 'gemini-3.8-pro' },
                                                'claude-haiku-5-5': { mapping: 'gemini-3.8-flash-high' }
                                            };
                                            config.modelMapping = newMm;
                                            saveConfig({ modelMapping: newMm });
                                            notice = 'Applied Deep Reasoning Pro Setup (Main/Opus/Sonnet -> Gemini 3.8 Pro)';
                                            renderScreen();
                                            return;
                                        }

                                        if (curRow.id === 'clean_env') {
                                            const keys = [
                                                'ANTHROPIC_MODEL',
                                                'ANTHROPIC_DEFAULT_OPUS_MODEL',
                                                'ANTHROPIC_DEFAULT_SONNET_MODEL',
                                                'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                                                'CLAUDE_CODE_SUBAGENT_MODEL',
                                                'ANTHROPIC_CLAUDE_OPUS_MODEL',
                                                'ANTHROPIC_CLAUDE_SONNET_MODEL'
                                            ];
                                            claudeSettings.env = claudeSettings.env || {};
                                            keys.forEach((k) => delete claudeSettings.env[k]);
                                            writeClaudeSettings(claudeSettings);
                                            notice = 'Cleared model override environment variables from ~/.claude/settings.json';
                                            renderScreen();
                                            return;
                                        }

                                        if (curRow.id === 'save_exit') {
                                            process.stdin.removeListener('keypress', onKey);
                                            resolve();
                                            return;
                                        }
                                    }

                                    if (!key.ctrl && !key.meta && key.name === 'n') {
                                        tabIdx = 1;
                                        editState = {
                                            mode: 'new_alias',
                                            step: 'client',
                                            clientBuf: '',
                                            backendBuf: 'gemini-3.8-flash-high'
                                        };
                                        const aliasRows = buildTabRows();
                                        rowIdx = Math.max(0, aliasRows.findIndex((r) => r.type === 'new_alias_draft'));
                                        process.stdout.write(c.clearScreen + c.cursorHome);
                                        renderScreen();
                                        return;
                                    }

                                    if (!key.ctrl && !key.meta && (key.name === 'd' || key.name === 'delete') && curRow?.type === 'alias') {
                                        const newMm = { ...(config.modelMapping || {}) };
                                        delete newMm[curRow.alias];
                                        config.modelMapping = newMm;
                                        saveConfig({ modelMapping: newMm });
                                        notice = `Removed custom alias [${curRow.alias}]`;
                                        rowIdx = Math.max(0, rowIdx - 1);
                                        process.stdout.write(c.clearScreen + c.cursorHome);
                                        renderScreen();
                                        return;
                                    }
                                }

                                activeSubScreenRender = renderScreen;
                                process.stdin.on('keypress', onKey);
                                renderScreen();
                            });

                            try {
                                await fetch(`http://127.0.0.1:${port}/reload`, {
                                    method: 'POST',
                                    signal: AbortSignal.timeout(1500)
                                });
                            } catch {}
                            setStatus('Model Mappings synced with Claude Code & live proxy daemon.', 2200);
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
                                const isInvalid = acc.isInvalid || live.status === 'invalid' || live.status === 'banned' || live.status === 'verify-required';
                                const hasVerifyUrl = !!(acc.verifyUrl || live.verifyUrl);
                                const reasonLower = (acc.invalidReason || live.error || '').toLowerCase();
                                const isBanned = !hasVerifyUrl && (
                                    live.status === 'banned' ||
                                    reasonLower.includes('tos') ||
                                    reasonLower.includes('banned') ||
                                    reasonLower.includes('suspended') ||
                                    reasonLower.includes('terms of service')
                                );
                                const isLimited = live.status === 'rate-limit' || live.status === 'rate-limited' || (live.rateLimitReset && live.rateLimitReset > Date.now());
                                const isDisabled = !acc.enabled;

                                if (isInvalid || hasVerifyUrl || isBanned || isLimited || isDisabled) {
                                    problems.push({
                                        index: i + 1,
                                        account: acc,
                                        isInvalid,
                                        isBanned,
                                        hasVerifyUrl,
                                        isLimited,
                                        isDisabled
                                    });
                                }
                            });

                            let selectedProblemIdx = 0;

                            function renderScreen() {
                                let out = c.cursorHome;
                                out += drawHeaderBox('Problem Accounts Diagnostics & Resolution', 76);
                                out += `${c.clearToEndOfLine}\n`;

                                if (problems.length === 0) {
                                    out += `  \x1b[1;38;5;48m✓ All accounts are active and ready in pool.${c.reset}${c.clearToEndOfLine}\n`;
                                    out += `  ${c.textMuted}• ${accountsData.accounts.length} accounts configured for request routing.${c.reset}${c.clearToEndOfLine}\n\n`;
                                    out += `  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;
                                    out += `  ${c.textMuted}Details:${c.reset} ${c.textNormal}All accounts are ready. Press Enter or ESC to return.${c.reset}${c.clearToEndOfLine}\n`;
                                    out += `  ${c.textMuted}[Enter / ESC] Return to Dashboard${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                                    process.stdout.write(out);
                                    return;
                                }

                                for (let i = 0; i < problems.length; i++) {
                                    const p = problems[i];
                                    const isSel = i === selectedProblemIdx;
                                    const pointer = isSel ? `  \x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;

                                    let badge = '';
                                    if (p.hasVerifyUrl) badge = `${c.statusDanger}[verify-req]${c.reset}`;
                                    else if (p.isBanned) badge = `${c.statusDanger}[banned]${c.reset}`;
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
                                else if (curP.isBanned) fixAction = 'Service restricted by Google (ToS) · Auto-refresh locked; appeal via Google Support';
                                else if (curP.isInvalid) fixAction = 'Press R on Dashboard to re-authenticate via OAuth';
                                else if (curP.isLimited) fixAction = 'Account cooling down · Auto-recovers when quota resets';
                                else if (curP.isDisabled) fixAction = 'Press T on Dashboard to re-enable account in pool';

                                out += `\n  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;
                                out += `  ${c.textMuted}Details:${c.reset} ${c.textNormal}${fixAction}${c.reset}${c.clearToEndOfLine}\n`;
                                out += `  ${c.textMuted}[↑↓] Move  ·  [Enter / ESC] Return to Dashboard${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                                process.stdout.write(out);
                            }

                            await new Promise((resolve) => {
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

                                activeSubScreenRender = renderScreen;
                                process.stdin.on('keypress', onKey);
                                renderScreen();
                            });
                        });
                        return;
                    }

                    if (cur.id === 'engine_settings') {
                        await openEngineSettings();
                        return;
                    }

                    if (cur.id === 'reload_dashboard') {
                        process.stdout.write(c.clearScreen + c.cursorHome);
                        await refreshData(true);
                        items = getItems();
                        render();
                        return;
                    }

                    if (cur.id === 'add_account') {
                        await runSubScreen(async () => {
                            await loginAccount();
                            console.log(`\n${c.actionGreen}✓ Automatically returning to dashboard in 1.5s...${c.reset}`);
                            await new Promise(r => setTimeout(r, 1500));
                            setStatus('Account login completed.', 2000);
                        }, { lineMode: true });
                        return;
                    }
                }
            }

            const getAccountVerifyUrl = (acc) => {
                if (!acc) return null;
                if (acc.verifyUrl) return acc.verifyUrl;
                const liveAcc = Array.isArray(proxyHealth?.accounts)
                    ? proxyHealth.accounts.find((a) => a.email === acc.email)
                    : null;
                return liveAcc?.verifyUrl || null;
            };

            const doVerifyAccount = async (cur) => {
                const verifyUrl = getAccountVerifyUrl(cur.account);
                if (verifyUrl) {
                    try {
                        const { exec } = await import('child_process');
                        const startCmd = process.platform === 'win32' ? `start "" "${verifyUrl}"` : `open "${verifyUrl}"`;
                        exec(startCmd);
                        setStatus(`Opened Google verification link for Account ${cur.accountIndex + 1}.`, 2500);
                    } catch {
                        setStatus('Could not launch browser automatically. Verification URL is stored on account.', 2500);
                    }
                } else {
                    setStatus(`Account ${cur.accountIndex + 1} has no pending Google verification link.`, 2200);
                }
            };

            const doReloginAccount = async (cur) => {
                const accNum = cur.accountIndex + 1;
                await runSubScreen(async () => {
                    console.log(`${c.actionGreen}Re-authenticating Account ${accNum} (${cur.account.email})...${c.reset}\n`);
                    await loginAccount();
                    console.log(`\n${c.actionGreen}✓ Re-authentication finished. Returning in 1.5s...${c.reset}`);
                    await new Promise(r => setTimeout(r, 1500));
                    setStatus(`Account ${accNum} re-authentication completed.`, 2000);
                }, { lineMode: true });
            };

            const doToggleAccount = async (cur) => {
                const accNum = cur.accountIndex + 1;
                const newStatus = await toggleAccount(accNum.toString());
                setStatus(`Account ${accNum} (${cur.account.email}): ${newStatus}.`, 2000);
                await refreshData();
                items = getItems();
                render();
            };

            const doDeleteAccount = async (cur) => {
                const accNum = cur.accountIndex + 1;
                await runSubScreen(async () => {
                    console.log(`${c.statusDanger}Are you sure you want to delete Account ${accNum} (${cur.account.email})?${c.reset}`);
                    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                    const confirm = await new Promise(r => rl.question('Type "yes" to confirm deletion: ', r));
                    rl.close();
                    if (confirm.trim().toLowerCase() === 'yes') {
                        await removeAccount(accNum.toString());
                        console.log(`\n${c.actionGreen}✓ Account deleted. Returning to dashboard in 1.5s...${c.reset}`);
                        await new Promise(r => setTimeout(r, 1500));
                        setStatus(`Deleted Account ${accNum}.`, 2000);
                    } else {
                        setStatus('Account deletion cancelled.', 2000);
                    }
                }, { lineMode: true });
            };

            const openAccountActionsMenu = async (cur) => {
                const acc = cur.account;
                const accNum = cur.accountIndex + 1;
                const verifyUrl = getAccountVerifyUrl(acc);
                const isDisabled = acc.enabled === false;
                let pickedAction = null;

                await runSubScreen(async () => {
                    const menuItems = [
                        {
                            id: 'switch',
                            keyHint: 'Enter',
                            label: cur.isCurrent ? 'Keep as Active Account (Current)' : 'Set as Active Account',
                            desc: 'Route proxy traffic through this account immediately'
                        },
                        {
                            id: 'relogin',
                            keyHint: 'R',
                            label: 'Re-login via Google OAuth',
                            desc: 'Open Google sign-in in browser to refresh an expired or revoked token'
                        },
                        {
                            id: 'toggle',
                            keyHint: 'T',
                            label: isDisabled ? 'Enable Account in Pool' : 'Disable Account in Pool',
                            desc: isDisabled
                                ? 'Resume routing requests to this account'
                                : 'Temporarily pause this account without deleting its saved token'
                        },
                        {
                            id: 'verify',
                            keyHint: 'V',
                            label: verifyUrl ? 'Open Google Verification Link (Pending!)' : 'Open Google Verification Link (None Pending)',
                            desc: verifyUrl
                                ? 'Open Google security / Terms check URL in browser to clear [verify-req]'
                                : 'No verification challenge is currently flagged on this account'
                        },
                        {
                            id: 'delete',
                            keyHint: 'D',
                            label: 'Delete Account from atc',
                            danger: true,
                            desc: 'Permanently remove this account from accounts.json (asks confirmation)'
                        },
                        {
                            id: 'cancel',
                            keyHint: 'ESC',
                            label: 'Back to Dashboard',
                            desc: 'Return without making changes'
                        }
                    ];

                    let selIdx = 0;

                    function renderMenu() {
                        let out = c.cursorHome;
                        out += drawHeaderBox(`Manage Account #${accNum}`, 76);
                        out += `  ${c.textMuted}Email:${c.reset} \x1b[1;38;5;255m${acc.email}${c.reset}${cur.isCurrent ? ` ${c.statusCurrent}[current]${c.reset}` : ''}${c.clearToEndOfLine}\n\n`;

                        for (let i = 0; i < menuItems.length; i++) {
                            const mi = menuItems[i];
                            const isSel = i === selIdx;
                            const pointer = isSel ? `  \x1b[1;38;5;48m> ` : `  \x1b[38;5;240m· `;
                            const keyBadge = `\x1b[38;5;245m[${mi.keyHint}]\x1b[0m`;
                            let labelStr = '';
                            if (mi.danger) {
                                labelStr = isSel
                                    ? `\x1b[1;38;5;203m${mi.label.padEnd(44, ' ')}${c.reset}`
                                    : `\x1b[38;5;167m${mi.label.padEnd(44, ' ')}${c.reset}`;
                            } else {
                                labelStr = isSel
                                    ? `\x1b[1;38;5;255m${mi.label.padEnd(44, ' ')}${c.reset}`
                                    : `\x1b[38;5;250m${mi.label.padEnd(44, ' ')}${c.reset}`;
                            }
                            out += `${pointer}${labelStr} ${keyBadge}${c.clearToEndOfLine}\n`;
                        }

                        const curMi = menuItems[selIdx];
                        out += `\n  \x1b[38;5;238m${'─'.repeat(76)}\x1b[0m${c.clearToEndOfLine}\n`;
                        out += `  ${c.textMuted}Details:${c.reset} ${c.textNormal}${curMi.desc}${c.reset}${c.clearToEndOfLine}\n`;
                        out += `  ${c.textMuted}[↑↓] Move  ·  [Enter] Run Action  ·  [R/T/V/D] Direct Shortcut  ·  [ESC] Back${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
                        process.stdout.write(out);
                    }

                    await new Promise((resolve) => {
                        function onKey(str, key) {
                            if (!key) return;
                            if (key.name === 'escape' || key.name === 'q' || key.name === 'space' || (key.ctrl && key.name === 'c')) {
                                process.stdin.removeListener('keypress', onKey);
                                resolve();
                                return;
                            }
                            if (key.name === 'up' || key.name === 'k') {
                                selIdx = (selIdx - 1 + menuItems.length) % menuItems.length;
                                renderMenu();
                                return;
                            }
                            if (key.name === 'down' || key.name === 'j') {
                                selIdx = (selIdx + 1) % menuItems.length;
                                renderMenu();
                                return;
                            }
                            if (!key.ctrl && !key.meta && ['r', 't', 'v', 'd'].includes(key.name)) {
                                const map = { r: 'relogin', t: 'toggle', v: 'verify', d: 'delete' };
                                pickedAction = map[key.name];
                                process.stdin.removeListener('keypress', onKey);
                                resolve();
                                return;
                            }
                            if (key.name === 'return' || key.name === 'enter') {
                                pickedAction = menuItems[selIdx].id;
                                process.stdin.removeListener('keypress', onKey);
                                resolve();
                            }
                        }

                        activeSubScreenRender = renderMenu;
                        process.stdin.on('keypress', onKey);
                        renderMenu();
                    });
                });

                if (!pickedAction || pickedAction === 'cancel') return;
                if (pickedAction === 'switch') {
                    setStatus(`Switching to Account ${accNum} (${acc.email})...`, 2000);
                    await switchAccount(accNum.toString());
                    await refreshData();
                    items = getItems();
                    render();
                } else if (pickedAction === 'relogin') {
                    await doReloginAccount(cur);
                } else if (pickedAction === 'toggle') {
                    await doToggleAccount(cur);
                } else if (pickedAction === 'verify') {
                    await doVerifyAccount(cur);
                } else if (pickedAction === 'delete') {
                    await doDeleteAccount(cur);
                }
            };

            // Keyboard Shortcuts (guarded against Ctrl/Alt chord collisions such as Ctrl+D / Ctrl+R)
            if (!key.ctrl && !key.meta && (key.name === 'space' || key.name === 'a' || key.name === 'm')) {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    await openAccountActionsMenu(cur);
                }
                return;
            }

            if (!key.ctrl && !key.meta && key.name === 'v') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    await doVerifyAccount(cur);
                }
                return;
            }

            if (!key.ctrl && !key.meta && key.name === 'r') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    await doReloginAccount(cur);
                }
                return;
            }

            if (!key.ctrl && !key.meta && key.name === 't') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    await doToggleAccount(cur);
                }
                return;
            }

            if (!key.ctrl && !key.meta && key.name === 'd') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    await doDeleteAccount(cur);
                }
                return;
            }
        }

        process.stdin.on('keypress', onKeypress);
    });
}

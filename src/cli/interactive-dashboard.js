import readline from 'readline';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { loadAccounts, saveAccounts } from '../account-manager/storage.js';
import {
    getProxyPort,
    getServicePid,
    loginAccount,
    checkAccounts,
    switchAccount,
    toggleAccount,
    removeAccount,
    showModelMappings
} from './terminal-manager.js';

// Calibrated ANSI color palette for high contrast and readability on dark terminals
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',

    // Calibrated 256-color tones
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
    clearScreen: '\x1b[2J\x1b[H',
    cursorHome: '\x1b[H',
    clearToEndOfLine: '\x1b[K',
    clearToEndOfScreen: '\x1b[J',
    hideCursor: '\x1b[?25l',
    showCursor: '\x1b[?25h'
};

function formatBar(ratio, width = 10) {
    if (typeof ratio !== 'number' || isNaN(ratio)) ratio = 0;
    const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
    const empty = width - filled;
    const bar = '#'.repeat(filled);
    const dash = '-'.repeat(empty);

    let fillColor = c.barFill;
    if (ratio < 0.2) fillColor = c.statusDanger;
    else if (ratio < 0.5) fillColor = c.statusWarn;

    return `${fillColor}${bar}${c.barEmpty}${dash}${c.reset}`;
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

export async function runInteractiveDashboard() {
    let accountsData = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const port = getProxyPort();

    let proxyHealth = null;
    let proxyLimits = null;
    let statusMessage = '';

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

    // Build selectable items list
    function getItems() {
        const list = [];

        list.push({ type: 'header', label: 'Quick Actions' });
        list.push({ type: 'action', id: 'add_account', label: 'Add New Account' });
        list.push({ type: 'action', id: 'health_check', label: 'Run Health Check' });
        list.push({ type: 'action', id: 'pick_best', label: 'Pick Best Account' });
        list.push({ type: 'action', id: 'models', label: 'API credentials and models' });

        list.push({ type: 'header', label: 'Advanced Checks' });
        list.push({ type: 'action', id: 'refresh_all', label: 'Refresh All Accounts' });
        list.push({ type: 'action', id: 'check_problem', label: 'Check Problem Accounts' });

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

        list.push({ type: 'header', label: 'Danger Zone' });
        list.push({ type: 'action', id: 'toggle_current', label: 'Toggle Selected Account' });
        list.push({ type: 'action', id: 'delete_current', label: 'Delete Selected Account' });

        return list;
    }

    let items = getItems();
    // Default focus on active account or first item
    let selectedIndex = items.findIndex(it => it.type === 'account' && it.isCurrent);
    if (selectedIndex === -1) selectedIndex = items.findIndex(it => it.type === 'account') || 1;
    if (selectedIndex === -1) selectedIndex = 1;

    // Enter alternate screen buffer & hide cursor for 100% flicker-free & isolated TUI
    process.stdout.write(c.enterAltScreen + c.hideCursor);

    // Flicker-free render function using virtual buffer and cursor home
    function render() {
        let buf = c.hideCursor + c.cursorHome;

        // Header Title (clean, no unwanted '+' symbols)
        buf += `${c.brandGreen}Accounts Dashboard (atc v2.9.1)${c.reset}${c.clearToEndOfLine}\n\n`;

        const liveMap = new Map();
        if (proxyHealth && Array.isArray(proxyHealth.accounts)) {
            for (const a of proxyHealth.accounts) {
                liveMap.set(a.email, a);
            }
        }

        const limitsMap = new Map();
        if (proxyLimits && Array.isArray(proxyLimits.accounts)) {
            for (const a of proxyLimits.accounts) {
                limitsMap.set(a.email, a);
            }
        }

        // Render sections
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const isSelected = i === selectedIndex;

            if (it.type === 'header') {
                buf += `${c.textBright}${it.label}${c.reset}${c.clearToEndOfLine}\n`;
                continue;
            }

            if (it.type === 'action') {
                let pointer = isSelected ? `${c.cursorGreen}> ` : `  ${c.textDark}o `;
                let text = isSelected
                    ? `${c.activeBright}${it.label}${c.reset}`
                    : `${c.actionGreen}${it.label}${c.reset}`;

                if (it.id === 'delete_current') {
                    text = isSelected
                        ? `${c.bold}${c.statusDanger}${it.label}${c.reset}`
                        : `${c.statusDanger}${it.label}${c.reset}`;
                }
                buf += `${pointer}${text}${c.clearToEndOfLine}\n`;
                continue;
            }

            if (it.type === 'account') {
                const acc = it.account;
                const idx = it.accountIndex + 1;
                const live = liveMap.get(acc.email) || {};
                const lim = limitsMap.get(acc.email) || {};

                const isInvalid = acc.isInvalid || live.status === 'invalid';
                const isLimited = Object.values(acc.modelRateLimits || {}).some(
                    l => l.isRateLimited && l.resetTime > Date.now()
                ) || (live.rateLimitCooldownRemaining > 0);

                // Detect plan from limits API or account stored subscription
                const planTier = lim.subscription?.tier || acc.subscription?.tier || 'free';
                const planBadge = formatPlanBadge(planTier);

                let badges = [planBadge];
                if (it.isCurrent) badges.push(`${c.statusCurrent}[current]${c.reset}`);
                if (!acc.enabled) badges.push(`${c.statusMuted}[disabled]${c.reset}`);
                else if (isInvalid) badges.push(`${c.statusDanger}[invalid]${c.reset}`);
                else if (isLimited) badges.push(`${c.statusWarn}[rate-limited]${c.reset}`);
                else badges.push(`${c.statusOk}[ok]${c.reset}`);

                let pointer = isSelected ? `${c.cursorGreen}> ` : `  ${c.textDark}o `;
                let emailStr = isSelected
                    ? `${c.activeBright}${idx}. ${acc.email}${c.reset}`
                    : `${c.textNormal}${idx}. ${acc.email}${c.reset}`;

                buf += `${pointer}${emailStr} ${badges.join(' ')}${c.clearToEndOfLine}\n`;

                // Dynamic details pane when hovered (minimalist clean layout)
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

                    const usageStr = `${usageColor}${usedPct}% used${c.reset} ${c.textDark}(${remainingPct}% left)${c.reset}`;

                    let resetStr = '';
                    if (primary.resetTime) {
                        const diff = new Date(primary.resetTime).getTime() - Date.now();
                        if (diff > 0) {
                            resetStr = ` ${c.textDark}|${c.reset} ${c.textMuted}Resets:${c.reset} in ${formatDuration(diff)}`;
                        }
                    }

                    const projectId = lim.subscription?.projectId || acc.subscription?.projectId;
                    const projectStr = projectId ? ` ${c.textDark}|${c.reset} ${c.textMuted}Project:${c.reset} ${projectId}` : '';
                    const invalidHint = isInvalid ? ` ${c.textDark}|${c.reset} ${c.statusDanger}press R to re-login${c.reset}` : '';

                    buf += `  ${c.textMuted}Last used:${c.reset} ${timeAgo} ${c.textDark}|${c.reset} ${c.textMuted}Usage:${c.reset} ${usageStr}${resetStr}${projectStr}${invalidHint}${c.clearToEndOfLine}\n`;
                }
            }
        }

        buf += `\n`;
        if (statusMessage) {
            buf += `${c.statusWarn}ℹ ${statusMessage}${c.reset}${c.clearToEndOfLine}\n`;
        }
        buf += `${c.textMuted}↑↓ Move | Enter Select | R Re-login | 1-9 Switch | Q Back${c.reset}${c.clearToEndOfLine}\n`;

        // Clear any leftover lines below to prevent double text
        buf += c.clearToEndOfScreen;

        // Single write to stdout guarantees 0% screen flicker
        process.stdout.write(buf);
    }

    // Set up interactive raw terminal input
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onResize = () => render();
    process.stdout.on('resize', onResize);

    render();

    return new Promise((resolve) => {
        function cleanupAndExit() {
            process.stdout.removeListener('resize', onResize);
            process.stdout.write(c.exitAltScreen + c.showCursor);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            process.stdin.pause();
            process.stdin.removeListener('keypress', onKeypress);
            console.log('\nExited dashboard.\n');
            resolve();
        }

        async function onKeypress(str, key) {
            if (!key) return;

            // Handle exit keys
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

            // 'R' or 'r': Re-login account currently under cursor
            if (str === 'r' || str === 'R') {
                const cur = items[selectedIndex];
                if (cur && cur.type === 'account') {
                    const email = cur.account.email;
                    process.stdout.write(c.exitAltScreen + c.showCursor);
                    if (process.stdin.isTTY) process.stdin.setRawMode(false);
                    console.log(c.clearScreen);
                    await loginAccount({ targetEmail: email });
                    console.log(`\n${c.textMuted}Press Enter to return to dashboard...${c.reset}`);
                    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                    await new Promise(r => rl.once('line', r));
                    rl.close();
                    process.stdout.write(c.enterAltScreen + c.hideCursor);
                    if (process.stdin.isTTY) process.stdin.setRawMode(true);
                    process.stdin.resume();
                    await refreshData();
                    items = getItems();
                    statusMessage = `Refreshed credentials for ${email}.`;
                    render();
                    return;
                } else {
                    statusMessage = 'Move cursor to an account in Saved Accounts to re-login.';
                    render();
                    return;
                }
            }

            // Arrow keys navigation
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

            // Selection action
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
                    if (cur.id === 'pick_best') {
                        // Find ready account with highest quota
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
                        statusMessage = `Picking best account (Account ${bestIdx})...`;
                        render();
                        await switchAccount(bestIdx.toString());
                        await refreshData();
                        items = getItems();
                        statusMessage = `Switched to best account: Account ${bestIdx}.`;
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

                    if (cur.id === 'models') {
                        process.stdout.write(c.showCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(false);
                        console.log(c.clearScreen);
                        showModelMappings();
                        console.log(`${c.textMuted}Press Enter to return to dashboard...${c.reset}`);
                        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                        await new Promise(r => rl.once('line', r));
                        rl.close();
                        if (process.stdin.isTTY) process.stdin.setRawMode(true);
                        process.stdin.resume();
                        render();
                        return;
                    }

                    if (cur.id === 'health_check') {
                        process.stdout.write(c.showCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(false);
                        console.log(c.clearScreen);
                        await checkAccounts();
                        console.log(`${c.textMuted}Press Enter to return to dashboard...${c.reset}`);
                        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                        await new Promise(r => rl.once('line', r));
                        rl.close();
                        if (process.stdin.isTTY) process.stdin.setRawMode(true);
                        process.stdin.resume();
                        await refreshData();
                        items = getItems();
                        render();
                        return;
                    }

                    if (cur.id === 'add_account') {
                        process.stdout.write(c.showCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(false);
                        console.log(c.clearScreen);
                        await loginAccount();
                        console.log(`${c.textMuted}Press Enter to return to dashboard...${c.reset}`);
                        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                        await new Promise(r => rl.once('line', r));
                        rl.close();
                        if (process.stdin.isTTY) process.stdin.setRawMode(true);
                        process.stdin.resume();
                        await refreshData();
                        items = getItems();
                        render();
                        return;
                    }

                    if (cur.id === 'toggle_current') {
                        const accItem = items.find((it, idx) => idx === selectedIndex && it.type === 'account') ||
                                        items.find(it => it.type === 'account' && it.isCurrent);
                        if (accItem) {
                            const target = (accItem.accountIndex + 1).toString();
                            await toggleAccount(target);
                            await refreshData();
                            items = getItems();
                            statusMessage = `Toggled account ${target}.`;
                            render();
                        }
                        return;
                    }

                    if (cur.id === 'delete_current') {
                        const accItem = items.find((it, idx) => idx === selectedIndex && it.type === 'account') ||
                                        items.find(it => it.type === 'account' && it.isCurrent);
                        if (accItem) {
                            const email = accItem.account.email;
                            process.stdout.write(c.showCursor);
                            if (process.stdin.isTTY) process.stdin.setRawMode(false);
                            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                            const ans = await new Promise(r => rl.question(`\nAre you sure you want to remove ${email}? [y/N]: `, r));
                            rl.close();
                            if (ans.toLowerCase() === 'y') {
                                await removeAccount(email);
                                await refreshData();
                                items = getItems();
                                selectedIndex = Math.min(selectedIndex, items.length - 1);
                                statusMessage = `Deleted account ${email}.`;
                            }
                            if (process.stdin.isTTY) process.stdin.setRawMode(true);
                            process.stdin.resume();
                            render();
                        }
                        return;
                    }
                }
            }
        }

        process.stdin.on('keypress', onKeypress);
    });
}

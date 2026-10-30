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

// ANSI escape sequences
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    brightGreen: '\x1b[92m',
    yellow: '\x1b[33m',
    brightYellow: '\x1b[93m',
    red: '\x1b[31m',
    brightRed: '\x1b[91m',
    cyan: '\x1b[36m',
    brightCyan: '\x1b[96m',
    gray: '\x1b[90m',
    white: '\x1b[37m',
    clearScreen: '\x1b[2J\x1b[H',
    hideCursor: '\x1b[?25l',
    showCursor: '\x1b[?25h'
};

function formatBar(ratio, width = 10) {
    if (typeof ratio !== 'number' || isNaN(ratio)) ratio = 0;
    const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
    const empty = width - filled;
    const bar = '#'.repeat(filled);
    const dash = '-'.repeat(empty);
    if (ratio >= 0.5) {
        return `${c.brightGreen}${bar}${c.gray}${dash}${c.reset}`;
    } else if (ratio >= 0.2) {
        return `${c.brightYellow}${bar}${c.gray}${dash}${c.reset}`;
    }
    return `${c.brightRed}${bar}${c.gray}${dash}${c.reset}`;
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

export async function runInteractiveDashboard() {
    let accountsData = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const port = getProxyPort();

    let proxyHealth = null;
    let statusMessage = '';

    async function refreshData() {
        accountsData = await loadAccounts(ACCOUNT_CONFIG_PATH);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`, {
                signal: AbortSignal.timeout(3000)
            });
            if (res.ok) {
                proxyHealth = await res.json();
            }
        } catch {
            proxyHealth = null;
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
    // Default focus on first saved account or first action
    let selectedIndex = items.findIndex(it => it.type === 'account') || 1;
    if (selectedIndex === -1) selectedIndex = 1;

    function render() {
        process.stdout.write(c.clearScreen + c.hideCursor);

        // Header
        console.log(`${c.brightGreen}+ Accounts Dashboard (atc v2.9.1)${c.reset}\n`);

        const liveMap = new Map();
        if (proxyHealth && Array.isArray(proxyHealth.accounts)) {
            for (const a of proxyHealth.accounts) {
                liveMap.set(a.email, a);
            }
        }

        // Render each item
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const isSelected = i === selectedIndex;

            if (it.type === 'header') {
                console.log(`${c.bold}${it.label}${c.reset}`);
                continue;
            }

            if (it.type === 'action') {
                let pointer = isSelected ? `${c.brightGreen}> ` : `  ${c.gray}o `;
                let text = isSelected ? `${c.bold}${c.brightGreen}${it.label}${c.reset}` : `${c.green}${it.label}${c.reset}`;
                if (it.id === 'delete_current') {
                    text = isSelected ? `${c.bold}${c.brightRed}${it.label}${c.reset}` : `${c.red}${it.label}${c.reset}`;
                }
                console.log(`${pointer}${text}`);
                continue;
            }

            if (it.type === 'account') {
                const acc = it.account;
                const idx = it.accountIndex + 1;
                const live = liveMap.get(acc.email) || {};

                const isInvalid = acc.isInvalid || live.status === 'invalid';
                const isLimited = Object.values(acc.modelRateLimits || {}).some(
                    l => l.isRateLimited && l.resetTime > Date.now()
                ) || (live.rateLimitCooldownRemaining > 0);

                let badges = [];
                if (it.isCurrent) badges.push(`${c.brightGreen}[current]${c.reset}`);
                if (!acc.enabled) badges.push(`${c.gray}[disabled]${c.reset}`);
                else if (isInvalid) badges.push(`${c.brightRed}[invalid]${c.reset}`);
                else if (isLimited) badges.push(`${c.brightYellow}[rate-limited]${c.reset}`);
                else badges.push(`${c.green}[ok]${c.reset}`);

                let pointer = isSelected ? `${c.brightGreen}> ` : `  ${c.gray}o `;
                let emailStr = isSelected
                    ? `${c.bold}${c.brightGreen}${idx}. ${acc.email}${c.reset}`
                    : `${c.bold}${idx}. ${acc.email}${c.reset}`;

                console.log(`${pointer}${emailStr} ${badges.join(' ')}`);

                // If selected, display detailed limits progress bars like screenshot
                if (isSelected) {
                    const models = live.models || {};
                    const high = models['gemini-3.8-flash-high'] || {};
                    const med = models['gemini-3.8-flash-medium'] || {};

                    const highFrac = typeof high.remainingFraction === 'number' ? high.remainingFraction : 1.0;
                    const highPct = high.remaining || '100%';
                    const medFrac = typeof med.remainingFraction === 'number' ? med.remainingFraction : 1.0;
                    const medPct = med.remaining || '100%';

                    const highBar = formatBar(highFrac, 10);
                    const medBar = formatBar(medFrac, 10);
                    const timeAgo = formatTimeAgo(acc.lastUsed);

                    let statusTag = isLimited ? `${c.brightYellow}rate-limited${c.reset}` : `${c.brightGreen}active${c.reset}`;
                    if (isInvalid) statusTag = `${c.brightRed}invalid${c.reset}`;

                    console.log(`  ${c.gray}Last used:${c.reset} ${timeAgo} | ${c.gray}High:${c.reset} ${highBar} ${highPct} | ${c.gray}Med:${c.reset} ${medBar} ${medPct} | ${statusTag}`);
                }
            }
        }

        console.log('');
        if (statusMessage) {
            console.log(`${c.brightYellow}ℹ ${statusMessage}${c.reset}`);
        }
        console.log(`${c.gray}↑↓ Move | Enter Select | 1-9 Switch | Q Back${c.reset}`);
        console.log(`${c.brightGreen}+${c.reset}`);
    }

    // Set up interactive raw terminal input
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    render();

    return new Promise((resolve) => {
        function cleanupAndExit() {
            process.stdout.write(c.showCursor);
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
                        accountsData.accounts.forEach((acc, i) => {
                            if (!acc.enabled || acc.isInvalid) return;
                            const live = liveMap.get(acc.email) || {};
                            const high = live.models?.['gemini-3.8-flash-high'];
                            const score = high?.remainingFraction || 0.5;
                            if (score > bestScore) {
                                bestScore = score;
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
                        statusMessage = 'Refreshing quotas from proxy...';
                        render();
                        await refreshData();
                        statusMessage = 'Refreshed quotas from proxy.';
                        render();
                        return;
                    }

                    if (cur.id === 'check_problem') {
                        const problems = accountsData.accounts.filter(a => a.isInvalid);
                        statusMessage = `Problem accounts: ${problems.length} invalid.`;
                        render();
                        return;
                    }

                    if (cur.id === 'models') {
                        process.stdout.write(c.showCursor);
                        if (process.stdin.isTTY) process.stdin.setRawMode(false);
                        console.log(c.clearScreen);
                        showModelMappings();
                        console.log(`${c.gray}Press Enter to return to dashboard...${c.reset}`);
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
                        console.log(`${c.gray}Press Enter to return to dashboard...${c.reset}`);
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
                        console.log(`${c.gray}Press Enter to return to dashboard...${c.reset}`);
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
                        // Toggle account under cursor if focused on account, or active account
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

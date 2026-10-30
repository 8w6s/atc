import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CHANGELOG_TXT_PATH = join(__dirname, '..', 'changelogs.txt');
const CONFIG_DIR = dirname(ACCOUNT_CONFIG_PATH);
const USER_CHANGELOG_MD = join(CONFIG_DIR, 'CHANGELOG.md');

// ANSI Color Palette
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    underline: '\x1b[4m',

    cyan: '\x1b[36m',
    bCyan: '\x1b[96m',
    green: '\x1b[32m',
    bGreen: '\x1b[92m',
    yellow: '\x1b[33m',
    bYellow: '\x1b[93m',
    red: '\x1b[31m',
    bRed: '\x1b[91m',
    magenta: '\x1b[35m',
    bMagenta: '\x1b[95m',
    gray: '\x1b[90m',
    white: '\x1b[97m',

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

/**
 * Validate semver tag with required 'v' prefix, e.g. [v1.0.0], [v0.9.5-beta]
 */
export function isValidVersionTag(tag) {
    if (!tag || typeof tag !== 'string') return false;
    // Semver with mandatory 'v' prefix
    return /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(tag);
}

/**
 * Parse changelogs.txt into structured version pages
 */
export function parseChangelogFile(filePath = CHANGELOG_TXT_PATH) {
    if (!existsSync(filePath)) return [];

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const pages = [];
    let current = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // Check for version header: [vX.X.X]
        const versionMatch = line.match(/^\[(v[^\]]+)\]$/);
        if (versionMatch) {
            const vStr = versionMatch[1];
            if (isValidVersionTag(vStr)) {
                if (current) pages.push(current);
                current = {
                    version: vStr,
                    rawTag: line,
                    items: []
                };
                continue;
            }
        }

        if (!current) continue;

        // Check for entry tags: [NEW], [FIX], [CHANGED], [REMOVED], [IMPROVED]
        const itemMatch = line.match(/^\[([A-Z]+)\]\s*(.*)$/);
        if (itemMatch) {
            current.items.push({
                tag: itemMatch[1],
                text: itemMatch[2]
            });
        } else {
            // Append continuation text or un-tagged bullet
            current.items.push({
                tag: 'OTHER',
                text: line
            });
        }
    }

    if (current) pages.push(current);
    return pages;
}

/**
 * Sync parsed changelog into user configuration directory ~/.config/atc/CHANGELOG.md
 */
export function syncUserChangelog(destPath = USER_CHANGELOG_MD) {
    const pages = parseChangelogFile();
    if (pages.length === 0) return false;

    let md = `# atc Changelog\n\n`;
    md += `All notable changes to the atc proxy and multi-account manager.\n\n`;

    for (const p of pages) {
        md += `## [${p.version}]\n\n`;
        for (const item of p.items) {
            const tagLabel = item.tag !== 'OTHER' ? `**[${item.tag}]** ` : '';
            md += `- ${tagLabel}${item.text}\n`;
        }
        md += `\n`;
    }

    try {
        writeFileSync(destPath, md, 'utf-8');
        return true;
    } catch {
        return false;
    }
}

/**
 * Format tag with appropriate semantic terminal color
 */
function formatTagBadge(tag) {
    switch (tag) {
        case 'NEW':
            return `${c.bGreen}[NEW]    ${c.reset}`;
        case 'FIX':
            return `${c.bYellow}[FIX]    ${c.reset}`;
        case 'CHANGED':
            return `${c.bCyan}[CHANGED]${c.reset}`;
        case 'REMOVED':
            return `${c.bRed}[REMOVED]${c.reset}`;
        case 'IMPROVED':
            return `${c.bMagenta}[IMPROVE]${c.reset}`;
        default:
            return `${c.gray}[NOTE]   ${c.reset}`;
    }
}

/**
 * Interactive book-style changelog viewer
 */
export async function showInteractiveChangelog() {
    const pages = parseChangelogFile();
    if (pages.length === 0) {
        console.log(`\n${c.yellow}No changelog entries found in ${CHANGELOG_TXT_PATH}${c.reset}\n`);
        return;
    }

    // Auto-sync ~/.config/atc/CHANGELOG.md on viewing
    syncUserChangelog();

    let pageIdx = 0; // 0 = latest version
    let isSearchMode = false;
    let searchBuffer = '';
    let notice = '';

    // Isolated screen buffer
    process.stdout.write(c.enterAltScreen + c.disableWrap + c.hideCursor);

    function render() {
        const page = pages[pageIdx];
        const pageNum = pageIdx + 1;
        const totalPages = pages.length;

        let out = c.cursorHome + c.clearScreen;

        // Header Book Title
        const isLatest = pageIdx === 0 ? ` ${c.bGreen}(Latest)${c.reset}` : '';
        out += `${c.cyan}╭─────────────────────────────────────────────────────────────────╮${c.reset}\n`;
        out += `${c.cyan}│${c.reset}  📖 ${c.bold + c.bCyan}atc Changelog Book${c.reset} — ${c.bold}Page ${pageNum}/${totalPages}${c.reset}${isLatest.padEnd(20, ' ')} ${c.cyan}│${c.reset}\n`;
        out += `${c.cyan}╰─────────────────────────────────────────────────────────────────╯${c.reset}\n\n`;

        // Current Version Badge
        out += `  ${c.bold}Release:${c.reset} ${c.bYellow}[${page.version}]${c.reset}\n`;
        out += `  ${c.gray}${'─'.repeat(63)}${c.reset}\n\n`;

        // Render Version Entries
        if (page.items.length === 0) {
            out += `    ${c.gray}No detailed release notes for this version.${c.reset}\n`;
        } else {
            for (const it of page.items) {
                const badge = formatTagBadge(it.tag);
                // Wrap text if exceeding width
                const text = it.text;
                out += `  ${badge} ${c.white}•${c.reset} ${text}${c.clearToEndOfLine}\n`;
            }
        }

        out += `\n  ${c.gray}${'─'.repeat(63)}${c.reset}\n`;

        // Status / Search / Navigation footer
        if (isSearchMode) {
            out += `  ${c.bYellow}Search Version / Keyword:${c.reset} ${c.bold + c.white}${searchBuffer}_${c.reset}${c.clearToEndOfLine}\n`;
            out += `  ${c.gray}Press Enter to jump | ESC to cancel${c.reset}${c.clearToEndOfLine}`;
        } else if (notice) {
            out += `  ${c.bYellow}› ${notice}${c.reset}${c.clearToEndOfLine}\n`;
            out += `  ${c.gray}← Previous Page | → Next Page | S Search | ESC/Q Return${c.reset}${c.clearToEndOfLine}`;
        } else {
            out += `  ${c.bCyan}Navigation:${c.reset} ${c.gray}← Previous (${pageNum > 1 ? pages[pageIdx - 1].version : 'none'}) | → Next (${pageNum < totalPages ? pages[pageIdx + 1].version : 'none'})${c.reset}${c.clearToEndOfLine}\n`;
            out += `  ${c.gray}Hotkeys: [← / →] Flip Book | [S] Search Version | [ESC / Q] Exit${c.reset}${c.clearToEndOfLine}`;
        }

        process.stdout.write(out);
    }

    render();

    return new Promise((resolve) => {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();

        function cleanup() {
            process.stdin.removeListener('keypress', onKey);
            process.stdout.write(c.exitAltScreen + c.enableWrap + c.showCursor);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve();
        }

        function onKey(str, key) {
            if (!key) return;

            // Search Mode Key Handling
            if (isSearchMode) {
                if (key.name === 'escape') {
                    isSearchMode = false;
                    searchBuffer = '';
                    notice = '';
                    render();
                    return;
                }

                if (key.name === 'return' || key.name === 'enter') {
                    const q = searchBuffer.trim().toLowerCase();
                    isSearchMode = false;
                    searchBuffer = '';

                    if (!q) {
                        notice = '';
                        render();
                        return;
                    }

                    // Search by exact version, semver prefix, or text keyword
                    const foundIdx = pages.findIndex(p => {
                        const vClean = p.version.toLowerCase().replace(/^v/, '');
                        const qClean = q.replace(/^v/, '');
                        if (p.version.toLowerCase().includes(q) || vClean.startsWith(qClean)) return true;
                        return p.items.some(it => it.text.toLowerCase().includes(q));
                    });

                    if (foundIdx !== -1) {
                        pageIdx = foundIdx;
                        notice = `Jumped to version [${pages[pageIdx].version}]`;
                    } else {
                        notice = `No release found matching "${q}"`;
                    }
                    render();
                    return;
                }

                if (key.name === 'backspace') {
                    searchBuffer = searchBuffer.slice(0, -1);
                    render();
                    return;
                }

                if (str && str.length === 1 && !key.ctrl && !key.meta) {
                    if (searchBuffer.length < 32) {
                        searchBuffer += str;
                        render();
                    }
                    return;
                }
                return;
            }

            // Normal Book Navigation
            if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                cleanup();
                return;
            }

            // Next page (older versions): Right arrow, l, or n
            if (key.name === 'right' || key.name === 'l' || key.name === 'n') {
                notice = '';
                if (pageIdx < pages.length - 1) {
                    pageIdx++;
                    render();
                } else {
                    notice = 'Reached the beginning of changelog history.';
                    render();
                }
                return;
            }

            // Previous page (newer versions): Left arrow, h, or p
            if (key.name === 'left' || key.name === 'h' || key.name === 'p') {
                notice = '';
                if (pageIdx > 0) {
                    pageIdx--;
                    render();
                } else {
                    notice = 'Already viewing the latest release.';
                    render();
                }
                return;
            }

            // Enter Search Mode: S or s or /
            if (str === 's' || str === 'S' || str === '/') {
                isSearchMode = true;
                searchBuffer = '';
                notice = '';
                render();
                return;
            }
        }

        process.stdin.on('keypress', onKey);
    });
}

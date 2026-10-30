import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { renderRoundedBox } from '../utils/terminal-box.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CHANGELOG_TXT_PATH = join(__dirname, '..', 'changelogs.txt');
const CONFIG_DIR = dirname(ACCOUNT_CONFIG_PATH);
const USER_CHANGELOG_MD = join(CONFIG_DIR, 'CHANGELOG.md');

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

export function isValidVersionTag(tag) {
    if (!tag || typeof tag !== 'string') return false;
    return /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(tag);
}

/*
 * Chronological semver comparison (oldest -> newest) so the changelog book
 * always reads forward in time regardless of section order in changelogs.txt.
 */
export function compareSemverAsc(verA, verB) {
    const parse = (v) => {
        const clean = String(v || '').replace(/^v/i, '').split('+')[0];
        const [core, pre = ''] = clean.split('-');
        const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
        return { major: nums[0] || 0, minor: nums[1] || 0, patch: nums[2] || 0, pre };
    };
    const a = parse(verA);
    const b = parse(verB);
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    if (a.pre && !b.pre) return -1;
    if (!a.pre && b.pre) return 1;
    return a.pre.localeCompare(b.pre);
}

export function parseChangelogFile(filePath = CHANGELOG_TXT_PATH) {
    if (!existsSync(filePath)) return [];

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const pages = [];
    let current = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

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

        const itemMatch = line.match(/^\[([A-Z]+)\]\s*(.*)$/);
        if (itemMatch) {
            current.items.push({
                tag: itemMatch[1],
                text: itemMatch[2]
            });
        } else {
            current.items.push({
                tag: 'OTHER',
                text: line
            });
        }
    }

    if (current) pages.push(current);
    pages.sort((a, b) => compareSemverAsc(a.version, b.version));
    return pages;
}

export function syncUserChangelog(destPath = USER_CHANGELOG_MD) {
    const pages = parseChangelogFile();
    if (pages.length === 0) return false;

    let md = `# atc Changelog (Oldest to Latest)\n\n`;
    md += `All notable changes to the atc proxy and multi-account manager, ordered chronologically from oldest release to latest release.\n\n`;

    pages.forEach((p, idx) => {
        const suffix = idx === pages.length - 1 ? ' (Latest)' : '';
        md += `## [${p.version}]${suffix}\n\n`;
        for (const item of p.items) {
            const tagLabel = item.tag !== 'OTHER' ? `**[${item.tag}]** ` : '';
            md += `- ${tagLabel}${item.text}\n`;
        }
        md += `\n`;
    });

    try {
        writeFileSync(destPath, md, 'utf-8');
        return true;
    } catch {
        return false;
    }
}

/* Every tag badge occupies exactly 9 visible columns so wrapped lines align */
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
        case 'SECURITY':
            return `${c.bRed}[SECURE] ${c.reset}`;
        default:
            return `${c.gray}[NOTE]   ${c.reset}`;
    }
}

function wrapWords(text, maxWidth) {
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

export function renderChangelogPageFrame(pages, pageIdx, {
    scrollOffset = 0,
    maxVisibleLines = 15,
    innerWidth = 76,
    isSearchMode = false,
    searchBuffer = '',
    notice = ''
} = {}) {
    const page = pages[pageIdx];
    const pageNum = pageIdx + 1;
    const totalPages = pages.length;
    const isLatest = pageIdx === totalPages - 1;
    const isOldest = pageIdx === 0 && totalPages > 1;

    const statusBadge = isLatest
        ? ` ${c.bGreen}(Latest)${c.reset}`
        : (isOldest ? ` ${c.gray}(Oldest)${c.reset}` : '');

    let out = renderRoundedBox(
        `  ${c.bold + c.bCyan}atc Changelog Book${c.reset} — ${c.bold}Page ${pageNum}/${totalPages}${c.reset} · ${c.bYellow}[${page.version}]${c.reset}${statusBadge}`,
        {
            innerWidth,
            borderColor: c.cyan,
            reset: c.reset,
            lineClear: c.clearToEndOfLine
        }
    );

    const renderedBodyLines = [];
    const textWrapCols = Math.max(40, innerWidth - 14); // 2 indent + 9 badge + 3 " • "

    if (page.items.length === 0) {
        renderedBodyLines.push(`    ${c.gray}No detailed release notes recorded for this version.${c.reset}`);
    } else {
        for (const it of page.items) {
            const badge = formatTagBadge(it.tag);
            const wrapped = wrapWords(it.text, textWrapCols);
            wrapped.forEach((wl, idx) => {
                if (idx === 0) {
                    renderedBodyLines.push(`  ${badge} ${c.white}•${c.reset} ${wl}`);
                } else {
                    renderedBodyLines.push(`              ${wl}`);
                }
            });
        }
    }

    const clampedOffset = Math.max(
        0,
        Math.min(scrollOffset, Math.max(0, renderedBodyLines.length - maxVisibleLines))
    );
    const visibleSlice = renderedBodyLines.slice(clampedOffset, clampedOffset + maxVisibleLines);

    const timeline = pages
        .map((p, idx) => (idx === pageIdx ? `${c.bold + c.bGreen}[${p.version}]${c.reset}` : `${c.gray}${p.version}${c.reset}`))
        .join(` ${c.gray}->${c.reset} `);
    out += `  ${c.gray}Timeline:${c.reset} ${timeline}${c.clearToEndOfLine}\n`;
    out += `  ${c.gray}${'─'.repeat(innerWidth)}${c.reset}${c.clearToEndOfLine}\n`;

    for (const bl of visibleSlice) {
        out += `${bl}${c.clearToEndOfLine}\n`;
    }

    if (renderedBodyLines.length > maxVisibleLines) {
        out += `  ${c.gray}Lines ${clampedOffset + 1}–${Math.min(renderedBodyLines.length, clampedOffset + maxVisibleLines)} of ${renderedBodyLines.length} (use [↑/↓] to scroll release notes)${c.reset}${c.clearToEndOfLine}\n`;
    }

    out += `  ${c.gray}${'─'.repeat(innerWidth)}${c.reset}${c.clearToEndOfLine}\n`;

    const prevVer = pageIdx > 0 ? pages[pageIdx - 1].version : 'none';
    const nextVer = pageIdx < totalPages - 1 ? pages[pageIdx + 1].version : 'none';

    if (isSearchMode) {
        out += `  ${c.bYellow}Search Version / Keyword:${c.reset} ${c.bold + c.white}${searchBuffer}_${c.reset}${c.clearToEndOfLine}\n`;
        out += `  ${c.gray}[Enter] Jump to Match  ·  [ESC] Cancel Search${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
    } else if (notice) {
        out += `  ${c.bYellow}> ${notice}${c.reset}${c.clearToEndOfLine}\n`;
        out += `  ${c.gray}[←] Older (${prevVer})  ·  [→] Newer (${nextVer})  ·  [L] Latest  ·  [F] Oldest  ·  [S] Search  ·  [Q] Exit${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
    } else {
        out += `  ${c.bCyan}Order (Oldest -> Newest):${c.reset} ${c.gray}← Older (${prevVer})  |  Newer (${nextVer}) →${c.reset}${c.clearToEndOfLine}\n`;
        out += `  ${c.gray}[←/→] Flip Release  ·  [↑/↓] Scroll  ·  [L] Latest  ·  [F] Oldest  ·  [S] Search  ·  [ESC/Q] Exit${c.reset}${c.clearToEndOfLine}${c.clearToEndOfScreen}`;
    }

    return {
        frame: out,
        totalLines: renderedBodyLines.length,
        clampedOffset
    };
}

export async function showInteractiveChangelog() {
    const pages = parseChangelogFile();
    if (pages.length === 0) {
        console.log(`\n${c.yellow}No changelog entries found in ${CHANGELOG_TXT_PATH}${c.reset}\n`);
        return;
    }

    syncUserChangelog();

    /* Start at index 0 (oldest version) so browsing flows chronologically oldest -> newest */
    let pageIdx = 0;
    let scrollOffset = 0;
    let totalBodyLines = 0;
    let isSearchMode = false;
    let searchBuffer = '';
    let notice = '';

    process.stdout.write(c.enterAltScreen + c.disableWrap + c.hideCursor + c.clearScreen);

    function getViewportRows() {
        const rows = process.stdout.rows || 28;
        return Math.max(8, rows - 10);
    }

    function render() {
        const innerWidth = Math.max(66, Math.min((process.stdout.columns || 84) - 4, 84));
        const maxVisibleLines = getViewportRows();
        const res = renderChangelogPageFrame(pages, pageIdx, {
            scrollOffset,
            maxVisibleLines,
            innerWidth,
            isSearchMode,
            searchBuffer,
            notice
        });
        totalBodyLines = res.totalLines;
        scrollOffset = res.clampedOffset;
        process.stdout.write(c.cursorHome + res.frame);
    }

    const onResize = () => {
        process.stdout.write(c.clearScreen + c.cursorHome);
        render();
    };
    process.stdout.on('resize', onResize);

    render();

    return new Promise((resolve) => {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();

        function cleanup() {
            process.stdout.removeListener('resize', onResize);
            process.stdin.removeListener('keypress', onKey);
            process.stdout.write(c.exitAltScreen + c.enableWrap + c.showCursor);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve();
        }

        function onKey(str, key) {
            if (!key) return;

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

                    const foundIdx = pages.findIndex((p) => {
                        const vClean = p.version.toLowerCase().replace(/^v/, '');
                        const qClean = q.replace(/^v/, '');
                        if (p.version.toLowerCase().includes(q) || vClean.startsWith(qClean)) return true;
                        return p.items.some((it) => it.text.toLowerCase().includes(q));
                    });

                    if (foundIdx !== -1) {
                        pageIdx = foundIdx;
                        scrollOffset = 0;
                        notice = `Jumped to release [${pages[pageIdx].version}]`;
                    } else {
                        notice = `No release found matching "${q}"`;
                    }
                    process.stdout.write(c.clearScreen + c.cursorHome);
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
                }
                return;
            }

            if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                cleanup();
                return;
            }

            if (key.name === 'up' || key.name === 'k') {
                if (scrollOffset > 0) {
                    scrollOffset--;
                    render();
                }
                return;
            }

            if (key.name === 'down' || key.name === 'j') {
                const maxOff = Math.max(0, totalBodyLines - getViewportRows());
                if (scrollOffset < maxOff) {
                    scrollOffset++;
                    render();
                }
                return;
            }

            /* Right arrow / N: advance chronologically to newer version */
            if (key.name === 'right' || key.name === 'n') {
                notice = '';
                if (pageIdx < pages.length - 1) {
                    pageIdx++;
                    scrollOffset = 0;
                    process.stdout.write(c.clearScreen + c.cursorHome);
                    render();
                } else {
                    notice = `Already viewing the latest release [${pages[pageIdx].version}].`;
                    render();
                }
                return;
            }

            /* Left arrow / P: step back to older version */
            if (key.name === 'left' || key.name === 'p') {
                notice = '';
                if (pageIdx > 0) {
                    pageIdx--;
                    scrollOffset = 0;
                    process.stdout.write(c.clearScreen + c.cursorHome);
                    render();
                } else {
                    notice = `Already at the oldest release [${pages[pageIdx].version}].`;
                    render();
                }
                return;
            }

            if (!key.ctrl && !key.meta && (key.name === 'l' || key.name === 'end')) {
                pageIdx = pages.length - 1;
                scrollOffset = 0;
                notice = `Jumped to latest release [${pages[pageIdx].version}].`;
                process.stdout.write(c.clearScreen + c.cursorHome);
                render();
                return;
            }

            if (!key.ctrl && !key.meta && (key.name === 'f' || key.name === 'home')) {
                pageIdx = 0;
                scrollOffset = 0;
                notice = `Jumped to oldest release [${pages[pageIdx].version}].`;
                process.stdout.write(c.clearScreen + c.cursorHome);
                render();
                return;
            }

            if (str === 's' || str === 'S' || str === '/') {
                isSearchMode = true;
                searchBuffer = '';
                notice = '';
                render();
            }
        }

        process.stdin.on('keypress', onKey);
    });
}

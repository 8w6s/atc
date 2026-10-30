/*
 * Display-column measurement and box border rendering.
 *
 * String.prototype.padEnd counts UTF-16 code units including invisible ANSI
 * CSI sequences, shifting right-hand box borders inward whenever colors or
 * wide glyphs appear on a header line. Measuring visible terminal columns
 * after stripping escape sequences keeps top, middle, and bottom borders
 * locked to the exact same column on Windows Terminal, ConHost, and xterm.
 */

const ANSI_CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(str) {
    return String(str ?? '').replace(ANSI_CSI_RE, '');
}

export function isWideCodePoint(cp) {
    if (!cp) return false;
    return (
        (cp >= 0x1100 && cp <= 0x115F) ||
        cp === 0x2329 ||
        cp === 0x232A ||
        (cp >= 0x2E80 && cp <= 0x3247 && cp !== 0x303F) ||
        (cp >= 0x3250 && cp <= 0x4DBF) ||
        (cp >= 0x4E00 && cp <= 0xA4C6) ||
        (cp >= 0xA960 && cp <= 0xA97C) ||
        (cp >= 0xAC00 && cp <= 0xD7A3) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFE10 && cp <= 0xFE19) ||
        (cp >= 0xFE30 && cp <= 0xFE6B) ||
        (cp >= 0xFF01 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        (cp >= 0x1F300 && cp <= 0x1FAFF) ||
        (cp >= 0x20000 && cp <= 0x3FFFD)
    );
}

export function isZeroWidthCodePoint(cp) {
    if (!cp) return true;
    return (
        cp <= 0x1F ||
        (cp >= 0x7F && cp <= 0x9F) ||
        (cp >= 0x0300 && cp <= 0x036F) ||
        cp === 0x200B ||
        cp === 0x200C ||
        cp === 0x200D ||
        (cp >= 0xFE00 && cp <= 0xFE0F) ||
        (cp >= 0xE0100 && cp <= 0xE01EF)
    );
}

export function getDisplayWidth(str) {
    const plain = stripAnsi(str);
    let cols = 0;
    for (const ch of plain) {
        const cp = ch.codePointAt(0);
        if (isZeroWidthCodePoint(cp)) continue;
        cols += isWideCodePoint(cp) ? 2 : 1;
    }
    return cols;
}

export function truncateVisible(str, maxCols) {
    const raw = String(str ?? '');
    if (getDisplayWidth(raw) <= maxCols) return raw;

    /* Walk plain/ANSI tokens so escape codes stay intact when clipping */
    const tokenRe = /(\x1b\[[0-9;?]*[A-Za-z])|([\s\S])/g;
    let out = '';
    let cols = 0;
    let sawAnsi = false;
    let match;
    const budget = Math.max(0, maxCols - 1);

    while ((match = tokenRe.exec(raw)) !== null) {
        if (match[1]) {
            out += match[1];
            sawAnsi = true;
            continue;
        }
        const ch = match[2];
        const cp = ch.codePointAt(0);
        const w = isZeroWidthCodePoint(cp) ? 0 : (isWideCodePoint(cp) ? 2 : 1);
        if (cols + w > budget) {
            out += '…';
            break;
        }
        out += ch;
        cols += w;
    }

    return sawAnsi ? `${out}\x1b[0m` : out;
}

export function padEndVisible(str, targetCols) {
    const raw = String(str ?? '');
    const clipped = getDisplayWidth(raw) > targetCols ? truncateVisible(raw, targetCols) : raw;
    const pad = Math.max(0, targetCols - getDisplayWidth(clipped));
    return clipped + ' '.repeat(pad);
}

export function renderRoundedBox(lines, {
    innerWidth = 76,
    borderColor = '\x1b[38;5;48m',
    reset = '\x1b[0m',
    lineClear = ''
} = {}) {
    const rowList = Array.isArray(lines) ? lines : [lines];
    const bar = '─'.repeat(innerWidth);
    let out = `${borderColor}╭${bar}╮${reset}${lineClear}\n`;
    for (const rawLine of rowList) {
        const fitted = padEndVisible(rawLine, innerWidth);
        out += `${borderColor}│${reset}${fitted}${borderColor}│${reset}${lineClear}\n`;
    }
    out += `${borderColor}╰${bar}╯${reset}${lineClear}\n`;
    return out;
}

export function renderDoubleBox(sections, innerWidth = 66) {
    const bar = '═'.repeat(innerWidth);
    const out = [`╔${bar}╗`];
    sections.forEach((sec, idx) => {
        if (idx > 0) out.push(`╠${bar}╣`);
        for (const rawLine of sec) {
            if (rawLine && rawLine.center === true) {
                const text = String(rawLine.text ?? '');
                const clipped = getDisplayWidth(text) > innerWidth ? truncateVisible(text, innerWidth) : text;
                const rem = Math.max(0, innerWidth - getDisplayWidth(clipped));
                const left = Math.floor(rem / 2);
                const right = rem - left;
                out.push(`║${' '.repeat(left)}${clipped}${' '.repeat(right)}║`);
            } else {
                out.push(`║${padEndVisible(String(rawLine ?? ''), innerWidth)}║`);
            }
        }
    });
    out.push(`╚${bar}╝`);
    return out.join('\n');
}

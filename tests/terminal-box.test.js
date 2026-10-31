import test from 'node:test';
import assert from 'node:assert/strict';
import {
    stripAnsi,
    getDisplayWidth,
    padEndVisible,
    truncateVisible,
    renderRoundedBox
} from '../src/utils/terminal-box.js';

test('terminal-box - stripAnsi removes color sequences', () => {
    const raw = '\x1b[1;32mHello \x1b[36mWorld\x1b[0m';
    assert.equal(stripAnsi(raw), 'Hello World');
});

test('terminal-box - getDisplayWidth accounts for ANSI & wide chars', () => {
    const colored = '\x1b[31mStatus\x1b[0m';
    assert.equal(getDisplayWidth(colored), 6);

    const withEmoji = '🚀 Launch';
    // '🚀' (wide = 2) + ' ' (1) + 'Launch' (6) = 9
    assert.equal(getDisplayWidth(withEmoji), 9);
});

test('terminal-box - padEndVisible maintains target column width', () => {
    const colored = '\x1b[32mActive\x1b[0m';
    const padded = padEndVisible(colored, 15);
    assert.equal(getDisplayWidth(padded), 15);
});

test('terminal-box - truncateVisible clips within bounds', () => {
    const text = 'This is a very long string that should be truncated';
    const clipped = truncateVisible(text, 15);
    assert.ok(getDisplayWidth(clipped) <= 15);
    assert.ok(clipped.endsWith('…') || clipped.endsWith('…\x1b[0m'));
});

test('terminal-box - renderRoundedBox builds box with matching widths', () => {
    const box = renderRoundedBox(['Line 1', '\x1b[1;36mLine 2 Colored\x1b[0m'], { innerWidth: 40 });
    const lines = box.trim().split('\n');
    assert.equal(lines.length, 4); // top, line 1, line 2, bottom

    // First line begins with ╭ and ends with ╮
    assert.ok(lines[0].includes('╭') && lines[0].includes('╮'));
    // Bottom line begins with ╰ and ends with ╯
    assert.ok(lines[3].includes('╰') && lines[3].includes('╯'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getClaudeDesktopConfigPath,
    getClaudeDesktopLauncherPath
} from '../src/utils/claude-config.js';

test('claude-config - getClaudeDesktopConfigPath resolves correctly', () => {
    const p = getClaudeDesktopConfigPath();
    assert.ok(typeof p === 'string' && p.length > 0);
    assert.ok(p.includes('Claude') || p.includes('claude'));
    assert.ok(p.endsWith('claude_desktop_config.json'));
});

test('claude-config - getClaudeDesktopLauncherPath resolves launcher extension', () => {
    const launcher = getClaudeDesktopLauncherPath();
    assert.ok(typeof launcher === 'string' && launcher.length > 0);
    if (process.platform === 'win32') {
        assert.ok(launcher.endsWith('.cmd'));
    } else {
        assert.ok(launcher.endsWith('.sh'));
    }
});

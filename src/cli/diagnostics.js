import fs from 'fs';
import os from 'os';
import path from 'path';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { config, reloadConfig, saveConfig } from '../config.js';
import { loadAccounts } from '../account-manager/storage.js';
import { getClientVersion, generateSmartUserAgent } from '../utils/version-detector.js';
import { getProxyPort, getServicePid } from './terminal-manager.js';

const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
    bGreen: '\x1b[92m',
    bYellow: '\x1b[93m',
    bCyan: '\x1b[96m',
    bRed: '\x1b[91m'
};

function maskEmail(email) {
    if (!email || typeof email !== 'string') return 'n/a';
    const [local, domain] = email.split('@');
    if (!domain) return email;
    if (local.length <= 4) return `${local[0] || '*'}***@${domain}`;
    return `${local.slice(0, 3)}..${local.slice(-2)}@${domain}`;
}

function fmtTokens(n) {
    const val = Number(n) || 0;
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
    if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
    return String(val);
}

export async function runDoctor({ fix = false, restartDaemon = null } = {}) {
    reloadConfig();
    let port = getProxyPort();
    const home = os.homedir();
    const claudeSettingsPath = path.join(home, '.claude', 'settings.json');
    const checks = [];
    let needsDaemonRestart = false;

    console.log(`\n${c.bold + c.bCyan}🩺 atc System & Anti-Ban Hygiene Doctor${c.reset}\n`);

    // 1. Antigravity installation & UA tuple check
    const clientVer = getClientVersion();
    const ua = generateSmartUserAgent();
    const hasCl = ua.includes('cl=');
    checks.push({
        ok: Boolean(clientVer),
        label: 'Antigravity Binary Fingerprint',
        detail: `${clientVer} (${hasCl ? 'matched changelist tuple' : 'fallback UA'})`
    });

    // 2. Config safety guards check
    const unsafeRetries = (config.maxRetries ?? 2) > 3;
    const noFloor = (config.globalQuotaThreshold ?? 0) <= 0 && !config.singleAccountLock;
    if (fix && (unsafeRetries || noFloor || !config.bindHost || config.bindHost === '0.0.0.0')) {
        const patch = {};
        if (unsafeRetries) patch.maxRetries = 2;
        if (noFloor) patch.globalQuotaThreshold = 0.10;
        if (!config.bindHost || config.bindHost === '0.0.0.0') patch.bindHost = '127.0.0.1';
        if (config.pacerDelayMs === undefined) patch.pacerDelayMs = 250;
        if (config.hourlyAccountCap === undefined) patch.hourlyAccountCap = 120;
        saveConfig(patch);
        reloadConfig();
        needsDaemonRestart = true;
    }

    checks.push({
        ok: (config.maxRetries ?? 2) <= 3 && ((config.globalQuotaThreshold ?? 0) > 0 || !!config.singleAccountLock),
        label: 'Anti-Burst & Quota Floor Guards',
        detail: `floor=${Math.round((config.globalQuotaThreshold ?? 0) * 100)}%, pacer=${config.pacerDelayMs ?? 250}ms, stay=${config.accountSelection?.minStaySec ?? 180}s, retries=${config.maxRetries ?? 2}, cap=${config.hourlyAccountCap ?? 120}/h, lock=${config.singleAccountLock ? 'ON' : 'OFF'}`
    });

    // 3. Live daemon health & engine generation check
    let health = null;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
        if (res.ok) health = await res.json();
    } catch {}

    const pidOnDisk = getServicePid();
    const hasModernCaps = Array.isArray(health?.capabilities) && health.capabilities.includes('isolated-tls');

    if ((!health || !hasModernCaps) && fix && typeof restartDaemon === 'function') {
        const restartRes = await restartDaemon();
        port = getProxyPort();
        needsDaemonRestart = false;
        if (restartRes?.port) port = restartRes.port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
            if (res.ok) health = await res.json();
        } catch {}
    } else if (needsDaemonRestart && health && hasModernCaps) {
        try {
            await fetch(`http://127.0.0.1:${port}/reload`, { method: 'POST', signal: AbortSignal.timeout(1500) });
        } catch {}
    }

    const modernNow = Array.isArray(health?.capabilities) && health.capabilities.includes('isolated-tls');
    checks.push({
        ok: Boolean(health && modernNow),
        label: 'Proxy Daemon & Isolated TLS Engine',
        detail: health
            ? (modernNow
                ? `online on 127.0.0.1:${port} (PID ${health.pid || pidOnDisk || 'active'}, ${health.latencyMs}ms cached /health)`
                : `legacy daemon on port ${port} missing isolated-tls capabilities (run "atc doctor --fix" or "atc restart")`)
            : `offline on port ${port} (run "atc start")`
    });

    // 4. Token counter endpoint check
    let countTokensOk = false;
    if (health) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (config.apiKey) headers['x-api-key'] = config.apiKey;
            const ctRes = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'ping' }] }),
                signal: AbortSignal.timeout(2000)
            });
            if (ctRes.ok) {
                const ctJson = await ctRes.json();
                countTokensOk = typeof ctJson.input_tokens === 'number' && ctJson.input_tokens > 0;
            }
        } catch {}
    }
    checks.push({
        ok: countTokensOk,
        label: 'Local Token Counter (/v1/messages/count_tokens)',
        detail: countTokensOk ? '200 OK (offline estimation, 0 upstream calls)' : 'unavailable (daemon offline or outdated)'
    });

    // 5. Claude Code settings alignment
    let claudeAligned = false;
    let claudeDetail = '~/.claude/settings.json missing';
    const expectedUrl = `http://localhost:${port}`;
    const expectedKey = config.apiKey || 'atc-local-key';

    if (fs.existsSync(claudeSettingsPath)) {
        try {
            const cs = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
            const curUrl = cs?.env?.ANTHROPIC_BASE_URL || '';
            const curKey = cs?.env?.ANTHROPIC_API_KEY || '';
            claudeAligned = (curUrl === expectedUrl || curUrl === `http://127.0.0.1:${port}`) && curKey === expectedKey;
            if (!claudeAligned && fix) {
                cs.env = cs.env || {};
                cs.env.ANTHROPIC_BASE_URL = expectedUrl;
                cs.env.ANTHROPIC_API_KEY = expectedKey;
                fs.writeFileSync(claudeSettingsPath, JSON.stringify(cs, null, 2), 'utf8');
                claudeAligned = true;
                claudeDetail = `auto-repaired -> ${expectedUrl}`;
            } else {
                claudeDetail = claudeAligned ? `synced (${curUrl})` : `mismatch (found ${curUrl || 'unset'}, expected ${expectedUrl})`;
            }
        } catch (err) {
            claudeDetail = `invalid JSON: ${err.message}`;
        }
    } else if (fix) {
        const dir = path.dirname(claudeSettingsPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: expectedUrl, ANTHROPIC_API_KEY: expectedKey } }, null, 2), 'utf8');
        claudeAligned = true;
        claudeDetail = `created -> ${expectedUrl}`;
    }

    checks.push({
        ok: claudeAligned,
        label: 'Claude Code CLI Endpoint Sync',
        detail: claudeDetail
    });

    // 6. Account pool health check
    const { accounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const enabledAccs = accounts.filter((a) => a.enabled !== false);
    const invalidAccs = enabledAccs.filter((a) => a.isInvalid);
    const verifyAccs = invalidAccs.filter((a) => a.verifyUrl);
    checks.push({
        ok: enabledAccs.length > 0 && invalidAccs.length === 0,
        warn: enabledAccs.length > 0 && invalidAccs.length > 0 && invalidAccs.length < enabledAccs.length,
        label: 'Saved Google Account Pool',
        detail: `${enabledAccs.length} enabled, ${enabledAccs.length - invalidAccs.length} healthy, ${invalidAccs.length} flagged${verifyAccs.length > 0 ? ` (${verifyAccs.length} need browser verify)` : ''}`
    });

    for (const item of checks) {
        const icon = item.ok ? `${c.bGreen}✓${c.reset}` : (item.warn ? `${c.bYellow}▲${c.reset}` : `${c.bRed}✗${c.reset}`);
        console.log(`  ${icon} ${c.bold}${item.label}:${c.reset} ${item.detail}`);
    }

    const failed = checks.filter((x) => !x.ok && !x.warn);
    console.log('');
    if (failed.length === 0) {
        console.log(`  ${c.bGreen}All core checks healthy.${c.reset}\n`);
    } else if (!fix) {
        console.log(`  ${c.bYellow}${failed.length} issue(s) detected.${c.reset} Run ${c.bCyan}atc doctor --fix${c.reset} to repair automatically.\n`);
    } else {
        console.log(`  ${c.bYellow}${failed.length} issue(s) still require attention.${c.reset}\n`);
    }

    return { ok: failed.length === 0, checks, port };
}

export async function showTelemetryStats() {
    const port = getProxyPort();
    let snap = null;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/telemetry?limit=20`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) snap = await res.json();
    } catch {}

    console.log(`\n${c.bold + c.bCyan}📊 atc Proxy Telemetry & Token Usage${c.reset}\n`);

    if (!snap) {
        console.log(`  ${c.yellow}▲ Telemetry unavailable on port ${port}.${c.reset} Ensure modern daemon is running (${c.cyan}atc doctor --fix${c.reset}).\n`);
        return;
    }

    const w24 = snap.window24h || {};
    const w7 = snap.window7d || {};
    const err24 = (w24.errors?.['429'] || 0) + (w24.errors?.['403'] || 0) + (w24.errors?.['5xx'] || 0) + (w24.errors?.other || 0);

    console.log(`  ${c.bold}LAST 24 HOURS${c.reset}`);
    console.log(`  ${c.cyan}├─${c.reset} Requests:      ${c.bGreen}${w24.totalRequests || 0}${c.reset}  ${c.gray}(7d: ${w7.totalRequests || 0})${c.reset}`);
    console.log(`  ${c.cyan}├─${c.reset} Input Tokens:  ${c.bCyan}${fmtTokens(w24.inputTokens)}${c.reset}  ${c.gray}(7d: ${fmtTokens(w7.inputTokens)})${c.reset}`);
    console.log(`  ${c.cyan}├─${c.reset} Output Tokens: ${c.magenta}${fmtTokens(w24.outputTokens)}${c.reset}  ${c.gray}(7d: ${fmtTokens(w7.outputTokens)})${c.reset}`);
    console.log(`  ${c.cyan}└─${c.reset} Upstream Errs: ${err24 > 0 ? c.bYellow : c.green}${err24}${c.reset} ${c.gray}(429: ${w24.errors?.['429'] || 0}, 403: ${w24.errors?.['403'] || 0}, 5xx: ${w24.errors?.['5xx'] || 0})${c.reset}\n`);

    const modelEntries = Object.entries(w24.byModel || {}).sort((a, b) => b[1] - a[1]);
    if (modelEntries.length > 0) {
        console.log(`  ${c.bold}BY TARGET MODEL (24H)${c.reset}`);
        for (const [m, count] of modelEntries) {
            console.log(`  • ${c.cyan}${m.padEnd(28)}${c.reset} ${c.bold}${count}${c.reset} reqs`);
        }
        console.log('');
    }

    const accEntries = Object.entries(w24.byAccount || {}).sort((a, b) => b[1].requests - a[1].requests);
    if (accEntries.length > 0) {
        console.log(`  ${c.bold}BY ACCOUNT (24H)${c.reset}`);
        for (const [email, st] of accEntries) {
            console.log(
                `  • ${c.bCyan}${maskEmail(email).padEnd(22)}${c.reset} ` +
                `${String(st.requests).padStart(4)} reqs | in:${fmtTokens(st.inputTokens).padStart(6)} | out:${fmtTokens(st.outputTokens).padStart(6)} | errs:${st.errors}`
            );
        }
        console.log('');
    }
}

function formatLogLine(ev) {
    const time = (ev.ts || '').slice(11, 19) || '--:--:--';
    const statusColor = ev.status >= 500 ? c.bRed : (ev.status >= 400 ? c.bYellow : c.bGreen);
    const route = ev.reqModel && ev.reqModel !== ev.targetModel
        ? `${ev.reqModel} -> ${ev.targetModel}`
        : (ev.targetModel || ev.reqModel || 'unknown');
    const acc = maskEmail(ev.account);
    const ttft = ev.ttftMs !== null && ev.ttftMs !== undefined ? `TTFT ${ev.ttftMs}ms` : '';
    const dur = `${ev.durationMs || 0}ms`;
    const timing = ttft ? `${ttft} / ${dur}` : dur;
    return `  ${c.gray}${time}${c.reset}  ${statusColor}${String(ev.status).padEnd(3)}${c.reset}  ${c.cyan}${route.padEnd(38)}${c.reset}  ${acc.padEnd(20)}  ${timing.padEnd(18)}  ${c.dim}in:${fmtTokens(ev.inputTokens)} out:${fmtTokens(ev.outputTokens)}${c.reset}`;
}

export async function showLiveLogs({ limit = 30, follow = false } = {}) {
    const port = getProxyPort();
    let lastSeq = 0;

    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/telemetry?limit=${limit}`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const snap = await res.json();
        const events = snap.recentRequests || [];
        lastSeq = snap.latestSeq || 0;

        console.log(`\n${c.bold + c.bCyan}📡 atc Recent Request Stream${c.reset} ${c.gray}(127.0.0.1:${port})${c.reset}\n`);
        if (events.length === 0) {
            console.log(`  ${c.gray}(No requests recorded in this daemon session yet)${c.reset}`);
        } else {
            for (const ev of events) {
                console.log(formatLogLine(ev));
            }
        }
    } catch (err) {
        console.log(`\n  ${c.red}✗ Unable to read live telemetry on port ${port}:${c.reset} ${err.message}\n`);
        return;
    }

    if (!follow) {
        console.log('');
        return;
    }

    console.log(`\n  ${c.gray}Following live requests (Ctrl+C to stop)...${c.reset}`);
    await new Promise((resolve) => {
        const timer = setInterval(async () => {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/api/telemetry?since=${lastSeq}`, { signal: AbortSignal.timeout(2000) });
                if (!res.ok) return;
                const snap = await res.json();
                for (const ev of snap.recentRequests || []) {
                    console.log(formatLogLine(ev));
                    if (ev.seq > lastSeq) lastSeq = ev.seq;
                }
            } catch {}
        }, 1200);

        process.once('SIGINT', () => {
            clearInterval(timer);
            console.log('');
            resolve();
        });
    });
}

export async function toggleSingleAccountLock(modeArg) {
    reloadConfig();
    const arg = (modeArg || '').toLowerCase();
    let nextVal = !!config.singleAccountLock;
    if (arg === 'on' || arg === 'true' || arg === '1' || arg === 'enable') nextVal = true;
    else if (arg === 'off' || arg === 'false' || arg === '0' || arg === 'disable') nextVal = false;
    else if (!arg) nextVal = !nextVal;
    else if (arg === 'status') {
        console.log(`\n  Single-Account Lock is currently: ${nextVal ? c.bYellow + 'ON (Locked)' : c.bGreen + 'OFF (Pool active)'}${c.reset}\n`);
        return;
    }

    saveConfig({ singleAccountLock: nextVal });
    const port = getProxyPort();
    try {
        await fetch(`http://127.0.0.1:${port}/reload`, { method: 'POST', signal: AbortSignal.timeout(1500) });
    } catch {}

    console.log(
        `\n  ${c.bGreen}✓${c.reset} Single-Account Lock: ${nextVal ? c.bYellow + 'ON (traffic pinned to active account; auto-rotation disabled)' : c.bGreen + 'OFF (pipelined rotation active)'}${c.reset}\n`
    );
}

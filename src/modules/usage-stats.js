import fs from 'fs';
import path from 'path';

import { USAGE_HISTORY_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

const HISTORY_FILE = USAGE_HISTORY_PATH;
const DATA_DIR = path.dirname(HISTORY_FILE);
const OLD_DATA_DIR = path.join(process.cwd(), 'data');
const OLD_HISTORY_FILE = path.join(OLD_DATA_DIR, 'usage-history.json');
const MAX_RECENT_EVENTS = 150;

let history = {};
let isDirty = false;
let seqCounter = 0;
const recentEvents = [];

function getFamily(modelId) {
    const lower = (modelId || '').toLowerCase();
    if (lower.includes('claude')) return 'claude';
    if (lower.includes('gemini')) return 'gemini';
    return 'other';
}

function getShortName(modelId, family) {
    if (family === 'other') return modelId;
    return modelId.replace(new RegExp(`^${family}-`, 'i'), '');
}

function load() {
    try {
        if (fs.existsSync(OLD_HISTORY_FILE) && !fs.existsSync(HISTORY_FILE)) {
            logger.info('[UsageStats] Migrating legacy usage data...');
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.copyFileSync(OLD_HISTORY_FILE, HISTORY_FILE);
            logger.info(`[UsageStats] Migration complete: ${OLD_HISTORY_FILE} -> ${HISTORY_FILE}`);
        }

        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            history = JSON.parse(data);
        }
    } catch (err) {
        logger.error('[UsageStats] Failed to load history:', err);
        history = {};
    }
}

function save() {
    if (!isDirty) return;
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
        isDirty = false;
    } catch (err) {
        logger.error('[UsageStats] Failed to save history:', err);
    }
}

function prune() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    let pruned = false;
    Object.keys(history).forEach((key) => {
        if (new Date(key) < cutoff) {
            delete history[key];
            pruned = true;
        }
    });

    if (pruned) isDirty = true;
}

function getHourBucket(date = new Date()) {
    const d = new Date(date.getTime());
    d.setMinutes(0, 0, 0);
    const key = d.toISOString();
    if (!history[key]) {
        history[key] = { _total: 0 };
    }
    return history[key];
}

function track(modelId) {
    if (!modelId) return;
    const hourData = getHourBucket();
    const family = getFamily(modelId);
    const shortName = getShortName(modelId, family);

    if (!hourData[family]) {
        hourData[family] = { _subtotal: 0 };
    }

    hourData[family][shortName] = (hourData[family][shortName] || 0) + 1;
    hourData[family]._subtotal = (hourData[family]._subtotal || 0) + 1;
    hourData._total = (hourData._total || 0) + 1;
    isDirty = true;
}

function recordTelemetry(entry = {}) {
    const {
        reqModel = 'unknown',
        targetModel = reqModel,
        account = null,
        status = 200,
        durationMs = 0,
        ttftMs = null,
        inputTokens = 0,
        outputTokens = 0,
        errorType = null
    } = entry;

    const inTok = Math.max(0, Number(inputTokens) || 0);
    const outTok = Math.max(0, Number(outputTokens) || 0);

    track(targetModel);

    const hourData = getHourBucket();
    hourData._tokens = hourData._tokens || { input: 0, output: 0 };
    hourData._tokens.input += inTok;
    hourData._tokens.output += outTok;

    if (status >= 400) {
        hourData._errors = hourData._errors || { '429': 0, '403': 0, '5xx': 0, other: 0 };
        if (status === 429) hourData._errors['429']++;
        else if (status === 403) hourData._errors['403']++;
        else if (status >= 500) hourData._errors['5xx']++;
        else hourData._errors.other++;
    }

    if (account) {
        hourData._accounts = hourData._accounts || {};
        const accStats = hourData._accounts[account] || { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 };
        accStats.requests++;
        accStats.inputTokens += inTok;
        accStats.outputTokens += outTok;
        if (status >= 400) accStats.errors++;
        hourData._accounts[account] = accStats;
    }

    isDirty = true;

    seqCounter++;
    recentEvents.push({
        seq: seqCounter,
        ts: new Date().toISOString(),
        reqModel,
        targetModel,
        account,
        status,
        durationMs: Math.round(durationMs),
        ttftMs: ttftMs !== null ? Math.round(ttftMs) : null,
        inputTokens: inTok,
        outputTokens: outTok,
        errorType
    });
    if (recentEvents.length > MAX_RECENT_EVENTS) {
        recentEvents.shift();
    }
}

function summarizeWindow(hoursBack) {
    const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
    let totalRequests = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const errors = { '429': 0, '403': 0, '5xx': 0, other: 0 };
    const byModel = {};
    const byAccount = {};

    for (const [key, bucket] of Object.entries(history)) {
        const ts = Date.parse(key);
        if (Number.isNaN(ts) || ts < cutoff || !bucket) continue;

        totalRequests += bucket._total || 0;
        inputTokens += bucket._tokens?.input || 0;
        outputTokens += bucket._tokens?.output || 0;

        if (bucket._errors) {
            errors['429'] += bucket._errors['429'] || 0;
            errors['403'] += bucket._errors['403'] || 0;
            errors['5xx'] += bucket._errors['5xx'] || 0;
            errors.other += bucket._errors.other || 0;
        }

        if (bucket._accounts) {
            for (const [email, a] of Object.entries(bucket._accounts)) {
                const cur = byAccount[email] || { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 };
                cur.requests += a.requests || 0;
                cur.inputTokens += a.inputTokens || 0;
                cur.outputTokens += a.outputTokens || 0;
                cur.errors += a.errors || 0;
                byAccount[email] = cur;
            }
        }

        for (const [family, famObj] of Object.entries(bucket)) {
            if (family.startsWith('_') || !famObj || typeof famObj !== 'object') continue;
            for (const [shortName, cnt] of Object.entries(famObj)) {
                if (shortName.startsWith('_') || typeof cnt !== 'number') continue;
                const fullModel = family === 'other' ? shortName : `${family}-${shortName}`;
                byModel[fullModel] = (byModel[fullModel] || 0) + cnt;
            }
        }
    }

    return { totalRequests, inputTokens, outputTokens, errors, byModel, byAccount };
}

function getTelemetrySnapshot(limit = 50, sinceSeq = 0) {
    const filteredEvents = sinceSeq > 0
        ? recentEvents.filter((e) => e.seq > sinceSeq)
        : recentEvents.slice(-Math.max(1, Math.min(MAX_RECENT_EVENTS, limit)));

    return {
        window24h: summarizeWindow(24),
        window7d: summarizeWindow(24 * 7),
        latestSeq: seqCounter,
        recentRequests: filteredEvents
    };
}

function setupMiddleware(_app) {
    load();

    /*
     * Unref periodic persistence timer and flush via 'exit' rather than hijacking
     * SIGINT/SIGTERM from index.js's graceful socket drain handler.
     */
    setInterval(() => {
        save();
        prune();
    }, 60 * 1000).unref();

    process.on('exit', () => {
        save();
    });
}

function setupRoutes(app) {
    app.get('/api/stats/history', (req, res) => {
        res.json(getHistory());
    });

    app.get('/api/telemetry', (req, res) => {
        const limit = parseInt(req.query.limit, 10) || 50;
        const sinceSeq = parseInt(req.query.since, 10) || 0;
        res.json(getTelemetrySnapshot(limit, sinceSeq));
    });
}

function getHistory() {
    const sortedKeys = Object.keys(history).sort();
    const sortedData = {};
    sortedKeys.forEach((key) => {
        sortedData[key] = history[key];
    });
    return sortedData;
}

export default {
    setupMiddleware,
    setupRoutes,
    track,
    recordTelemetry,
    getTelemetrySnapshot,
    getFamily,
    getShortName,
    getHistory
};

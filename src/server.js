/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendMessage, sendMessageStream, listModels, getModelQuotas, getSubscriptionTier, isValidModel } from './cloudcode/index.js';
import { config, reloadConfig } from './config.js';
import { getPackageVersion, formatDuration, sleep } from './utils/helpers.js';
import { resetVersionCache } from './utils/version-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { forceRefresh } from './auth/token-extractor.js';
import { REQUEST_BODY_LIMIT } from './constants.js';
import { AccountManager } from './account-manager/index.js';
import { clearThinkingSignatureCache } from './format/signature-cache.js';
import { logger } from './utils/logger.js';
import usageStats from './modules/usage-stats.js';

// Parse fallback flag directly from command line args to avoid circular dependency
const args = process.argv.slice(2);
const FALLBACK_ENABLED = args.includes('--fallback') || process.env.FALLBACK === 'true';

// Parse --strategy flag (format: --strategy=sticky or --strategy sticky)
let STRATEGY_OVERRIDE = null;
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--strategy=')) {
        STRATEGY_OVERRIDE = args[i].split('=')[1];
    } else if (args[i] === '--strategy' && args[i + 1]) {
        STRATEGY_OVERRIDE = args[i + 1];
    }
}

const app = express();

// Disable x-powered-by header for security
app.disable('x-powered-by');

// Initialize account manager (will be fully initialized on first request or startup)
export const accountManager = new AccountManager();

// Track initialization status
let isInitialized = false;
let initError = null;
let initPromise = null;

/**
 * Ensure account manager is initialized (with race condition protection)
 */
async function ensureInitialized() {
    if (isInitialized) return;

    // If initialization is already in progress, wait for it
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            await accountManager.initialize(STRATEGY_OVERRIDE);
            isInitialized = true;
            const status = accountManager.getStatus();
            logger.success(`[Server] Account pool initialized: ${status.summary}`);
        } catch (error) {
            initError = error;
            initPromise = null; // Allow retry on failure
            logger.error('[Server] Failed to initialize account manager:', error.message);
            throw error;
        }
    })();

    return initPromise;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

// API Key authentication middleware for /v1/* endpoints
app.use('/v1', (req, res, next) => {
    // Skip validation if apiKey is not configured
    if (!config.apiKey) {
        return next();
    }

    const authHeader = req.headers['authorization'];
    const xApiKey = req.headers['x-api-key'];

    let providedKey = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
        providedKey = authHeader.substring(7);
    } else if (xApiKey) {
        providedKey = xApiKey;
    }

    if (!providedKey || providedKey !== config.apiKey) {
        logger.warn(`[API] Unauthorized request from ${req.ip}, invalid API key`);
        return res.status(401).json({
            type: 'error',
            error: {
                type: 'authentication_error',
                message: 'Invalid or missing API key'
            }
        });
    }

    next();
});

// Setup usage statistics middleware
usageStats.setupMiddleware(app);

/**
 * Silent handler for Claude Code CLI root POST requests
 * Claude Code sends heartbeat/event requests to POST / which we don't need
 * Using app.use instead of app.post for earlier middleware interception
 */
app.use((req, res, next) => {
    // Handle Claude Code event logging requests silently
    if (req.method === 'POST' && req.path === '/api/event_logging/batch') {
        return res.status(200).json({ status: 'ok' });
    }
    // Handle Claude Code root POST requests silently
    if (req.method === 'POST' && req.path === '/') {
        return res.status(200).json({ status: 'ok' });
    }
    next();
});

// Minimal JSON root status endpoint (Terminal TUI is the primary interface)
app.get('/', (req, res) => {
    res.json({
        service: 'atc (Antigravity to Claude)',
        version: getPackageVersion(),
        status: 'active',
        interface: 'Terminal TUI dashboard (run "atc" or "atc dash")',
        endpoints: {
            messages: '/v1/messages',
            models: '/v1/models',
            health: '/health',
            accountLimits: '/account-limits'
        }
    });
});

/**
 * Parse error message to extract error type, status code, and user-friendly message
 */
function parseError(error) {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message;

    if (error.message.includes('401') || error.message.includes('UNAUTHENTICATED')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage = 'Authentication failed. Make sure Antigravity is running with a valid token.';
    } else if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('QUOTA_EXHAUSTED') || error.message.includes('RATE_LIMITED')) {
        errorType = 'rate_limit_error';  // Standard Anthropic rate_limit_error allows Claude Code & subagents to auto-retry gracefully
        statusCode = 429;  // Standard 429 prevents premature subagent termination

        // Try to extract the quota reset time from the error
        const resetMatch = error.message.match(/quota will reset after ([\dh\dm\ds]+)/i);
        // Try to extract model from our error format "Rate limited on <model>" or JSON format
        const modelMatch = error.message.match(/Rate limited on ([^.]+)\./) || error.message.match(/"model":\s*"([^"]+)"/) || error.message.match(/on ([a-zA-Z0-9._-]+)\./);
        const model = modelMatch ? modelMatch[1] : 'the model';

        if (resetMatch) {
            errorMessage = `RESOURCE_EXHAUSTED: You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
        } else {
            errorMessage = `RESOURCE_EXHAUSTED: You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
        }
    } else if (error.message.includes('invalid_request_error') || error.message.includes('INVALID_ARGUMENT')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = error.message.match(/"message":"([^"]+)"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (error.message.includes('All endpoints failed')) {
        errorType = 'api_error';
        statusCode = 503;
        errorMessage = 'Unable to connect to Claude API. Check that Antigravity is running.';
    } else if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = errorMessage;
    }

    return { errorType, statusCode, errorMessage };
}

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();

    // Log response on finish
    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const logMsg = `[${req.method}] ${req.originalUrl} ${status} (${duration}ms)`;

        // Skip standard logging for event logging batch unless in debug mode
        if (req.originalUrl === '/api/event_logging/batch' || req.originalUrl.startsWith('/v1/messages/count_tokens') || req.originalUrl.startsWith('/.well-known/')) {
            if (logger.isDebugEnabled) {
                logger.debug(logMsg);
            }
        } else {
            // Colorize status code
            if (status >= 500) {
                logger.error(logMsg);
            } else if (status >= 400) {
                logger.warn(logMsg);
            } else {
                logger.info(logMsg);
            }
        }
    });

    next();
});

/**
 * Silent handler for Claude Code CLI root POST requests
 * Claude Code sends heartbeat/event requests to POST / which we don't need
 */
app.post('/', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

/**
 * Test endpoint - Clear thinking signature cache
 * Used for testing cold cache scenarios in cross-model tests
 */
app.post('/test/clear-signature-cache', (req, res) => {
    clearThinkingSignatureCache();
    logger.debug('[Test] Cleared thinking signature cache');
    res.json({ success: true, message: 'Thinking signature cache cleared' });
});

/**
 * Reload accounts and config from disk
 */
app.all(['/api/accounts/reload', '/reload'], async (req, res) => {
    try {
        reloadConfig();
        resetVersionCache();
        await accountManager.reload();
        res.json({ status: 'ok', message: 'Accounts and config reloaded from disk' });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * Graceful shutdown endpoint
 */
app.post('/api/shutdown', (req, res) => {
    res.json({ status: 'ok', message: 'Proxy shutting down' });
    setTimeout(() => {
        logger.info('[Server] Gracefully exited via shutdown endpoint');
        process.exit(0);
    }, 150);
});

function formatQuotaMap(quotas = {}) {
    const formatted = {};
    for (const [modelId, info] of Object.entries(quotas)) {
        if (!info) continue;
        formatted[modelId] = {
            remaining: info.remaining ?? (info.remainingFraction !== null && info.remainingFraction !== undefined
                ? `${Math.round(info.remainingFraction * 100)}%`
                : 'N/A'),
            remainingFraction: info.remainingFraction ?? null,
            resetTime: info.resetTime || null
        };
    }
    return formatted;
}

function classifyInvalidStatus(account) {
    const reason = (account.invalidReason || '').toLowerCase();
    if (account.verifyUrl) return 'verify-required';
    if (reason.includes('tos') || reason.includes('banned') || reason.includes('suspended') || reason.includes('terms of service')) {
        return 'banned';
    }
    return 'invalid';
}

let accountLimitsInFlight = null;

/*
 * Serve /health from in-memory quota state by default (zero upstream Google API
 * calls) so dashboard renders, CLI status checks, and healthchecks never trigger
 * simultaneous multi-account bursts. Pass ?refresh=true for sequential live probe.
 */
app.get('/health', async (req, res) => {
    try {
        await ensureInitialized();
        const start = Date.now();
        const liveProbe = req.query.refresh === 'true';

        const status = accountManager.getStatus();
        const allAccounts = accountManager.getAllAccounts();
        const detailedAccounts = [];
        let didNetworkCall = false;
        let dirty = false;

        for (const account of allAccounts) {
            const activeModelLimits = Object.entries(account.modelRateLimits || {})
                .filter(([_, limit]) => limit.isRateLimited && limit.resetTime > Date.now());
            const isRateLimited = activeModelLimits.length > 0;
            const soonestReset = activeModelLimits.length > 0
                ? Math.min(...activeModelLimits.map(([_, l]) => l.resetTime))
                : null;

            const baseInfo = {
                email: account.email,
                lastUsed: account.lastUsed ? new Date(account.lastUsed).toISOString() : null,
                verifyUrl: account.verifyUrl || null,
                modelRateLimits: account.modelRateLimits || {},
                rateLimitCooldownRemaining: soonestReset ? Math.max(0, soonestReset - Date.now()) : 0
            };

            if (account.isInvalid) {
                detailedAccounts.push({
                    ...baseInfo,
                    status: classifyInvalidStatus(account),
                    error: account.invalidReason,
                    models: {}
                });
                continue;
            }

            if (!liveProbe || account.enabled === false) {
                detailedAccounts.push({
                    ...baseInfo,
                    status: account.enabled === false ? 'disabled' : (isRateLimited ? 'rate-limited' : 'ok'),
                    models: formatQuotaMap(account.quota?.models || {})
                });
                continue;
            }

            if (didNetworkCall) {
                await sleep(300 + Math.floor(Math.random() * 350));
            }

            try {
                didNetworkCall = true;
                const token = await accountManager.getTokenForAccount(account);
                const projectId = account.subscription?.projectId || account.projectId || null;
                const quotas = await getModelQuotas(token, projectId, account.email);
                account.quota = {
                    models: quotas,
                    lastChecked: Date.now()
                };
                dirty = true;

                detailedAccounts.push({
                    ...baseInfo,
                    status: isRateLimited ? 'rate-limited' : 'ok',
                    models: formatQuotaMap(quotas)
                });
            } catch (error) {
                if (error.message?.startsWith('ACCOUNT_BANNED:')) {
                    accountManager.markInvalid(account.email, 'Account suspended / ToS restriction by Google');
                    dirty = true;
                    detailedAccounts.push({
                        ...baseInfo,
                        status: 'banned',
                        error: 'Account suspended / ToS restriction by Google',
                        models: {}
                    });
                } else if (error.message?.startsWith('VALIDATION_REQUIRED:')) {
                    accountManager.markInvalid(account.email, 'Account requires verification (403)', error.verifyUrl || null);
                    dirty = true;
                    detailedAccounts.push({
                        ...baseInfo,
                        verifyUrl: error.verifyUrl || null,
                        status: 'verify-required',
                        error: 'Account requires verification (403)',
                        models: {}
                    });
                } else {
                    detailedAccounts.push({
                        ...baseInfo,
                        status: 'error',
                        error: error.message,
                        models: formatQuotaMap(account.quota?.models || {})
                    });
                }
            }
        }

        if (dirty) {
            accountManager.saveToDisk().catch((err) => {
                logger.error('[Server] Failed to persist health quota snapshot:', err);
            });
        }

        const activeEmail = accountManager.getCurrentAccount()?.email || null;
        const activeIndex = accountManager.getCurrentIndex();

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            latencyMs: Date.now() - start,
            activeEmail,
            activeIndex,
            summary: status.summary,
            counts: {
                total: status.total,
                available: status.available,
                rateLimited: status.rateLimited,
                invalid: status.invalid
            },
            accounts: detailedAccounts
        });

    } catch (error) {
        logger.error('[API] Health check failed:', error);
        res.status(503).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/*
 * Probe account limits sequentially with random jitter and a configurable TTL
 * cache (default 300s) instead of firing 2*N parallel Cloud Code requests across
 * all consumer accounts on every UI refresh.
 */
app.get('/account-limits', async (req, res) => {
    try {
        await ensureInitialized();
        const format = req.query.format || 'json';
        const includeHistory = req.query.includeHistory === 'true';
        const forceLive = req.query.refresh === 'true';
        const forceSub = req.query.refreshSubscription === 'true';
        const ttlMs = Math.max(0, (config?.quotaRefreshTtlSec ?? 300) * 1000);
        const subTtlMs = 60 * 60 * 1000;

        const runLimitsCollection = async () => {
            const allAccounts = accountManager.getAllAccounts();
            const results = [];
            let didNetworkCall = false;
            let dirty = false;

            for (const account of allAccounts) {
                if (account.isInvalid) {
                    results.push({
                        email: account.email,
                        status: classifyInvalidStatus(account),
                        verifyUrl: account.verifyUrl || null,
                        error: account.invalidReason,
                        subscription: account.subscription || { tier: 'unknown', projectId: null },
                        models: {}
                    });
                    continue;
                }

                const now = Date.now();
                const cachedModels = account.quota?.models;
                const hasCachedModels = cachedModels && Object.keys(cachedModels).length > 0;
                const cacheAgeMs = account.quota?.lastChecked ? (now - account.quota.lastChecked) : Infinity;
                const hasKnownSub = account.subscription?.tier && account.subscription.tier !== 'unknown';

                if (!forceLive && (account.enabled === false || (hasCachedModels && hasKnownSub && cacheAgeMs < ttlMs))) {
                    results.push({
                        email: account.email,
                        status: account.enabled === false ? 'disabled' : 'ok',
                        subscription: account.subscription || { tier: 'unknown', projectId: null },
                        models: cachedModels || {},
                        cached: true
                    });
                    continue;
                }

                if (didNetworkCall) {
                    await sleep(300 + Math.floor(Math.random() * 350));
                }

                try {
                    didNetworkCall = true;
                    const token = await accountManager.getTokenForAccount(account);

                    const subDetectedAt = typeof account.subscription?.detectedAt === 'number'
                        ? account.subscription.detectedAt
                        : (account.subscription?.detectedAt ? new Date(account.subscription.detectedAt).getTime() : 0);
                    const subFresh = hasKnownSub && account.subscription?.projectId && (now - subDetectedAt < subTtlMs);

                    let tier = account.subscription?.tier || 'unknown';
                    let projectId = account.subscription?.projectId || account.projectId || null;

                    if (forceSub || !subFresh) {
                        const sub = await getSubscriptionTier(token, account.email);
                        tier = sub.tier;
                        projectId = sub.projectId || projectId;
                        account.subscription = {
                            tier,
                            projectId,
                            detectedAt: Date.now()
                        };
                    }

                    const quotas = await getModelQuotas(token, projectId, account.email);
                    account.quota = {
                        models: quotas,
                        lastChecked: Date.now()
                    };
                    dirty = true;

                    results.push({
                        email: account.email,
                        status: 'ok',
                        subscription: account.subscription,
                        models: quotas
                    });
                } catch (error) {
                    if (error.message?.startsWith('ACCOUNT_BANNED:')) {
                        const banMsg = 'Account suspended / ToS restriction by Google';
                        accountManager.markInvalid(account.email, banMsg);
                        dirty = true;
                        results.push({
                            email: account.email,
                            status: 'banned',
                            error: banMsg,
                            subscription: account.subscription || { tier: 'unknown', projectId: null },
                            models: {}
                        });
                    } else if (error.message?.startsWith('VALIDATION_REQUIRED:')) {
                        const verifyMsg = 'Account requires verification (403)';
                        accountManager.markInvalid(account.email, verifyMsg, error.verifyUrl || null);
                        dirty = true;
                        results.push({
                            email: account.email,
                            status: 'verify-required',
                            verifyUrl: error.verifyUrl || null,
                            error: verifyMsg,
                            subscription: account.subscription || { tier: 'unknown', projectId: null },
                            models: {}
                        });
                    } else {
                        results.push({
                            email: account.email,
                            status: 'error',
                            error: error.message,
                            subscription: account.subscription || { tier: 'unknown', projectId: null },
                            models: account.quota?.models || {}
                        });
                    }
                }
            }

            if (dirty) {
                accountManager.saveToDisk().catch((err) => {
                    logger.error('[Server] Failed to save account data:', err);
                });
            }

            return results;
        };

        let accountLimits;
        if (accountLimitsInFlight) {
            accountLimits = await accountLimitsInFlight;
        } else {
            accountLimitsInFlight = runLimitsCollection().finally(() => {
                accountLimitsInFlight = null;
            });
            accountLimits = await accountLimitsInFlight;
        }

        // Collect all unique model IDs
        const allModelIds = new Set();
        for (const account of accountLimits) {
            for (const modelId of Object.keys(account.models || {})) {
                allModelIds.add(modelId);
            }
        }

        const sortedModels = Array.from(allModelIds).sort();

        // Return ASCII table format
        if (format === 'table') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');

            // Build table
            const lines = [];
            const timestamp = new Date().toLocaleString();
            lines.push(`Account Limits (${timestamp})`);

            // Get account status info
            const status = accountManager.getStatus();
            lines.push(`Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid`);
            lines.push('');

            // Table 1: Account status
            const accColWidth = 25;
            const statusColWidth = 15;
            const lastUsedColWidth = 25;
            const resetColWidth = 25;

            let accHeader = 'Account'.padEnd(accColWidth) + 'Status'.padEnd(statusColWidth) + 'Last Used'.padEnd(lastUsedColWidth) + 'Quota Reset';
            lines.push(accHeader);
            lines.push('─'.repeat(accColWidth + statusColWidth + lastUsedColWidth + resetColWidth));

            for (const acc of status.accounts) {
                const shortEmail = acc.email.split('@')[0].slice(0, 22);
                const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : 'never';

                // Get status and error from accountLimits
                const accLimit = accountLimits.find(a => a.email === acc.email);
                let accStatus;
                if (acc.isInvalid) {
                    accStatus = 'invalid';
                } else if (accLimit?.status === 'error') {
                    accStatus = 'error';
                } else {
                    // Count exhausted models (0% or null remaining)
                    const models = accLimit?.models || {};
                    const modelCount = Object.keys(models).length;
                    const exhaustedCount = Object.values(models).filter(
                        q => q.remainingFraction === 0 || q.remainingFraction === null
                    ).length;

                    if (exhaustedCount === 0) {
                        accStatus = 'ok';
                    } else {
                        accStatus = `(${exhaustedCount}/${modelCount}) limited`;
                    }
                }

                // Get reset time from quota API
                const claudeModel = sortedModels.find(m => m.includes('claude'));
                const quota = claudeModel && accLimit?.models?.[claudeModel];
                const resetTime = quota?.resetTime
                    ? new Date(quota.resetTime).toLocaleString()
                    : '-';

                let row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

                // Add error on next line if present
                if (accLimit?.error) {
                    lines.push(row);
                    lines.push('  └─ ' + accLimit.error);
                } else {
                    lines.push(row);
                }
            }
            lines.push('');

            // Calculate column widths - need more space for reset time info
            const modelColWidth = Math.max(28, ...sortedModels.map(m => m.length)) + 2;
            const accountColWidth = 30;

            // Header row
            let header = 'Model'.padEnd(modelColWidth);
            for (const acc of accountLimits) {
                const shortEmail = acc.email.split('@')[0].slice(0, 26);
                header += shortEmail.padEnd(accountColWidth);
            }
            lines.push(header);
            lines.push('─'.repeat(modelColWidth + accountLimits.length * accountColWidth));

            // Data rows
            for (const modelId of sortedModels) {
                let row = modelId.padEnd(modelColWidth);
                for (const acc of accountLimits) {
                    const quota = acc.models?.[modelId];
                    let cell;
                    if (acc.status !== 'ok' && acc.status !== 'rate-limited') {
                        cell = `[${acc.status}]`;
                    } else if (!quota) {
                        cell = '-';
                    } else if (quota.remainingFraction === 0 || quota.remainingFraction === null) {
                        // Show reset time for exhausted models
                        if (quota.resetTime) {
                            const resetMs = new Date(quota.resetTime).getTime() - Date.now();
                            if (resetMs > 0) {
                                cell = `0% (wait ${formatDuration(resetMs)})`;
                            } else {
                                cell = '0% (resetting...)';
                            }
                        } else {
                            cell = '0% (exhausted)';
                        }
                    } else {
                        const pct = Math.round(quota.remainingFraction * 100);
                        cell = `${pct}%`;
                    }
                    row += cell.padEnd(accountColWidth);
                }
                lines.push(row);
            }

            return res.send(lines.join('\n'));
        }

        // Get account metadata from AccountManager
        const accountStatus = accountManager.getStatus();
        const accountMetadataMap = new Map(
            accountStatus.accounts.map(a => [a.email, a])
        );

        // Build response data
        const responseData = {
            timestamp: new Date().toLocaleString(),
            totalAccounts: allAccounts.length,
            models: sortedModels,
            modelConfig: config.modelMapping || {},
            globalQuotaThreshold: config.globalQuotaThreshold || 0,
            accounts: accountLimits.map(acc => {
                // Merge quota data with account metadata
                const metadata = accountMetadataMap.get(acc.email) || {};
                return {
                    email: acc.email,
                    status: acc.status,
                    error: acc.error || null,
                    // Include metadata from AccountManager (WebUI needs these)
                    source: metadata.source || 'unknown',
                    enabled: metadata.enabled !== false,
                    projectId: metadata.projectId || null,
                    isInvalid: metadata.isInvalid || false,
                    invalidReason: metadata.invalidReason || null,
                    verifyUrl: metadata.verifyUrl || null,
                    lastUsed: metadata.lastUsed || null,
                    modelRateLimits: metadata.modelRateLimits || {},
                    // Quota threshold settings
                    quotaThreshold: metadata.quotaThreshold,
                    modelQuotaThresholds: metadata.modelQuotaThresholds || {},
                    // Subscription data (new)
                    subscription: acc.subscription || metadata.subscription || { tier: 'unknown', projectId: null },
                    // Quota limits
                    limits: Object.fromEntries(
                        sortedModels.map(modelId => {
                            const quota = acc.models?.[modelId];
                            if (!quota) {
                                return [modelId, null];
                            }
                            return [modelId, {
                                remaining: quota.remainingFraction !== null
                                    ? `${Math.round(quota.remainingFraction * 100)}%`
                                    : 'N/A',
                                remainingFraction: quota.remainingFraction,
                                resetTime: quota.resetTime || null
                            }];
                        })
                    )
                };
            })
        };

        // Optionally include usage history (for dashboard performance optimization)
        if (includeHistory) {
            responseData.history = usageStats.getHistory();
        }

        res.json(responseData);
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * Force token refresh endpoint
 */
app.post('/refresh-token', async (req, res) => {
    try {
        await ensureInitialized();
        // Clear all caches
        accountManager.clearTokenCache();
        accountManager.clearProjectCache();
        // Force refresh default token
        const token = await forceRefresh();
        res.json({
            status: 'ok',
            message: 'Token caches cleared and refreshed',
            tokenPrefix: token.substring(0, 10) + '...'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * List models endpoint (OpenAI-compatible format)
 */
app.get('/v1/models', async (req, res) => {
    try {
        await ensureInitialized();
        const { account } = accountManager.selectAccount();
        if (!account) {
            return res.status(503).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: 'No accounts available'
                }
            });
        }
        const token = await accountManager.getTokenForAccount(account);
        const models = await listModels(token);

        // Virtual Anthropic model definitions for clients
        const virtualModels = [
            { id: 'claude-opus-5.5', object: 'model', created: 1740000000, owned_by: 'anthropic', description: 'Claude Opus 5.5' },
            { id: 'claude-opus-5-5', object: 'model', created: 1740000000, owned_by: 'anthropic', description: 'Claude Opus 5.5' },
            { id: 'claude-opus-5-5-high', object: 'model', created: 1740000000, owned_by: 'anthropic', description: 'Claude Opus 5.5 High' },
            { id: 'claude-3-opus-20240229', object: 'model', created: 1709184000, owned_by: 'anthropic', description: 'Claude 3 Opus' },
            { id: 'claude-3-opus', object: 'model', created: 1709184000, owned_by: 'anthropic', description: 'Claude 3 Opus' },
            { id: 'claude-sonnet-5.5', object: 'model', created: 1740000000, owned_by: 'anthropic', description: 'Claude Sonnet 5.5' },
            { id: 'claude-sonnet-5-5', object: 'model', created: 1740000000, owned_by: 'anthropic', description: 'Claude Sonnet 5.5' },
            { id: 'claude-sonnet-5-5-medium', object: 'model', created: 1740000000, owned_by: 'anthropic', description: 'Claude Sonnet 5.5 Medium' },
            { id: 'claude-sonnet-4-6', object: 'model', created: 1730000000, owned_by: 'anthropic', description: 'Claude Sonnet 4.6' },
            { id: 'claude-3-7-sonnet-20250219', object: 'model', created: 1740000000, owned_by: 'anthropic', description: 'Claude 3.7 Sonnet (Thinking)' },
            { id: 'claude-3-5-sonnet-20241022', object: 'model', created: 1729555200, owned_by: 'anthropic', description: 'Claude 3.5 Sonnet v2' },
            { id: 'claude-3-5-sonnet', object: 'model', created: 1729555200, owned_by: 'anthropic', description: 'Claude 3.5 Sonnet' },
            { id: 'claude-haiku-4.5', object: 'model', created: 1740000000, owned_by: 'anthropic', description: 'Claude Haiku 4.5' },
            { id: 'claude-haiku-4-5', object: 'model', created: 1740000000, owned_by: 'anthropic', description: 'Claude Haiku 4.5' },
            { id: 'claude-haiku-5-5', object: 'model', created: 1740000000, owned_by: 'anthropic', description: 'Claude Haiku 5.5' },
            { id: 'claude-3-5-haiku-20241022', object: 'model', created: 1729555200, owned_by: 'anthropic', description: 'Claude 3.5 Haiku' },
            { id: 'claude-3-5-haiku', object: 'model', created: 1729555200, owned_by: 'anthropic', description: 'Claude 3.5 Haiku' }
        ];

        // Also expose any user-configured custom model mappings
        const modelMapping = config.modelMapping || {};
        for (const [customId, target] of Object.entries(modelMapping)) {
            const targetName = typeof target === 'string' ? target : (target?.mapping || 'custom');
            virtualModels.push({
                id: customId,
                object: 'model',
                created: 1740000000,
                owned_by: 'anthropic',
                description: `Custom mapped -> ${targetName}`
            });
        }

        const existingIds = new Set((models.data || []).map(m => m.id));
        const newVirtual = virtualModels.filter(m => !existingIds.has(m.id));
        models.data = [...newVirtual, ...(models.data || [])];

        res.json(models);
    } catch (error) {
        logger.error('[API] Error listing models:', error);
        res.status(500).json({
            type: 'error',
            error: {
                type: 'api_error',
                message: error.message
            }
        });
    }
});

/**
 * Count tokens endpoint - Anthropic Messages API compatible
 * Uses local tokenization with official tokenizers (@anthropic-ai/tokenizer for Claude, @lenml/tokenizer-gemini for Gemini)
 */
app.post('/v1/messages/count_tokens', (req, res) => {
    res.status(501).json({
        type: 'error',
        error: {
            type: 'not_implemented',
            message: 'Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.'
        }
    });
});

/**
 * Main messages endpoint - Anthropic Messages API compatible
 */


/**
 * Anthropic-compatible Messages API
 * POST /v1/messages
 */
app.post('/v1/messages', async (req, res) => {
    try {
        // Ensure account manager is initialized
        await ensureInitialized();

        const {
            model,
            messages,
            stream,
            system,
            max_tokens,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        } = req.body;

        // Resolve model mapping if configured
        const originalRequestedModel = model;
        let requestedModel = model || 'claude-3-5-sonnet-20241022';
        const modelMapping = config.modelMapping || {};

        let mappedTarget = null;
        if (modelMapping[requestedModel]) {
            mappedTarget = typeof modelMapping[requestedModel] === 'string'
                ? modelMapping[requestedModel]
                : modelMapping[requestedModel].mapping;
        } else {
            // Flexible fuzzy alias resolution
            const lower = requestedModel.toLowerCase();
            if (lower.includes('opus')) {
                const k = Object.keys(modelMapping).find(key => key.toLowerCase().includes('opus'));
                if (k) mappedTarget = typeof modelMapping[k] === 'string' ? modelMapping[k] : modelMapping[k].mapping;
                else mappedTarget = 'gemini-3.8-flash-high'; // Sensible fast default for opus
            } else if (lower.includes('sonnet')) {
                const k = Object.keys(modelMapping).find(key => key.toLowerCase().includes('sonnet'));
                if (k) mappedTarget = typeof modelMapping[k] === 'string' ? modelMapping[k] : modelMapping[k].mapping;
                else mappedTarget = 'gemini-3.8-flash-high';
            } else if (lower.includes('haiku')) {
                const k = Object.keys(modelMapping).find(key => key.toLowerCase().includes('haiku'));
                if (k) mappedTarget = typeof modelMapping[k] === 'string' ? modelMapping[k] : modelMapping[k].mapping;
                else mappedTarget = 'gemini-3.1-flash-lite';
            }
        }

        if (mappedTarget) {
            logger.info(`[Server] Mapping model ${requestedModel} -> ${mappedTarget}`);
            requestedModel = mappedTarget;
        }

        // Strip client context annotations like [1m] or [200k] for backend routing and validation
        const cleanModel = (requestedModel || '').replace(/\[\d+[kmbKMB]?\]$/, '');
        const modelId = cleanModel;
        req.body.model = cleanModel;

        // Validate model ID before processing
        const { account: validationAccount } = accountManager.selectAccount();
        if (validationAccount) {
            const token = await accountManager.getTokenForAccount(validationAccount);
            const projectId = validationAccount.subscription?.projectId || null;
            const valid = await isValidModel(modelId, token, projectId);

            if (!valid) {
                throw new Error(`invalid_request_error: Invalid model: ${modelId}. Use /v1/models to see available models.`);
            }
        }

        // Optimistic Retry: If ALL accounts are rate-limited for this model, reset them to force a fresh check.
        // If we have some available accounts, we try them first.
        if (accountManager.isAllRateLimited(modelId)) {
            logger.warn(`[Server] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`);
            accountManager.resetAllRateLimits();
        }

        // Validate required fields
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'messages is required and must be an array'
                }
            });
        }

        // Filter out "count" requests (often automated background checks)
        if (messages.length === 1 && messages[0].content === 'count') {
            return res.json({});
        }

        // Build the request object
        const request = {
            model: modelId,
            messages,
            max_tokens: max_tokens || 4096,
            stream,
            system,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        };

        logger.info(`[API] Request for model: ${request.model}, stream: ${!!stream}`);

        // Debug: Log message structure to diagnose tool_use/tool_result ordering
        if (logger.isDebugEnabled) {
            logger.debug('[API] Message structure:');
            messages.forEach((msg, i) => {
                const contentTypes = Array.isArray(msg.content)
                    ? msg.content.map(c => c.type || 'text').join(', ')
                    : (typeof msg.content === 'string' ? 'text' : 'unknown');
                logger.debug(`  [${i}] ${msg.role}: ${contentTypes}`);
            });
        }

        if (stream) {
            // Handle streaming response
            // Do NOT flush headers immediately. We need to wait for the first chunk
            // to ensure we don't send a 200 OK if the upstream fails immediately (e.g. 429/503).

            try {
                // Initialize the generator
                const generator = sendMessageStream(request, accountManager, FALLBACK_ENABLED);
                
                // BUFFERING STRATEGY:
                // Pull the first event *before* sending headers. 
                // If this throws, we can safely send a 4xx/5xx error JSON.
                const firstResult = await generator.next();

                // If we get here, the stream started successfully.
                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                const formatEventForClient = (event) => {
                    if (originalRequestedModel && event && event.type === 'message_start' && event.message) {
                        return {
                            ...event,
                            message: {
                                ...event.message,
                                model: originalRequestedModel
                            }
                        };
                    }
                    return event;
                };

                // If the generator isn't done, send the first chunk
                if (!firstResult.done) {
                    const evt = formatEventForClient(firstResult.value);
                    res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
                    if (res.flush) res.flush();
                }

                // Continue with the rest of the stream
                for await (const event of generator) {
                    const evt = formatEventForClient(event);
                    res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
                    if (res.flush) res.flush();
                }
                
                res.end();

            } catch (error) {
                // If we haven't sent headers yet, we can send a proper error status
                if (!res.headersSent) {
                    logger.error('[API] Initial stream error:', error);
                    const { errorType, statusCode, errorMessage } = parseError(error);

                    if (statusCode === 429) {
                        let retrySec = 60;
                        const durMatch = errorMessage.match(/(\d+)h(\d+)m(\d+)s|(\d+)m(\d+)s|(\d+)s/i);
                        if (durMatch) {
                            if (durMatch[1]) retrySec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseInt(durMatch[3], 10);
                            else if (durMatch[4]) retrySec = parseInt(durMatch[4], 10) * 60 + parseInt(durMatch[5], 10);
                            else if (durMatch[6]) retrySec = parseInt(durMatch[6], 10);
                        }
                        res.setHeader('Retry-After', retrySec.toString());
                    }

                    return res.status(statusCode).json({
                        type: 'error',
                        error: {
                            type: errorType,
                            message: errorMessage
                        }
                    });
                }
                
                // If headers were already sent (should only happen if error occurs mid-stream),
                // we have to fallback to SSE error event
                logger.error('[API] Mid-stream error:', error);
                const { errorType, errorMessage } = parseError(error);

                res.write(`event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: { type: errorType, message: errorMessage }
                })}\n\n`);
                res.end();
            }

        } else {
            // Handle non-streaming response
            const response = await sendMessage(request, accountManager, FALLBACK_ENABLED);
            if (originalRequestedModel && response) {
                response.model = originalRequestedModel;
            }
            res.json(response);
        }

    } catch (error) {
        logger.error('[API] Error:', error);

        let { errorType, statusCode, errorMessage } = parseError(error);

        // For auth errors, try to refresh token
        if (errorType === 'authentication_error') {
            logger.warn('[API] Token might be expired, attempting refresh...');
            try {
                accountManager.clearProjectCache();
                accountManager.clearTokenCache();
                await forceRefresh();
                errorMessage = 'Token was expired and has been refreshed. Please retry your request.';
            } catch (refreshError) {
                errorMessage = 'Could not refresh token. Make sure Antigravity is running.';
            }
        }

        logger.warn(`[API] Returning error response: ${statusCode} ${errorType} - ${errorMessage}`);

        // Check if headers have already been sent (for streaming that failed mid-way)
        if (res.headersSent) {
            logger.warn('[API] Headers already sent, writing error as SSE event');
            res.write(`event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: { type: errorType, message: errorMessage }
            })}\n\n`);
            res.end();
        } else {
            if (statusCode === 429) {
                let retrySec = 60;
                const durMatch = errorMessage.match(/(\d+)h(\d+)m(\d+)s|(\d+)m(\d+)s|(\d+)s/i);
                if (durMatch) {
                    if (durMatch[1]) retrySec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseInt(durMatch[3], 10);
                    else if (durMatch[4]) retrySec = parseInt(durMatch[4], 10) * 60 + parseInt(durMatch[5], 10);
                    else if (durMatch[6]) retrySec = parseInt(durMatch[6], 10);
                }
                res.setHeader('Retry-After', retrySec.toString());
            }

            res.status(statusCode).json({
                type: 'error',
                error: {
                    type: errorType,
                    message: errorMessage
                }
            });
        }
    }
});

/**
 * Catch-all for unsupported endpoints
 */
usageStats.setupRoutes(app);

app.use('*', (req, res) => {
    // Log 404s (use originalUrl since wildcard strips req.path)
    if (logger.isDebugEnabled) {
        logger.debug(`[API] 404 Not Found: ${req.method} ${req.originalUrl}`);
    }
    res.status(404).json({
        type: 'error',
        error: {
            type: 'not_found_error',
            message: `Endpoint ${req.method} ${req.originalUrl} not found`
        }
    });
});

export default app;

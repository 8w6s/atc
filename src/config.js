import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './utils/logger.js';

function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

const DENIED_KEYS = ['__proto__', 'constructor', 'prototype'];

const REPLACE_WHOLE_KEYS = new Set(['modelMapping']);

function deepMerge(target, source) {
    const output = { ...target };
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (DENIED_KEYS.includes(key)) return;
            if (source[key] === undefined) {
                delete output[key];
                return;
            }
            if (REPLACE_WHOLE_KEYS.has(key) && isObject(source[key])) {
                output[key] = { ...source[key] };
            } else if (isObject(source[key])) {
                if (!(key in target) || !isObject(target[key])) {
                    output[key] = deepMerge({}, source[key]);
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                output[key] = source[key];
            }
        });
    }
    return output;
}

// Default config
const DEFAULT_CONFIG = {
    apiKey: '',
    bindHost: '127.0.0.1',
    debug: false,
    devMode: false,
    logLevel: 'info',
    maxRetries: 2,
    retryBaseMs: 1000,
    retryMaxMs: 30000,
    persistTokenCache: false,
    defaultCooldownMs: 10000,  // 10 seconds
    maxWaitBeforeErrorMs: 90000, // 90 seconds
    maxAccounts: 10, // Maximum number of accounts allowed
    globalQuotaThreshold: 0.10, // 0 = disabled, 0.01-0.50 = safety quota floor before rotating away
    singleAccountLock: false, // Hard-lock traffic to active account (never auto-rotate)
    showTips: true, // Show scrolling safety/operational tips banner on dashboard
    hourlyAccountCap: 120, // Soft hourly request cap per account (0 = unlimited)
    pacerDelayMs: 250, // Per-account burst stagger gap in ms (0ms latency when idle, spaces parallel bursts)
    upstreamTimeoutSec: 300, // Active upstream stream socket timeout in seconds
    requestThrottlingEnabled: false, // Legacy global pre-request sleep
    requestDelayMs: 200, // Delay in ms when legacy global throttling is enabled
    // Rate limit handling (matches opencode-antigravity-auth)
    rateLimitDedupWindowMs: 2000,  // 2 seconds - prevents concurrent retry storms
    maxConsecutiveFailures: 3,     // Before applying extended cooldown
    extendedCooldownMs: 60000,     // 1 minute extended cooldown
    maxCapacityRetries: 2,         // Max retries for capacity exhaustion
    switchAccountDelayMs: 5000,    // Delay before switching accounts on rate limit
    capacityBackoffTiersMs: [5000, 10000, 20000, 30000, 60000], // Progressive backoff tiers for capacity exhaustion
    modelMapping: {},
    // Antigravity client version sent to Cloud Code (X-Client-Version / User-Agent).
    // Empty = auto-detect from local Antigravity install, then hardcoded fallback.
    // The backend hides newer models from outdated client versions.
    antigravityClientVersion: '',
    antigravityIdeVersion: '',
    oauth: {
        clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || ''
    },
    loginTimeoutSec: 120, // OAuth login callback timeout in seconds (default 120s / 2m)
    quotaRefreshTtlSec: 300, // Cache lifetime for live quota probes (seconds)
    // Account selection strategy configuration
    accountSelection: {
        strategy: 'pipelined',        // 'pipelined' | 'sticky' | 'round-robin' | 'hybrid'
        stepThreshold: 0.05,          // 5% quota step before proactive rotation
        requestThreshold: 20,         // Fallback request cap if quota telemetry lags
        minStaySec: 180,              // Minimum stay time (seconds) before proactive rotation
        // Hybrid strategy tuning (optional - sensible defaults)
        healthScore: {
            initial: 70,              // Starting score for new accounts
            successReward: 1,         // Points on successful request
            rateLimitPenalty: -10,    // Points on rate limit
            failurePenalty: -20,      // Points on other failures
            recoveryPerHour: 10,      // Passive recovery rate (matches health-tracker.js)
            minUsable: 50,            // Minimum score to be selected
            maxScore: 100             // Maximum score cap
        },
        tokenBucket: {
            maxTokens: 50,            // Maximum token capacity
            tokensPerMinute: 6,       // Regeneration rate
            initialTokens: 50         // Starting tokens
        },
        quota: {
            lowThreshold: 0.10,       // 10% - reduce score
            criticalThreshold: 0.05,  // 5% - exclude from candidates
            staleMs: 300000           // 5 min - max age of quota data to trust
        },
        weights: {
            health: 2,                // Weight for health score component
            tokens: 5,                // Weight for token bucket component
            quota: 3,                 // Weight for quota awareness component
            lru: 0.1                  // Weight for LRU freshness component
        }
    }
};

// Config locations
const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.config', 'atc');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Ensure config dir exists
if (!fs.existsSync(CONFIG_DIR)) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    } catch (err) {
        // Ignore
    }
}

// Load config
let config = { ...DEFAULT_CONFIG };

function loadConfig() {
    try {
        let next = { ...DEFAULT_CONFIG };
        if (fs.existsSync(CONFIG_FILE)) {
            const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
            const userConfig = JSON.parse(fileContent);
            next = deepMerge(DEFAULT_CONFIG, userConfig);
        } else {
            const localConfigPath = path.resolve('config.json');
            if (fs.existsSync(localConfigPath)) {
                const fileContent = fs.readFileSync(localConfigPath, 'utf8');
                const userConfig = JSON.parse(fileContent);
                next = deepMerge(DEFAULT_CONFIG, userConfig);
            }
        }

        if (process.env.API_KEY) next.apiKey = process.env.API_KEY;
        if (process.env.DEBUG === 'true') next.debug = true;
        if (process.env.DEV_MODE === 'true') next.devMode = true;
        if (next.debug && !next.devMode) next.devMode = true;

        for (const k of Object.keys(config)) {
            delete config[k];
        }
        Object.assign(config, next);
    } catch (error) {
        logger.error('[Config] Error loading config:', error);
    }
}

// Initial load
loadConfig();

export function getPublicConfig() {
    // Create a deep copy and redact sensitive fields
    const publicConfig = JSON.parse(JSON.stringify(config));

    // Redact sensitive values
    if (publicConfig.apiKey) publicConfig.apiKey = '********';
    if (publicConfig.oauth?.clientSecret) publicConfig.oauth.clientSecret = '********';

    return publicConfig;
}

export function saveConfig(updates) {
    try {
        /*
         * Re-read CONFIG_FILE before merging so a long-lived TUI window with
         * stale in-memory state cannot clobber port relocations or safety
         * settings written concurrently by CLI commands or the daemon.
         */
        let diskBase = { ...DEFAULT_CONFIG };
        if (fs.existsSync(CONFIG_FILE)) {
            try {
                const diskJson = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
                diskBase = deepMerge(DEFAULT_CONFIG, diskJson);
            } catch {}
        }
        const merged = deepMerge(diskBase, updates);
        for (const k of Object.keys(config)) {
            delete config[k];
        }
        Object.assign(config, merged);

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
        return true;
    } catch (error) {
        logger.error('[Config] Failed to save config:', error);
        return false;
    }
}

export function reloadConfig() {
    loadConfig();
    return config;
}

export { config, loadConfig };

/**
 * Account Storage
 *
 * Handles loading and saving account configuration to disk.
 */

import { readFile, writeFile, mkdir, access, rename, unlink, copyFile, chmod } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { dirname } from 'path';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { getAuthStatus } from '../auth/database.js';
import { logger } from '../utils/logger.js';

let writeLock = null;
let tmpCounter = 0;

/**
 * Load accounts from the config file
 *
 * @param {string} configPath - Path to the config file
 * @returns {Promise<{accounts: Array, settings: Object, activeIndex: number}>}
 */
export async function loadAccounts(configPath = ACCOUNT_CONFIG_PATH) {
    let configData = null;
    let config = null;

    try {
        await access(configPath, fsConstants.F_OK);
        configData = await readFile(configPath, 'utf-8');
        config = JSON.parse(configData);
    } catch (parseOrReadErr) {
        if (parseOrReadErr.code === 'ENOENT') {
            logger.info('[AccountManager] No config file found. Using Antigravity database (single account mode)');
            return { accounts: [], settings: {}, activeIndex: 0 };
        }

        // If file exists but contains invalid/corrupt JSON, preserve corrupt file and restore from backup
        logger.error(`[AccountManager] Syntax error in ${configPath}: ${parseOrReadErr.message}`);
        const corruptBackup = `${configPath}.corrupt-${Date.now()}`;
        try {
            await rename(configPath, corruptBackup);
            logger.warn(`[AccountManager] Preserved corrupt accounts file as ${corruptBackup}`);
        } catch {}

        try {
            const bakPath = `${configPath}.bak`;
            await access(bakPath, fsConstants.F_OK);
            const bakData = await readFile(bakPath, 'utf-8');
            config = JSON.parse(bakData);
            logger.warn(`[AccountManager] Successfully restored account pool from backup: ${bakPath}`);
        } catch (bakErr) {
            logger.error(`[AccountManager] Could not restore from backup: ${bakErr.message}`);
            return { accounts: [], settings: {}, activeIndex: 0 };
        }
    }

    try {
        const accounts = (config.accounts || []).map(acc => ({
            ...acc,
            lastUsed: acc.lastUsed || null,
            enabled: acc.enabled !== false, // Default to true if not specified
            // Reset invalid flag on startup - give accounts a fresh chance
            // EXCEPT accounts with a verifyUrl — those need user intervention
            isInvalid: acc.verifyUrl ? (acc.isInvalid || false) : false,
            invalidReason: acc.verifyUrl ? (acc.invalidReason || null) : null,
            verifyUrl: acc.verifyUrl || null,
            modelRateLimits: acc.modelRateLimits || {},
            // New fields for subscription and quota tracking
            subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
            quota: acc.quota || { models: {}, lastChecked: null },
            // Quota threshold settings (per-account and per-model overrides)
            quotaThreshold: acc.quotaThreshold,  // undefined means use global
            modelQuotaThresholds: acc.modelQuotaThresholds || {}
        }));

        const settings = config.settings || {};
        let activeIndex = config.activeIndex || 0;

        // Clamp activeIndex to valid range
        if (activeIndex >= accounts.length) {
            activeIndex = 0;
        }

        logger.info(`[AccountManager] Loaded ${accounts.length} account(s) from config`);

        return { accounts, settings, activeIndex };
    } catch (error) {
        if (error.code === 'ENOENT') {
            // No config file - return empty
            logger.info('[AccountManager] No config file found. Using Antigravity database (single account mode)');
        } else {
            logger.error('[AccountManager] Failed to load config:', error.message);
        }
        return { accounts: [], settings: {}, activeIndex: 0 };
    }
}

/**
 * Load the default account from Antigravity's database
 *
 * @param {string} dbPath - Optional path to the database
 * @returns {{accounts: Array, tokenCache: Map}}
 */
export function loadDefaultAccount(dbPath) {
    try {
        const authData = getAuthStatus(dbPath);
        if (authData?.apiKey) {
            const account = {
                email: authData.email || 'default@antigravity',
                source: 'database',
                lastUsed: null,
                modelRateLimits: {}
            };

            const tokenCache = new Map();
            tokenCache.set(account.email, {
                token: authData.apiKey,
                extractedAt: Date.now()
            });

            logger.info(`[AccountManager] Loaded default account: ${account.email}`);

            return { accounts: [account], tokenCache };
        }
    } catch (error) {
        logger.error('[AccountManager] Failed to load default account:', error.message);
    }

    return { accounts: [], tokenCache: new Map() };
}

/**
 * Save account configuration to disk
 *
 * @param {string} configPath - Path to the config file
 * @param {Array} accounts - Array of account objects
 * @param {Object} settings - Settings object
 * @param {number} activeIndex - Current active account index
 */
export async function saveAccounts(configPath, accounts, settings, activeIndex) {
    // Serialize writes to prevent concurrent corruption
    const previousLock = writeLock;
    let resolve;
    writeLock = new Promise(r => { resolve = r; });

    try {
        if (previousLock) await previousLock;
    } catch {
        // Previous write failed, proceed anyway
    }

    try {
        const dir = dirname(configPath);
        await mkdir(dir, { recursive: true });

        const config = {
            accounts: accounts.map(acc => ({
                email: acc.email,
                source: acc.source,
                enabled: acc.enabled !== false,
                dbPath: acc.dbPath || null,
                refreshToken: acc.source === 'oauth' ? acc.refreshToken : undefined,
                apiKey: acc.source === 'manual' ? acc.apiKey : undefined,
                projectId: acc.projectId || undefined,
                addedAt: acc.addedAt || undefined,
                isInvalid: acc.isInvalid || false,
                invalidReason: acc.invalidReason || null,
                verifyUrl: acc.verifyUrl || null,
                modelRateLimits: acc.modelRateLimits || {},
                lastUsed: acc.lastUsed,
                subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
                quota: acc.quota || { models: {}, lastChecked: null },
                quotaThreshold: acc.quotaThreshold,
                modelQuotaThresholds: Object.keys(acc.modelQuotaThresholds || {}).length > 0 ? acc.modelQuotaThresholds : undefined
            })),
            settings: settings,
            activeIndex: activeIndex
        };

        const json = JSON.stringify(config, null, 2);

        // Validate JSON before writing (prevent saving corrupt data)
        JSON.parse(json);

        /*
         * Per-process unique temp path avoids collisions when the TUI and background
         * daemon persist accounts.json concurrently. On Windows, transient reader
         * handles (TUI refresh or Defender scan) can reject atomic rename with EPERM;
         * retry briefly before falling back to an in-place write.
         */
        const tmpPath = `${configPath}.${process.pid}.${++tmpCounter}.tmp`;
        await writeFile(tmpPath, json, 'utf-8');
        let renamed = false;
        let lastRenameErr = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
            try {
                await rename(tmpPath, configPath);
                renamed = true;
                break;
            } catch (err) {
                lastRenameErr = err;
                if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY') {
                    await new Promise((r) => setTimeout(r, 35 * attempt));
                    continue;
                }
                throw err;
            }
        }
        if (!renamed) {
            try {
                await writeFile(configPath, json, 'utf-8');
            } finally {
                await unlink(tmpPath).catch(() => {});
            }
            if (lastRenameErr && process.env.DEBUG) {
                logger.warn(`[AccountManager] Atomic rename fallback used (${lastRenameErr.code})`);
            }
        }

        // Maintain atomic .bak copy and restrict permissions on POSIX
        await copyFile(configPath, `${configPath}.bak`).catch(() => {});
        if (process.platform !== 'win32') {
            await chmod(configPath, 0o600).catch(() => {});
            await chmod(`${configPath}.bak`, 0o600).catch(() => {});
        }
    } catch (error) {
        logger.error('[AccountManager] Failed to save config:', error.message);
    } finally {
        resolve();
    }
}

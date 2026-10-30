/**
 * Message Handler for Cloud Code
 *
 * Handles non-streaming message requests with multi-account support,
 * retry logic, and endpoint failover.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    MAX_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS,
    DEFAULT_COOLDOWN_MS,
    SWITCH_ACCOUNT_DELAY_MS,
    MAX_CONSECUTIVE_FAILURES,
    EXTENDED_COOLDOWN_MS,
    CAPACITY_BACKOFF_TIERS_MS,
    MAX_CAPACITY_RETRIES,
    BACKOFF_BY_ERROR_TYPE,
    isThinkingModel
} from '../constants.js';
import { config } from '../config.js';
import { convertGoogleToAnthropic } from '../format/index.js';
import { isRateLimitError, isAuthError, isAccountForbiddenError, AccountForbiddenError } from '../errors.js';
import { formatDuration, sleep, isNetworkError, throttledFetch } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { parseResetTime } from './rate-limit-parser.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { parseThinkingSSEResponse } from './sse-parser.js';
import { getFallbackModel } from '../fallback-config.js';
import {
    getRateLimitBackoff,
    clearRateLimitState,
    isPermanentAuthFailure,
    isModelCapacityExhausted,
    isValidationRequired,
    extractVerificationUrl,
    isAccountBanned,
    calculateSmartBackoff
} from './rate-limit-state.js';

/**
 * Send a non-streaming request to Cloud Code with multi-account support
 * Uses SSE endpoint for thinking models (non-streaming doesn't return thinking blocks)
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {Object} anthropicRequest.model - Model name to use
 * @param {Array} anthropicRequest.messages - Array of message objects
 * @param {number} [anthropicRequest.max_tokens] - Maximum tokens to generate
 * @param {Object} [anthropicRequest.thinking] - Thinking configuration
 * @param {import('../account-manager/index.js').default} accountManager - The account manager instance
 * @returns {Promise<Object>} Anthropic-format response object
 * @throws {Error} If max retries exceeded or no accounts available
 */
function getSwitchDelayWithJitter() {
    const base = Number.isFinite(config?.switchAccountDelayMs) ? config.switchAccountDelayMs : SWITCH_ACCOUNT_DELAY_MS;
    if (base <= 0) return 0;
    return Math.round(base * (0.85 + Math.random() * 0.3));
}

export async function sendMessage(anthropicRequest, accountManager, fallbackEnabled = false, onAccountSelected = null) {
    const rawModel = anthropicRequest.model || '';
    const model = rawModel.replace(/\[\d+[kmbKMB]?\]$/, '');
    const isThinking = isThinkingModel(model);
    const singleLock = Boolean(config?.singleAccountLock || accountManager?.isSingleAccountLocked?.());
    const cfgMaxRetries = Number.isFinite(config?.maxRetries) ? config.maxRetries : MAX_RETRIES;
    const cfgMaxWaitMs = Number.isFinite(config?.maxWaitBeforeErrorMs) ? config.maxWaitBeforeErrorMs : MAX_WAIT_BEFORE_ERROR_MS;
    const cfgMaxCapRetries = Number.isFinite(config?.maxCapacityRetries) ? config.maxCapacityRetries : MAX_CAPACITY_RETRIES;

    const maxAttempts = singleLock
        ? 1
        : Math.max(1, Math.min(Math.max(1, accountManager.getAccountCount()), cfgMaxRetries + 1));

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Clear any expired rate limits before picking
        accountManager.clearExpiredLimits();

        // Get available accounts for this model
        const availableAccounts = accountManager.getAvailableAccounts(model);

        // If no accounts available, check if we should wait or throw error
        if (availableAccounts.length === 0) {
            if (accountManager.isAllAccountsInvalid()) {
                const invalidAccounts = accountManager.getInvalidAccounts();
                const reasons = [...new Set(invalidAccounts.map(a => a.invalidReason).filter(Boolean))];
                throw new Error(
                    `All accounts are invalid: ${reasons.join('; ') || 'unknown reason'}. Run "atc" to inspect and re-authenticate accounts.`
                );
            }

            if (singleLock) {
                const locked = accountManager.getCurrentAccount();
                const lockedEmail = locked?.email || 'active account';
                const limitInfo = locked ? accountManager.getRateLimitInfo(locked.email, model) : null;
                if (limitInfo?.isRateLimited && limitInfo.waitMs > 0) {
                    throw new Error(
                        `RESOURCE_EXHAUSTED: Rate limited on ${model} (Single-Account Lock on ${lockedEmail}). Quota will reset after ${formatDuration(limitInfo.waitMs)}.`
                    );
                }
                const hourlyCap = Number(config?.hourlyAccountCap) || 0;
                if (locked && hourlyCap > 0 && accountManager.getHourlyRequestCount(locked.email) >= hourlyCap) {
                    throw new Error(
                        `RESOURCE_EXHAUSTED: Hourly request cap (${hourlyCap}/h) reached on locked account ${lockedEmail} for ${model}.`
                    );
                }
            }

            if (accountManager.isAllRateLimited(model)) {
                const minWaitMs = accountManager.getMinWaitTimeMs(model);
                const resetTime = new Date(Date.now() + minWaitMs).toISOString();

                if (minWaitMs > cfgMaxWaitMs) {
                    if (fallbackEnabled) {
                        const fallbackModel = getFallbackModel(model);
                        if (fallbackModel) {
                            logger.warn(`[CloudCode] All accounts exhausted for ${model} (${formatDuration(minWaitMs)} wait). Attempting fallback to ${fallbackModel}`);
                            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
                            return await sendMessage(fallbackRequest, accountManager, false, onAccountSelected);
                        }
                    }
                    throw new Error(
                        `RESOURCE_EXHAUSTED: Rate limited on ${model}. Quota will reset after ${formatDuration(minWaitMs)}. Next available: ${resetTime}`
                    );
                }

                const accountCount = accountManager.getAccountCount();
                logger.warn(`[CloudCode] All ${accountCount} account(s) rate-limited. Waiting ${formatDuration(minWaitMs)}...`);
                await sleep(minWaitMs + 500);
                accountManager.clearExpiredLimits();

                attempt--;
                continue;
            }

            const hourlyCap = Number(config?.hourlyAccountCap) || 0;
            if (hourlyCap > 0) {
                throw new Error(
                    `RESOURCE_EXHAUSTED: Hourly request cap (${hourlyCap}/h per account) reached on ${model}. Adjust Hourly Cap in "atc settings" if needed.`
                );
            }

            throw new Error('No accounts available');
        }

        // Select account using configured strategy
        const { account, waitMs } = accountManager.selectAccount(model);

        // If strategy returns a wait time without an account, sleep and retry
        if (!account && waitMs > 0) {
            logger.info(`[CloudCode] Waiting ${formatDuration(waitMs)} for account...`);
            await sleep(waitMs + 500);
            attempt--; // CRITICAL FIX: Don't count strategy wait as failure
            continue;
        }

        // If strategy returns an account with throttle wait (fallback mode), apply delay
        // This prevents overwhelming the API when using emergency/lastResort fallbacks
        if (account && waitMs > 0) {
            logger.debug(`[CloudCode] Throttling request (${waitMs}ms) - fallback mode active`);
            await sleep(waitMs);
        }

        if (!account) {
            logger.warn(`[CloudCode] Strategy returned no account for ${model} (attempt ${attempt + 1}/${maxAttempts})`);
            continue;
        }

        if (typeof onAccountSelected === 'function') {
            onAccountSelected(account.email, model);
        }

        try {
            // Get token and project for this account
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = buildCloudCodeRequest(anthropicRequest, project, account.email);

            logger.debug(`[CloudCode] Sending request for model: ${model}`);

            // Try each endpoint with index-based loop for capacity retry support
            let lastError = null;
            let capacityRetryCount = 0;
            let endpointIndex = 0;

            while (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length) {
                const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex];
                try {
                    const url = isThinking
                        ? `${endpoint}/v1internal:streamGenerateContent?alt=sse`
                        : `${endpoint}/v1internal:generateContent`;

                    const response = await throttledFetch(url, {
                        method: 'POST',
                        headers: buildHeaders(token),
                        body: JSON.stringify(payload),
                        accountKey: account.email
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        logger.warn(`[CloudCode] Error at ${endpoint}: ${response.status} - ${errorText}`);

                        if (response.status === 401) {
                            // Check for permanent auth failures
                            if (isPermanentAuthFailure(errorText)) {
                                logger.error(`[CloudCode] Permanent auth failure for ${account.email}: ${errorText.substring(0, 100)}`);
                                accountManager.markInvalid(account.email, 'Token revoked - re-authentication required');
                                throw new Error(`AUTH_INVALID_PERMANENT: ${errorText}`);
                            }

                            // Transient auth error - clear caches and retry with fresh token
                            logger.warn('[CloudCode] Transient auth error, refreshing token...');
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            endpointIndex++;
                            continue;
                        }

                        // Check for Quota / Rate limit (either HTTP 429 or HTTP 400 with RESOURCE_EXHAUSTED)
                        const lowerErrorText = (errorText || '').toLowerCase();
                        const isQuotaOrRateLimit = response.status === 429 ||
                            lowerErrorText.includes('resource_exhausted') ||
                            lowerErrorText.includes('quota_exhausted') ||
                            lowerErrorText.includes('exhausted your capacity') ||
                            lowerErrorText.includes('quota will reset') ||
                            lowerErrorText.includes('quota exceeded') ||
                            lowerErrorText.includes('daily limit');

                        if (isQuotaOrRateLimit) {
                            const resetMs = parseResetTime(response, errorText);
                            const consecutiveFailures = accountManager.getConsecutiveFailures?.(account.email) || 0;

                            if (isModelCapacityExhausted(errorText)) {
                                if (capacityRetryCount < cfgMaxCapRetries) {
                                    const tierIndex = Math.min(capacityRetryCount, CAPACITY_BACKOFF_TIERS_MS.length - 1);
                                    const waitMs = resetMs || CAPACITY_BACKOFF_TIERS_MS[tierIndex];
                                    capacityRetryCount++;
                                    accountManager.incrementConsecutiveFailures(account.email);
                                    logger.info(`[CloudCode] Model capacity exhausted, retry ${capacityRetryCount}/${cfgMaxCapRetries} after ${formatDuration(waitMs)}...`);
                                    await sleep(waitMs);
                                    continue;
                                }
                                logger.warn(`[CloudCode] Max capacity retries (${cfgMaxCapRetries}) exceeded, switching account`);
                            }

                            // For very short rate limits (< 1 second), always wait and retry
                            if (resetMs !== null && resetMs < 1000) {
                                const waitMs = resetMs;
                                logger.info(`[CloudCode] Short rate limit on ${account.email} (${resetMs}ms), waiting and retrying...`);
                                await sleep(waitMs);
                                continue;
                            }

                            // Long-term quota exhaustion or rate limit: mark account and switch
                            const smartBackoffMs = resetMs || calculateSmartBackoff(errorText, resetMs, consecutiveFailures);
                            logger.warn(`[CloudCode] Quota/Capacity exhausted for ${account.email} (${formatDuration(smartBackoffMs)}), rotating account...`);
                            accountManager.markRateLimited(account.email, smartBackoffMs, model);
                            throw new Error(`QUOTA_EXHAUSTED: ${errorText}`);
                        }

                        if (response.status >= 400) {
                            // Check for 503/529 MODEL_CAPACITY_EXHAUSTED - use progressive backoff like 429 capacity
                            // 529 = Site Overloaded (same treatment as 503)
                            if ((response.status === 503 || response.status === 529) && isModelCapacityExhausted(errorText)) {
                                if (capacityRetryCount < cfgMaxCapRetries) {
                                    const tierIndex = Math.min(capacityRetryCount, CAPACITY_BACKOFF_TIERS_MS.length - 1);
                                    const waitMs = CAPACITY_BACKOFF_TIERS_MS[tierIndex];
                                    capacityRetryCount++;
                                    accountManager.incrementConsecutiveFailures(account.email);
                                    logger.info(`[CloudCode] ${response.status} Model capacity exhausted, retry ${capacityRetryCount}/${cfgMaxCapRetries} after ${formatDuration(waitMs)}...`);
                                    await sleep(waitMs);
                                    continue;
                                }
                                logger.warn(`[CloudCode] Max capacity retries (${cfgMaxCapRetries}) exceeded on ${response.status}, switching account`);
                                accountManager.markRateLimited(account.email, BACKOFF_BY_ERROR_TYPE.MODEL_CAPACITY_EXHAUSTED, model);
                                throw new Error(`CAPACITY_EXHAUSTED: ${errorText}`);
                            }

                            // 400 errors are client syntax errors - fail immediately, don't retry or switch accounts
                            // (Only true syntax errors, since quota errors were handled above)
                            if (response.status === 400) {
                                logger.error(`[CloudCode] Invalid request (400): ${errorText.substring(0, 200)}`);
                                throw new Error(`invalid_request_error: ${errorText}`);
                            }

                            // 403 Forbidden / ToS Restriction / Permission Denied
                            if (response.status === 403) {
                                const isBan = isAccountBanned(errorText);
                                const verifyUrl = extractVerificationUrl(errorText);
                                const reason = isBan
                                    ? 'Account suspended / ToS restriction by Google'
                                    : (verifyUrl ? 'Account requires verification (403)' : '403 Forbidden / Permission Denied');

                                logger.error(`[ATC SAFETY SHIELD] 403 Restriction on ${account.email}: ${reason}`);
                                accountManager.markInvalid(account.email, reason, verifyUrl);
                                accountManager.saveToDisk().catch(() => {});

                                // CRITICAL: Halt immediately. Do NOT retry other endpoints or cycle to another account!
                                throw new AccountForbiddenError(
                                    `[ATC SAFETY SHIELD] Account ${account.email} received 403 Forbidden (${reason}). Rotation halted immediately to protect remaining accounts.`,
                                    account.email
                                );
                            }

                            lastError = new Error(`API error ${response.status}: ${errorText}`);
                            if (response.status === 404) {
                                logger.warn(`[CloudCode] ${response.status} at ${endpoint}...`);
                            } else if (response.status >= 500) {
                                logger.warn(`[CloudCode] ${response.status} error, waiting 1s before retry...`);
                                await sleep(1000);
                            }
                            endpointIndex++;
                            continue;
                        }
                    }

                    // For thinking models, parse SSE and accumulate all parts
                    if (isThinking) {
                        const result = await parseThinkingSSEResponse(response, anthropicRequest.model);
                        // Clear rate limit state on success
                        clearRateLimitState(account.email, model);
                        accountManager.notifySuccess(account, model);
                        return result;
                    }

                    // Non-thinking models use regular JSON
                    const data = await response.json();
                    logger.debug('[CloudCode] Response received');
                    // Clear rate limit state on success
                    clearRateLimitState(account.email, model);
                    accountManager.notifySuccess(account, model);
                    return convertGoogleToAnthropic(data, anthropicRequest.model);

                } catch (endpointError) {
                    const msg = (endpointError.message || '').toLowerCase();
                    const isQuotaErr = isRateLimitError(endpointError) ||
                        msg.includes('resource_exhausted') ||
                        msg.includes('quota_exhausted') ||
                        msg.includes('exhausted your capacity') ||
                        msg.includes('quota will reset');

                    if (isQuotaErr) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    // 403 account-level errors - re-throw to trigger account rotation
                    if (isAccountForbiddenError(endpointError)) {
                        throw endpointError;
                    }
                    // 400 errors are client syntax errors - re-throw immediately, don't retry (only true syntax errors)
                    if (endpointError.message?.includes('400') && !isQuotaErr) {
                        throw endpointError;
                    }
                    logger.warn(`[CloudCode] Error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                    endpointIndex++;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                if (lastError.is429) {
                    logger.warn(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                    accountManager.markRateLimited(account.email, lastError.resetMs, model);
                    throw new Error(`Rate limited: ${lastError.errorText}`);
                }
                throw lastError;
            }

        } catch (error) {
            const errLower = (error.message || '').toLowerCase();
            const isRateOrQuota = isRateLimitError(error) ||
                errLower.includes('resource_exhausted') ||
                errLower.includes('quota_exhausted') ||
                errLower.includes('exhausted your capacity') ||
                errLower.includes('quota will reset');

            if (isRateOrQuota) {
                accountManager.notifyRateLimit(account, model);
                const resetMs = parseResetTime(null, error.message) || 60000;
                accountManager.markRateLimited(account.email, resetMs, model);

                if (singleLock || attempt + 1 >= maxAttempts) {
                    throw new Error(
                        `RESOURCE_EXHAUSTED: Rate limited on ${model}. Quota will reset after ${formatDuration(resetMs)}.`
                    );
                }

                const switchDelay = getSwitchDelayWithJitter();
                logger.info(`[CloudCode] Account ${account.email} quota/rate-limited, cooling ${switchDelay}ms before switching account...`);
                if (switchDelay > 0) await sleep(switchDelay);

                if (error.message?.includes('RATE_LIMITED_DEDUP')) {
                    attempt--;
                }
                continue;
            }
            if (isAuthError(error)) {
                if (singleLock) throw error;
                logger.warn(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                const switchDelay = getSwitchDelayWithJitter();
                if (switchDelay > 0) await sleep(switchDelay);
                continue;
            }
            if (isAccountForbiddenError(error)) {
                // Fail closed: Stop immediately, do NOT cycle through remaining accounts!
                logger.error(`[ATC SAFETY SHIELD] Circuit breaker triggered for ${account.email}. Aborting request without rotating.`);
                throw error;
            }
            // Handle 5xx errors
            if (error.message.includes('API error 5') || error.message.includes('500') || error.message.includes('503')) {
                accountManager.notifyFailure(account, model);

                // Track 5xx errors for extended cooldown
                // Note: markRateLimited already increments consecutiveFailures internally
                const currentFailures = accountManager.getConsecutiveFailures(account.email);
                if (currentFailures + 1 >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(`[CloudCode] Account ${account.email} has ${currentFailures + 1} consecutive failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`);
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    accountManager.incrementConsecutiveFailures(account.email);
                    logger.warn(`[CloudCode] Account ${account.email} failed with 5xx error (${currentFailures + 1}/${MAX_CONSECUTIVE_FAILURES}), trying next...`);
                }
                continue;
            }

            if (isNetworkError(error)) {
                accountManager.notifyFailure(account, model);

                // Track network errors for extended cooldown
                // Note: markRateLimited already increments consecutiveFailures internally
                const currentFailures = accountManager.getConsecutiveFailures(account.email);
                if (currentFailures + 1 >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(`[CloudCode] Account ${account.email} has ${currentFailures + 1} consecutive network failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`);
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    accountManager.incrementConsecutiveFailures(account.email);
                    logger.warn(`[CloudCode] Network error for ${account.email} (${currentFailures + 1}/${MAX_CONSECUTIVE_FAILURES}), trying next account... (${error.message})`);
                }
                await sleep(1000);
                continue;
            }

            throw error;
        }
    }

    // All retries exhausted - try fallback model if enabled
    if (fallbackEnabled) {
        const fallbackModel = getFallbackModel(model);
        if (fallbackModel) {
            logger.warn(`[CloudCode] All retries exhausted for ${model}. Attempting fallback to ${fallbackModel}`);
            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
            return await sendMessage(fallbackRequest, accountManager, false, onAccountSelected);
        }
    }

    throw new Error('Max retries exceeded');
}

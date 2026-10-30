/**
 * Pipelined 5% Quota Rotation Strategy
 *
 * Implements Staggered Quota Scheduling:
 * Instead of draining an account until 100% quota exhaustion (which causes a painful 5-hour outage),
 * this strategy rotates active accounts every ~5% of quota consumption (or ~20 requests).
 *
 * This staggers the 5-hour recovery windows across all available accounts in parallel:
 *   Account 1: uses 5% -> starts 5h recovery window -> proxy switches to Account 2
 *   Account 2: uses 5% -> starts 5h recovery window -> proxy switches to Account 3
 *   ...
 *   Account N: by the time rotation completes, Account 1 has already recovered substantial quota!
 */

import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class PipelinedStrategy extends BaseStrategy {
    #stepStates = new Map(); // email -> { startFraction, requestCount, lastRotatedAt }
    #cursor = 0;
    #stepThreshold = 0.05; // 5% quota threshold
    #requestThreshold = 20; // 20 requests threshold if live quota is delayed

    /**
     * @param {Object} config
     * @param {number} [config.stepThreshold=0.05]
     * @param {number} [config.requestThreshold=20]
     */
    constructor(config = {}) {
        super(config);
        if (typeof config.stepThreshold === 'number' && config.stepThreshold > 0) {
            this.#stepThreshold = config.stepThreshold;
        }
        if (typeof config.requestThreshold === 'number' && config.requestThreshold > 0) {
            this.#requestThreshold = config.requestThreshold;
        }
    }

    /**
     * Select account with pipelined 5% quota rotation
     */
    selectAccount(accounts, modelId, options = {}) {
        const { currentIndex = 0, onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        let idx = currentIndex >= accounts.length ? 0 : currentIndex;
        let currentAccount = accounts[idx];

        // 1. Check if current account is usable
        const isCurrentUsable = this.isAccountUsable(currentAccount, modelId);

        // 2. Check if current account has finished its 5% quota step
        let shouldRotate = false;
        if (isCurrentUsable) {
            const state = this.#getOrCreateState(currentAccount, modelId);
            const currentFraction = this.#getQuotaFraction(currentAccount, modelId);

            if (state.startFraction !== null && currentFraction !== null) {
                const consumed = state.startFraction - currentFraction;
                if (consumed >= this.#stepThreshold) {
                    logger.info(`[Pipelined] Account ${currentAccount.email} consumed ${(consumed * 100).toFixed(1)}% quota (>= ${(this.#stepThreshold * 100)}%). Rotating to pipeline 5h recovery.`);
                    shouldRotate = true;
                }
            } else if (state.requestCount >= this.#requestThreshold) {
                logger.info(`[Pipelined] Account ${currentAccount.email} completed ${state.requestCount} requests step. Rotating to stagger cooldown.`);
                shouldRotate = true;
            }
        } else {
            shouldRotate = true;
        }

        // 3. If rotation is triggered, select next usable account in pool
        if (shouldRotate || !isCurrentUsable) {
            const nextResult = this.#pickNextUsable(accounts, idx, modelId);
            if (nextResult.account) {
                currentAccount = nextResult.account;
                idx = nextResult.index;
                // Reset step state for the new account
                this.#resetState(currentAccount, modelId);
            }
        }

        if (currentAccount && this.isAccountUsable(currentAccount, modelId)) {
            currentAccount.lastUsed = Date.now();
            this.#cursor = idx;
            if (onSave) onSave();
            return { account: currentAccount, index: idx, waitMs: 0 };
        }

        return { account: null, index: idx, waitMs: 0 };
    }

    onSuccess(account, modelId) {
        if (!account?.email) return;
        const state = this.#stepStates.get(account.email);
        if (state) {
            state.requestCount++;
        }
    }

    onRateLimit(account, modelId) {
        if (!account?.email) return;
        this.#stepStates.delete(account.email);
    }

    #getOrCreateState(account, modelId) {
        let state = this.#stepStates.get(account.email);
        if (!state) {
            state = {
                startFraction: this.#getQuotaFraction(account, modelId),
                requestCount: 0,
                lastRotatedAt: Date.now()
            };
            this.#stepStates.set(account.email, state);
        }
        return state;
    }

    #resetState(account, modelId) {
        this.#stepStates.set(account.email, {
            startFraction: this.#getQuotaFraction(account, modelId),
            requestCount: 0,
            lastRotatedAt: Date.now()
        });
    }

    #getQuotaFraction(account, modelId) {
        const models = account.quota?.models || {};
        const q = models[modelId] || models['gemini-3.8-flash-high'] || Object.values(models)[0];
        if (q && typeof q.remainingFraction === 'number') {
            return q.remainingFraction;
        }
        return null;
    }

    #pickNextUsable(accounts, fromIndex, modelId) {
        for (let i = 1; i <= accounts.length; i++) {
            const targetIdx = (fromIndex + i) % accounts.length;
            const acc = accounts[targetIdx];
            if (this.isAccountUsable(acc, modelId)) {
                return { account: acc, index: targetIdx };
            }
        }
        return { account: null, index: fromIndex };
    }
}

export default PipelinedStrategy;

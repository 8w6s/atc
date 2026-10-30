import { BaseStrategy } from './base-strategy.js';
import { config as globalConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';

/*
 * Stagger 5-hour quota recovery across accounts while enforcing a minimum stay
 * floor (+0..20% random jitter) on healthy accounts. Without a time floor,
 * parallel subagent bursts can cycle through all consumer accounts in under a
 * minute from one IP. Rate-limited, invalid, or critically low (<20%) accounts
 * still fail over immediately.
 */
export class PipelinedStrategy extends BaseStrategy {
    #stepStates = new Map();
    #cursor = 0;
    #stepThreshold = 0.05;
    #requestThreshold = 20;
    #minStaySec = 180;
    #lowQuotaBypass = 0.20;

    /**
     * @param {Object} config
     * @param {number} [config.stepThreshold=0.05]
     * @param {number} [config.requestThreshold=20]
     * @param {number} [config.minStaySec=180]
     */
    constructor(config = {}) {
        super(config);
        if (typeof config.stepThreshold === 'number' && config.stepThreshold > 0) {
            this.#stepThreshold = config.stepThreshold;
        }
        if (typeof config.requestThreshold === 'number' && config.requestThreshold > 0) {
            this.#requestThreshold = config.requestThreshold;
        }
        if (typeof config.minStaySec === 'number' && config.minStaySec >= 0) {
            this.#minStaySec = config.minStaySec;
        }
    }

    selectAccount(accounts, modelId, options = {}) {
        const { currentIndex = 0, onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        let idx = currentIndex >= accounts.length ? 0 : currentIndex;
        let currentAccount = accounts[idx];

        const isCurrentUsable = this.isAccountUsable(currentAccount, modelId);

        let shouldRotate = false;
        if (isCurrentUsable) {
            const floorBypass = Math.max(this.#lowQuotaBypass, (Number(globalConfig?.globalQuotaThreshold) || 0) + 0.05);
            const state = this.#getOrCreateState(currentAccount, modelId);
            const currentFraction = this.#getQuotaFraction(currentAccount, modelId);
            const elapsedMs = Date.now() - state.lastRotatedAt;
            const isLowQuota = currentFraction !== null && currentFraction < floorBypass;
            const staySatisfied = elapsedMs >= state.minStayMs || isLowQuota;

            if (staySatisfied) {
                if (state.startFraction !== null && currentFraction !== null) {
                    const consumed = state.startFraction - currentFraction;
                    if (consumed >= this.#stepThreshold) {
                        logger.info(`[Pipelined] Account ${currentAccount.email} consumed ${(consumed * 100).toFixed(1)}% quota after ${Math.round(elapsedMs / 1000)}s. Rotating to stagger 5h recovery.`);
                        shouldRotate = true;
                    }
                } else if (state.requestCount >= this.#requestThreshold) {
                    logger.info(`[Pipelined] Account ${currentAccount.email} completed ${state.requestCount} requests after ${Math.round(elapsedMs / 1000)}s. Rotating to stagger cooldown.`);
                    shouldRotate = true;
                }
            }
        } else {
            shouldRotate = true;
        }

        if (shouldRotate || !isCurrentUsable) {
            const nextResult = this.#pickNextUsable(accounts, idx, modelId);
            if (nextResult.account) {
                currentAccount = nextResult.account;
                idx = nextResult.index;
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

    onSuccess(account) {
        if (!account?.email) return;
        const state = this.#stepStates.get(account.email);
        if (state) {
            state.requestCount++;
        }
    }

    onRateLimit(account) {
        if (!account?.email) return;
        this.#stepStates.delete(account.email);
    }

    #computeJitteredStayMs() {
        if (this.#minStaySec <= 0) return 0;
        return Math.round(this.#minStaySec * 1000 * (1 + Math.random() * 0.2));
    }

    #getOrCreateState(account, modelId) {
        let state = this.#stepStates.get(account.email);
        if (!state) {
            state = {
                startFraction: this.#getQuotaFraction(account, modelId),
                requestCount: 0,
                lastRotatedAt: Date.now(),
                minStayMs: this.#computeJitteredStayMs()
            };
            this.#stepStates.set(account.email, state);
        }
        return state;
    }

    #resetState(account, modelId) {
        this.#stepStates.set(account.email, {
            startFraction: this.#getQuotaFraction(account, modelId),
            requestCount: 0,
            lastRotatedAt: Date.now(),
            minStayMs: this.#computeJitteredStayMs()
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

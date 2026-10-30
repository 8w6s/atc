import { BaseStrategy } from './base-strategy.js';
import { MAX_WAIT_BEFORE_ERROR_MS } from '../../constants.js';

/*
 * Hard-pin all traffic to the currently active account index without ever
 * failing over to sibling accounts. Eliminates multi-account hopping signals
 * on consumer plans and matches Single-Account Lock behavior.
 */
export class LockedStrategy extends BaseStrategy {
    constructor(config = {}) {
        super(config);
    }

    selectAccount(accounts, modelId, options = {}) {
        const { currentIndex = 0, onSave } = options;
        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        const idx = currentIndex >= accounts.length ? 0 : currentIndex;
        const locked = accounts[idx];
        if (!locked) {
            return { account: null, index: idx, waitMs: 0 };
        }

        if (this.isAccountUsable(locked, modelId)) {
            locked.lastUsed = Date.now();
            if (onSave) onSave();
            return { account: locked, index: idx, waitMs: 0 };
        }

        const limit = modelId ? locked.modelRateLimits?.[modelId] : null;
        if (!locked.isInvalid && locked.enabled !== false && limit?.isRateLimited && limit.resetTime) {
            const waitMs = limit.resetTime - Date.now();
            if (waitMs > 0 && waitMs <= MAX_WAIT_BEFORE_ERROR_MS) {
                return { account: null, index: idx, waitMs };
            }
        }

        return { account: null, index: idx, waitMs: 0 };
    }
}

export default LockedStrategy;

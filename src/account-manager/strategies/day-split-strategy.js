import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

/*
 * Minimize daily IP-to-account fan-out: elect at most one Primary and one
 * Standby account per calendar day, keeping all other configured accounts
 * completely dormant (zero traffic) unless both daily slots fail.
 */
export class DaySplitStrategy extends BaseStrategy {
    #dayKey = '';
    #primaryEmail = null;
    #standbyEmail = null;

    constructor(config = {}) {
        super(config);
    }

    #todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    #getQuotaFraction(account, modelId) {
        const models = account?.quota?.models || {};
        const q = (modelId && models[modelId]) || models['gemini-3.8-flash-high'] || Object.values(models)[0];
        return typeof q?.remainingFraction === 'number' ? q.remainingFraction : 0.5;
    }

    #electDailyPair(accounts, preferredIdx, modelId) {
        this.#dayKey = this.#todayKey();
        const usable = accounts
            .map((acc, index) => ({ acc, index, frac: this.#getQuotaFraction(acc, modelId) }))
            .filter((item) => this.isAccountUsable(item.acc, modelId));

        if (usable.length === 0) {
            this.#primaryEmail = null;
            this.#standbyEmail = null;
            return;
        }

        const preferred = usable.find((u) => u.index === preferredIdx);
        const sorted = [...usable].sort((a, b) => b.frac - a.frac);
        const primary = preferred || sorted[0];
        const standby = sorted.find((u) => u.acc.email !== primary.acc.email) || null;

        this.#primaryEmail = primary.acc.email;
        this.#standbyEmail = standby ? standby.acc.email : null;
    }

    selectAccount(accounts, modelId, options = {}) {
        const { currentIndex = 0, onSave } = options;
        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        const idx = currentIndex >= accounts.length ? 0 : currentIndex;
        const today = this.#todayKey();
        if (this.#dayKey !== today || !this.#primaryEmail) {
            this.#electDailyPair(accounts, idx, modelId);
        }

        const findByEmail = (email) => {
            if (!email) return null;
            const i = accounts.findIndex((a) => a.email === email);
            return i >= 0 ? { account: accounts[i], index: i } : null;
        };

        const primarySlot = findByEmail(this.#primaryEmail);
        if (primarySlot && this.isAccountUsable(primarySlot.account, modelId)) {
            primarySlot.account.lastUsed = Date.now();
            if (onSave) onSave();
            return { account: primarySlot.account, index: primarySlot.index, waitMs: 0 };
        }

        const standbySlot = findByEmail(this.#standbyEmail);
        if (standbySlot && this.isAccountUsable(standbySlot.account, modelId)) {
            standbySlot.account.lastUsed = Date.now();
            if (onSave) onSave();
            return { account: standbySlot.account, index: standbySlot.index, waitMs: 0 };
        }

        /* Both daily slots exhausted — elect a fresh fallback pair */
        this.#electDailyPair(accounts, idx, modelId);
        const emergencySlot = findByEmail(this.#primaryEmail);
        if (emergencySlot && this.isAccountUsable(emergencySlot.account, modelId)) {
            logger.info(`[DaySplitStrategy] Both daily slots depleted; promoted fallback ${emergencySlot.account.email}`);
            emergencySlot.account.lastUsed = Date.now();
            if (onSave) onSave();
            return { account: emergencySlot.account, index: emergencySlot.index, waitMs: 0 };
        }

        return { account: null, index: idx, waitMs: 0 };
    }
}

export default DaySplitStrategy;

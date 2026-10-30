import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

/*
 * Split each calendar day into two fixed 12-hour shifts (00:00-11:59 AM slot
 * and 12:00-23:59 PM slot). At most two accounts receive traffic on any given
 * day with a single deterministic midday handover instead of back-and-forth
 * ping-pong switching.
 */
export class ShiftSplitStrategy extends BaseStrategy {
    #dayKey = '';
    #amEmail = null;
    #pmEmail = null;

    constructor(config = {}) {
        super(config);
    }

    #todayKey(now = new Date()) {
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    #getQuotaFraction(account, modelId) {
        const models = account?.quota?.models || {};
        const q = (modelId && models[modelId]) || models['gemini-3.8-flash-high'] || Object.values(models)[0];
        return typeof q?.remainingFraction === 'number' ? q.remainingFraction : 0.5;
    }

    #electShiftSlots(accounts, preferredIdx, modelId, nowDate) {
        this.#dayKey = this.#todayKey(nowDate);
        const usable = accounts
            .map((acc, index) => ({ acc, index, frac: this.#getQuotaFraction(acc, modelId) }))
            .filter((item) => this.isAccountUsable(item.acc, modelId));

        if (usable.length === 0) {
            this.#amEmail = null;
            this.#pmEmail = null;
            return;
        }

        const preferred = usable.find((u) => u.index === preferredIdx);
        const sorted = [...usable].sort((a, b) => b.frac - a.frac);
        const first = preferred || sorted[0];
        const second = sorted.find((u) => u.acc.email !== first.acc.email) || first;

        this.#amEmail = first.acc.email;
        this.#pmEmail = second.acc.email;
    }

    selectAccount(accounts, modelId, options = {}) {
        const { currentIndex = 0, onSave } = options;
        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        const nowDate = new Date();
        const today = this.#todayKey(nowDate);
        const idx = currentIndex >= accounts.length ? 0 : currentIndex;

        if (this.#dayKey !== today || !this.#amEmail) {
            this.#electShiftSlots(accounts, idx, modelId, nowDate);
        }

        const isAfternoon = nowDate.getHours() >= 12;
        const primaryShiftEmail = isAfternoon ? this.#pmEmail : this.#amEmail;
        const backupShiftEmail = isAfternoon ? this.#amEmail : this.#pmEmail;

        const resolveSlot = (email) => {
            if (!email) return null;
            const i = accounts.findIndex((a) => a.email === email);
            return i >= 0 ? { account: accounts[i], index: i } : null;
        };

        const activeSlot = resolveSlot(primaryShiftEmail);
        if (activeSlot && this.isAccountUsable(activeSlot.account, modelId)) {
            activeSlot.account.lastUsed = Date.now();
            if (onSave) onSave();
            return { account: activeSlot.account, index: activeSlot.index, waitMs: 0 };
        }

        const backupSlot = resolveSlot(backupShiftEmail);
        if (backupSlot && this.isAccountUsable(backupSlot.account, modelId)) {
            backupSlot.account.lastUsed = Date.now();
            if (onSave) onSave();
            return { account: backupSlot.account, index: backupSlot.index, waitMs: 0 };
        }

        this.#electShiftSlots(accounts, idx, modelId, nowDate);
        const emergency = resolveSlot(isAfternoon ? this.#pmEmail : this.#amEmail);
        if (emergency && this.isAccountUsable(emergency.account, modelId)) {
            logger.info(`[ShiftSplitStrategy] Both shift slots exhausted; promoted ${emergency.account.email}`);
            emergency.account.lastUsed = Date.now();
            if (onSave) onSave();
            return { account: emergency.account, index: emergency.index, waitMs: 0 };
        }

        return { account: null, index: idx, waitMs: 0 };
    }
}

export default ShiftSplitStrategy;

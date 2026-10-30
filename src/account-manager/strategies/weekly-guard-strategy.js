import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

const MIN_STAY_WEEKLY_MS = 15 * 60 * 1000;
const WEEKLY_RESERVE_FLOOR = 0.20;
const WEEKLY_STEP_DROP = 0.10;

/*
 * Protect scarce weekly model caps (Gemini 4 Argon / Opus overrides) across
 * independent accounts: bind to the account with the highest remaining weekly
 * fraction for at least 15 minutes and hand off cleanly before any single
 * account burns below a 20% weekly reserve.
 */
export class WeeklyGuardStrategy extends BaseStrategy {
    #boundEmail = null;
    #boundSince = 0;
    #startWeeklyFrac = null;

    constructor(config = {}) {
        super(config);
    }

    #getWeeklyFraction(account) {
        const models = account?.quota?.models;
        if (!models || typeof models !== 'object') return null;
        const now = Date.now();
        let lowest = null;
        for (const [mId, info] of Object.entries(models)) {
            if (!info || typeof info.remainingFraction !== 'number') continue;
            const resetMs = info.resetTime ? Math.max(0, new Date(info.resetTime).getTime() - now) : 0;
            const isWeekly = resetMs > 24 * 3600 * 1000 || mId.toLowerCase().includes('argon') || mId.toLowerCase().includes('weekly');
            if (isWeekly && (lowest === null || info.remainingFraction < lowest)) {
                lowest = info.remainingFraction;
            }
        }
        return lowest;
    }

    #getFiveHourFraction(account, modelId) {
        const models = account?.quota?.models || {};
        const q = (modelId && models[modelId]) || models['gemini-3.8-flash-high'] || Object.values(models)[0];
        return typeof q?.remainingFraction === 'number' ? q.remainingFraction : 0.5;
    }

    #pickBestWeeklyCandidate(accounts, excludeIndex, modelId) {
        let bestIdx = -1;
        let bestScore = -1;
        for (let i = 0; i < accounts.length; i++) {
            if (i === excludeIndex) continue;
            const acc = accounts[i];
            if (!this.isAccountUsable(acc, modelId)) continue;
            const weekly = this.#getWeeklyFraction(acc) ?? 0.8;
            const five = this.#getFiveHourFraction(acc, modelId);
            const score = weekly * 100 + five * 20;
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }
        return bestIdx >= 0 ? { account: accounts[bestIdx], index: bestIdx } : null;
    }

    selectAccount(accounts, modelId, options = {}) {
        const { currentIndex = 0, onSave } = options;
        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        const now = Date.now();
        let idx = currentIndex >= accounts.length ? 0 : currentIndex;
        let current = accounts[idx];

        if (!this.#boundEmail || this.#boundEmail !== current?.email) {
            this.#boundEmail = current?.email || null;
            this.#boundSince = now;
            this.#startWeeklyFrac = this.#getWeeklyFraction(current);
        }

        const usable = this.isAccountUsable(current, modelId);
        const curWeekly = this.#getWeeklyFraction(current);
        const stayElapsed = now - this.#boundSince;
        const droppedWeekly = (this.#startWeeklyFrac !== null && curWeekly !== null)
            ? (this.#startWeeklyFrac - curWeekly)
            : 0;

        const belowReserve = curWeekly !== null && curWeekly <= WEEKLY_RESERVE_FLOOR;
        const stepReady = stayElapsed >= MIN_STAY_WEEKLY_MS && droppedWeekly >= WEEKLY_STEP_DROP;

        if (!usable || belowReserve || stepReady) {
            const next = this.#pickBestWeeklyCandidate(accounts, idx, modelId);
            if (next) {
                const nextWeekly = this.#getWeeklyFraction(next.account);
                if (!usable || nextWeekly === null || curWeekly === null || nextWeekly > curWeekly) {
                    logger.info(`[WeeklyGuardStrategy] Handover -> ${next.account.email} (weekly=${nextWeekly !== null ? Math.round(nextWeekly * 100) + '%' : 'n/a'})`);
                    current = next.account;
                    idx = next.index;
                    this.#boundEmail = current.email;
                    this.#boundSince = now;
                    this.#startWeeklyFrac = nextWeekly;
                }
            }
        }

        if (current && this.isAccountUsable(current, modelId)) {
            current.lastUsed = now;
            if (onSave) onSave();
            return { account: current, index: idx, waitMs: 0 };
        }

        return { account: null, index: idx, waitMs: 0 };
    }
}

export default WeeklyGuardStrategy;

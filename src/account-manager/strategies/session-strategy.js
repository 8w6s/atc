import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_SESSION_MIN_MS = 45 * 60 * 1000; // 45 minutes natural work block
const DEFAULT_IDLE_HANDOVER_MS = 3 * 60 * 1000; // 3 minutes quiet gap between turns
const EMERGENCY_QUOTA_FLOOR = 0.15;

/*
 * Mimic natural single-developer session boundaries: never switch accounts in
 * the middle of an active tool-call loop. A proactive shift happens only after
 * both a full coding block (~45m + jitter) AND a natural idle pause (>=3m)
 * between prompts, unless the active account becomes unusable or drops below
 * emergency quota (<15%).
 */
export class SessionStrategy extends BaseStrategy {
    #sessionStartAt = 0;
    #targetDurationMs = DEFAULT_SESSION_MIN_MS;
    #lastRequestAt = 0;
    #boundEmail = null;

    constructor(config = {}) {
        super(config);
        this.#rollSessionDuration();
    }

    #rollSessionDuration() {
        this.#targetDurationMs = Math.round(DEFAULT_SESSION_MIN_MS * (0.9 + Math.random() * 0.25));
    }

    #getQuotaFraction(account, modelId) {
        const models = account?.quota?.models || {};
        const q = (modelId && models[modelId]) || models['gemini-3.8-flash-high'] || Object.values(models)[0];
        return typeof q?.remainingFraction === 'number' ? q.remainingFraction : null;
    }

    #pickHealthiestOther(accounts, excludeIndex, modelId) {
        let bestIdx = -1;
        let bestFrac = -1;
        for (let i = 0; i < accounts.length; i++) {
            if (i === excludeIndex) continue;
            const acc = accounts[i];
            if (!this.isAccountUsable(acc, modelId)) continue;
            const frac = this.#getQuotaFraction(acc, modelId) ?? 0.5;
            if (frac > bestFrac) {
                bestFrac = frac;
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
            this.#sessionStartAt = now;
            this.#rollSessionDuration();
        }

        const usable = this.isAccountUsable(current, modelId);
        const quotaFrac = this.#getQuotaFraction(current, modelId);
        const isEmergencyLow = quotaFrac !== null && quotaFrac < EMERGENCY_QUOTA_FLOOR;
        const idleGapMs = this.#lastRequestAt > 0 ? (now - this.#lastRequestAt) : 0;
        const sessionElapsedMs = now - this.#sessionStartAt;

        const naturalBreakReady =
            sessionElapsedMs >= this.#targetDurationMs &&
            idleGapMs >= DEFAULT_IDLE_HANDOVER_MS;

        if (!usable || isEmergencyLow || naturalBreakReady) {
            const candidate = this.#pickHealthiestOther(accounts, idx, modelId);
            if (candidate) {
                const reason = !usable ? 'unavailable' : (isEmergencyLow ? 'low-quota' : 'idle-session-break');
                logger.info(`[SessionStrategy] Handover (${reason}) -> ${candidate.account.email}`);
                current = candidate.account;
                idx = candidate.index;
                this.#boundEmail = current.email;
                this.#sessionStartAt = now;
                this.#rollSessionDuration();
            }
        }

        if (current && this.isAccountUsable(current, modelId)) {
            current.lastUsed = now;
            this.#lastRequestAt = now;
            if (onSave) onSave();
            return { account: current, index: idx, waitMs: 0 };
        }

        return { account: null, index: idx, waitMs: 0 };
    }
}

export default SessionStrategy;

import { BaseStrategy } from './base-strategy.js';

const WARMUP_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours since account added
const WARMUP_DRIP_CAP = 5;                  // Max 5 requests per 45m window on fresh clones
const WARMUP_COOLDOWN_MS = 45 * 60 * 1000;
const SEASONED_MIN_STAY_MS = 10 * 60 * 1000;

/*
 * Shield newly linked clones (<48h old) from immediate high-velocity coding
 * bursts that often trigger 403 VALIDATION_REQUIRED checks: fresh clones
 * receive only light warm-up drips while seasoned accounts absorb main load.
 */
export class WarmupStrategy extends BaseStrategy {
    #dripState = new Map(); // email -> { count, windowStart }
    #boundSeasonedEmail = null;
    #boundSince = 0;

    constructor(config = {}) {
        super(config);
    }

    #isFreshAccount(account, now) {
        const added = account?.addedAt ? new Date(account.addedAt).getTime() : 0;
        if (!added || Number.isNaN(added)) return false;
        return (now - added) < WARMUP_AGE_MS;
    }

    #canUseFreshDrip(account, now) {
        const key = account.email;
        const st = this.#dripState.get(key);
        if (!st || (now - st.windowStart) >= WARMUP_COOLDOWN_MS) {
            return true;
        }
        return st.count < WARMUP_DRIP_CAP;
    }

    #recordFreshDrip(account, now) {
        const key = account.email;
        const st = this.#dripState.get(key);
        if (!st || (now - st.windowStart) >= WARMUP_COOLDOWN_MS) {
            this.#dripState.set(key, { count: 1, windowStart: now });
        } else {
            st.count += 1;
        }
    }

    selectAccount(accounts, modelId, options = {}) {
        const { currentIndex = 0, onSave } = options;
        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        const now = Date.now();
        const usable = accounts
            .map((account, index) => ({ account, index, fresh: this.#isFreshAccount(account, now) }))
            .filter((item) => this.isAccountUsable(item.account, modelId));

        if (usable.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        const seasoned = usable.filter((u) => !u.fresh);
        const freshReady = usable.filter((u) => u.fresh && this.#canUseFreshDrip(u.account, now));

        /* Prefer staying on the active seasoned account for >=10m blocks */
        if (seasoned.length > 0) {
            const currentSeasoned = seasoned.find((s) => s.account.email === this.#boundSeasonedEmail);
            if (currentSeasoned && (now - this.#boundSince) < SEASONED_MIN_STAY_MS) {
                currentSeasoned.account.lastUsed = now;
                if (onSave) onSave();
                return { account: currentSeasoned.account, index: currentSeasoned.index, waitMs: 0 };
            }

            /* Opportunistically send 1 gentle warm-up drip if a fresh clone is idle and ready */
            if (freshReady.length > 0 && (!currentSeasoned || (now - this.#boundSince) >= SEASONED_MIN_STAY_MS)) {
                const drip = freshReady[0];
                this.#recordFreshDrip(drip.account, now);
                drip.account.lastUsed = now;
                if (onSave) onSave();
                return { account: drip.account, index: drip.index, waitMs: 0 };
            }

            const chosen = currentSeasoned || seasoned[0];
            this.#boundSeasonedEmail = chosen.account.email;
            this.#boundSince = now;
            chosen.account.lastUsed = now;
            if (onSave) onSave();
            return { account: chosen.account, index: chosen.index, waitMs: 0 };
        }

        /* Pool consists exclusively of fresh accounts */
        const fallback = freshReady[0] || usable[0];
        if (fallback.fresh) this.#recordFreshDrip(fallback.account, now);
        fallback.account.lastUsed = now;
        if (onSave) onSave();
        return { account: fallback.account, index: fallback.index, waitMs: 0 };
    }
}

export default WarmupStrategy;

import { BaseStrategy } from './base-strategy.js';
import { MAX_WAIT_BEFORE_ERROR_MS } from '../../constants.js';
import { logger } from '../../utils/logger.js';

export const CUSTOM_BASE_CORES = ['locked', 'day-slots', 'session-idle', 'sticky-floor', 'quota-step'];
export const CUSTOM_CANDIDATE_ORDERS = ['highest-5h', 'highest-weekly', 'lru', 'sequential'];
export const CUSTOM_UNAVAILABLE_POLICIES = ['failover', 'wait'];

export function slugifyProfileId(name) {
    const clean = String(name || 'custom')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 28);
    return clean || 'custom-profile';
}

export function normalizeCustomProfile(raw = {}) {
    const name = String(raw.name || 'Custom Safe Profile').trim().slice(0, 32) || 'Custom Safe Profile';
    const id = slugifyProfileId(raw.id || name);
    const baseCore = CUSTOM_BASE_CORES.includes(raw.baseCore) ? raw.baseCore : 'day-slots';
    const maxDailyAccounts = Math.max(0, Math.min(10, Number.isFinite(Number(raw.maxDailyAccounts)) ? Math.round(Number(raw.maxDailyAccounts)) : 2));
    const requireIdleGap = raw.requireIdleGap !== undefined ? Boolean(raw.requireIdleGap) : true;
    const minIdleSec = Math.max(0, Math.min(3600, Number.isFinite(Number(raw.minIdleSec)) ? Math.round(Number(raw.minIdleSec)) : 180));
    const minStaySec = Math.max(0, Math.min(7200, Number.isFinite(Number(raw.minStaySec)) ? Math.round(Number(raw.minStaySec)) : 600));
    const quotaStepPct = Math.max(0, Math.min(80, Number.isFinite(Number(raw.quotaStepPct)) ? Math.round(Number(raw.quotaStepPct)) : 10));
    const floor5hPct = Math.max(0, Math.min(50, Number.isFinite(Number(raw.floor5hPct)) ? Math.round(Number(raw.floor5hPct)) : 15));
    const floorWeeklyPct = Math.max(0, Math.min(50, Number.isFinite(Number(raw.floorWeeklyPct)) ? Math.round(Number(raw.floorWeeklyPct)) : 15));
    const candidateOrder = CUSTOM_CANDIDATE_ORDERS.includes(raw.candidateOrder) ? raw.candidateOrder : 'highest-5h';
    const onUnavailable = CUSTOM_UNAVAILABLE_POLICIES.includes(raw.onUnavailable) ? raw.onUnavailable : 'failover';

    return {
        id,
        name,
        baseCore,
        maxDailyAccounts,
        requireIdleGap,
        minIdleSec,
        minStaySec,
        quotaStepPct,
        floor5hPct,
        floorWeeklyPct,
        candidateOrder,
        onUnavailable
    };
}

/*
 * Score a user-authored profile's anti-ban posture directly from its concrete
 * parameters so the TUI and Load Balancer selector always show an honest risk
 * badge ([safest] through [high-risk]) alongside custom profiles.
 */
export function evaluateCustomProfileRisk(rawProfile = {}) {
    const p = normalizeCustomProfile(rawProfile);

    if (p.baseCore === 'locked' || p.maxDailyAccounts === 1 || p.onUnavailable === 'wait') {
        return {
            riskTag: 'safest',
            riskColor: '\x1b[1;38;5;49m',
            summary: 'Single-account isolation or wait-in-place policy; zero automatic multi-account hopping'
        };
    }

    if (
        (p.maxDailyAccounts > 0 && p.maxDailyAccounts <= 2 && (p.minStaySec >= 300 || (p.requireIdleGap && p.minIdleSec >= 120))) ||
        (p.minStaySec >= 600 && p.requireIdleGap && p.minIdleSec >= 120)
    ) {
        return {
            riskTag: 'low-risk',
            riskColor: '\x1b[38;5;120m',
            summary: `Capped daily exposure (${p.maxDailyAccounts || 'all'}/day) with natural stay (${p.minStaySec}s) & idle handover`
        };
    }

    if (p.minStaySec < 60 && !p.requireIdleGap && p.quotaStepPct > 0 && p.quotaStepPct <= 3) {
        return {
            riskTag: 'high-risk',
            riskColor: '\x1b[1;38;5;196m',
            summary: 'Aggressive sub-minute switching on tiny quota steps creates rapid multi-account bursts'
        };
    }

    if (p.minStaySec < 120 && !p.requireIdleGap) {
        return {
            riskTag: 'elevated',
            riskColor: '\x1b[38;5;208m',
            summary: 'Short stay window without idle-gap guard can switch mid-conversation under heavy load'
        };
    }

    return {
        riskTag: 'moderate',
        riskColor: '\x1b[38;5;220m',
        summary: `Controlled rotation (stay >=${p.minStaySec}s, step ${p.quotaStepPct || 'drain'}%, floor ${p.floor5hPct}%/${p.floorWeeklyPct}%)`
    };
}

export class CustomStrategy extends BaseStrategy {
    #profile;
    #dayKey = '';
    #dailyAllowed = new Set();
    #boundEmail = null;
    #boundSince = 0;
    #startFiveFrac = null;
    #lastRequestAt = 0;

    constructor(profile = {}, strategyConfig = {}) {
        super(strategyConfig);
        this.#profile = normalizeCustomProfile(profile);
    }

    getProfile() {
        return this.#profile;
    }

    #todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    #getFiveFrac(account, modelId) {
        const models = account?.quota?.models;
        if (!models || typeof models !== 'object') return null;
        const q = (modelId && models[modelId]) || models['gemini-3.8-flash-high'] || Object.values(models)[0];
        return typeof q?.remainingFraction === 'number' ? q.remainingFraction : null;
    }

    #getWeeklyFrac(account) {
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

    #sortCandidates(candidates, modelId, currentIndex) {
        const order = this.#profile.candidateOrder;
        const copy = [...candidates];
        if (order === 'highest-5h') {
            copy.sort((a, b) => (this.#getFiveFrac(b.account, modelId) ?? 0.5) - (this.#getFiveFrac(a.account, modelId) ?? 0.5));
        } else if (order === 'highest-weekly') {
            copy.sort((a, b) => (this.#getWeeklyFrac(b.account) ?? 0.8) - (this.#getWeeklyFrac(a.account) ?? 0.8));
        } else if (order === 'lru') {
            copy.sort((a, b) => (a.account.lastUsed || 0) - (b.account.lastUsed || 0));
        } else {
            copy.sort((a, b) => {
                const da = (a.index - currentIndex + 1000) % 1000;
                const db = (b.index - currentIndex + 1000) % 1000;
                return da - db;
            });
        }
        return copy;
    }

    #isAboveCustomFloors(account, modelId) {
        const floor5h = this.#profile.floor5hPct / 100;
        const floorWeekly = this.#profile.floorWeeklyPct / 100;
        if (floor5h > 0) {
            const f5 = this.#getFiveFrac(account, modelId);
            if (f5 !== null && f5 <= floor5h) return false;
        }
        if (floorWeekly > 0) {
            const fw = this.#getWeeklyFrac(account);
            if (fw !== null && fw <= floorWeekly) return false;
        }
        return true;
    }

    #refreshDailySlots(accounts, preferredIdx, modelId) {
        const today = this.#todayKey();
        if (this.#dayKey === today && this.#dailyAllowed.size > 0) return;
        this.#dayKey = today;
        this.#dailyAllowed.clear();

        const cap = this.#profile.maxDailyAccounts;
        if (cap <= 0) return;

        const usable = accounts
            .map((account, index) => ({ account, index }))
            .filter((it) => this.isAccountUsable(it.account, modelId));
        if (usable.length === 0) return;

        const preferred = usable.find((u) => u.index === preferredIdx);
        if (preferred) this.#dailyAllowed.add(preferred.account.email);

        const ordered = this.#sortCandidates(usable, modelId, preferredIdx);
        for (const item of ordered) {
            if (this.#dailyAllowed.size >= cap) break;
            this.#dailyAllowed.add(item.account.email);
        }
    }

    selectAccount(accounts, modelId, options = {}) {
        const { currentIndex = 0, onSave } = options;
        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        const now = Date.now();
        let idx = currentIndex >= accounts.length ? 0 : currentIndex;
        let current = accounts[idx];
        const p = this.#profile;

        /* Core 1: hard single-account lock */
        if (p.baseCore === 'locked') {
            if (current && this.isAccountUsable(current, modelId)) {
                current.lastUsed = now;
                this.#lastRequestAt = now;
                if (onSave) onSave();
                return { account: current, index: idx, waitMs: 0 };
            }
            const limit = modelId ? current?.modelRateLimits?.[modelId] : null;
            if (current && !current.isInvalid && current.enabled !== false && limit?.isRateLimited && limit.resetTime) {
                const waitMs = limit.resetTime - now;
                if (waitMs > 0 && waitMs <= MAX_WAIT_BEFORE_ERROR_MS) {
                    return { account: null, index: idx, waitMs };
                }
            }
            return { account: null, index: idx, waitMs: 0 };
        }

        this.#refreshDailySlots(accounts, idx, modelId);

        if (!this.#boundEmail || this.#boundEmail !== current?.email) {
            this.#boundEmail = current?.email || null;
            this.#boundSince = now;
            this.#startFiveFrac = this.#getFiveFrac(current, modelId);
        }

        const usable = this.isAccountUsable(current, modelId);
        const aboveFloors = current ? this.#isAboveCustomFloors(current, modelId) : false;
        const stayElapsedSec = (now - this.#boundSince) / 1000;
        const idleElapsedSec = this.#lastRequestAt > 0 ? (now - this.#lastRequestAt) / 1000 : 0;

        const curFive = this.#getFiveFrac(current, modelId);
        const droppedPct = (this.#startFiveFrac !== null && curFive !== null)
            ? (this.#startFiveFrac - curFive) * 100
            : 0;

        const minStayMet = stayElapsedSec >= p.minStaySec;
        const idleGapMet = !p.requireIdleGap || idleElapsedSec >= p.minIdleSec;

        let proactiveDue = false;
        if (p.baseCore === 'quota-step' && p.quotaStepPct > 0) {
            proactiveDue = minStayMet && idleGapMet && droppedPct >= p.quotaStepPct;
        } else if (p.baseCore === 'session-idle') {
            proactiveDue = minStayMet && idleGapMet && (p.quotaStepPct === 0 || droppedPct >= p.quotaStepPct);
        }

        const mustSwitch = !usable || !aboveFloors;

        if (mustSwitch || proactiveDue) {
            if (!usable && p.onUnavailable === 'wait') {
                const limit = modelId ? current?.modelRateLimits?.[modelId] : null;
                const waitMs = limit?.resetTime ? (limit.resetTime - now) : 0;
                return {
                    account: null,
                    index: idx,
                    waitMs: waitMs > 0 && waitMs <= MAX_WAIT_BEFORE_ERROR_MS ? waitMs : 0
                };
            }

            let pool = accounts
                .map((account, index) => ({ account, index }))
                .filter((it) => it.index !== idx && this.isAccountUsable(it.account, modelId));

            if (p.maxDailyAccounts > 0 && this.#dailyAllowed.size > 0) {
                const dailyFiltered = pool.filter((it) => this.#dailyAllowed.has(it.account.email));
                if (dailyFiltered.length > 0 || !mustSwitch) {
                    pool = dailyFiltered;
                } else if (this.#dailyAllowed.size < p.maxDailyAccounts) {
                    /* Admit one new slot within daily cap */
                    const orderedAll = this.#sortCandidates(pool, modelId, idx);
                    if (orderedAll[0]) {
                        this.#dailyAllowed.add(orderedAll[0].account.email);
                        pool = [orderedAll[0]];
                    }
                } else {
                    pool = [];
                }
            }

            const floorHealthy = pool.filter((it) => this.#isAboveCustomFloors(it.account, modelId));
            const candidates = floorHealthy.length > 0 ? floorHealthy : ( !usable ? pool : [] );
            const sorted = this.#sortCandidates(candidates, modelId, idx);

            if (sorted.length > 0) {
                const next = sorted[0];
                logger.info(`[CustomStrategy:${p.name}] Handover -> ${next.account.email}`);
                current = next.account;
                idx = next.index;
                this.#boundEmail = current.email;
                this.#boundSince = now;
                this.#startFiveFrac = this.#getFiveFrac(current, modelId);
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

export default CustomStrategy;

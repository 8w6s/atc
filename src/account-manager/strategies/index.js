/**
 * Strategy Factory
 *
 * Creates and exports account selection strategy instances (10 built-in modes
 * plus user-defined custom profiles stored in config.customModes).
 */

import { StickyStrategy } from './sticky-strategy.js';
import { RoundRobinStrategy } from './round-robin-strategy.js';
import { HybridStrategy } from './hybrid-strategy.js';
import { PipelinedStrategy } from './pipelined-strategy.js';
import { LockedStrategy } from './locked-strategy.js';
import { SessionStrategy } from './session-strategy.js';
import { DaySplitStrategy } from './day-split-strategy.js';
import { ShiftSplitStrategy } from './shift-split-strategy.js';
import { WeeklyGuardStrategy } from './weekly-guard-strategy.js';
import { WarmupStrategy } from './warmup-strategy.js';
import {
    CustomStrategy,
    normalizeCustomProfile,
    evaluateCustomProfileRisk,
    slugifyProfileId
} from './custom-strategy.js';
import { config as globalConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';
import {
    SELECTION_STRATEGIES,
    DEFAULT_SELECTION_STRATEGY,
    STRATEGY_LABELS
} from '../../constants.js';

export const STRATEGY_NAMES = SELECTION_STRATEGIES;
export const DEFAULT_STRATEGY = DEFAULT_SELECTION_STRATEGY;

export function findCustomProfile(strategyName, customModesList = null) {
    if (!strategyName || typeof strategyName !== 'string') return null;
    const lower = strategyName.toLowerCase();
    if (!lower.startsWith('custom:')) return null;
    const targetId = slugifyProfileId(lower.slice('custom:'.length));
    const list = Array.isArray(customModesList)
        ? customModesList
        : (Array.isArray(globalConfig?.customModes) ? globalConfig.customModes : []);
    const found = list.find((p) => slugifyProfileId(p?.id || p?.name) === targetId);
    return found ? normalizeCustomProfile(found) : null;
}

/**
 * Create a strategy instance
 * @param {string} strategyName - Built-in strategy name or 'custom:<id>'
 * @param {Object} strategyConfig - Strategy configuration
 * @returns {BaseStrategy} The strategy instance
 */
export function createStrategy(strategyName, strategyConfig = {}) {
    const raw = String(strategyName || DEFAULT_STRATEGY).trim();
    const name = raw.toLowerCase();

    if (name.startsWith('custom:')) {
        const profile = findCustomProfile(name, strategyConfig?.customModes);
        if (profile) {
            logger.debug(`[Strategy] Creating CustomStrategy (${profile.name})`);
            return new CustomStrategy(profile, strategyConfig);
        }
        logger.warn(`[Strategy] Custom profile "${raw}" not found in config.customModes; falling back to day-split`);
        return new DaySplitStrategy(strategyConfig);
    }

    switch (name) {
        case 'locked':
        case 'single':
        case 'lock':
            logger.debug('[Strategy] Creating LockedStrategy');
            return new LockedStrategy(strategyConfig);

        case 'day-split':
        case 'daysplit':
        case 'daily':
            logger.debug('[Strategy] Creating DaySplitStrategy');
            return new DaySplitStrategy(strategyConfig);

        case 'shift-split':
        case 'shiftsplit':
        case 'shift':
            logger.debug('[Strategy] Creating ShiftSplitStrategy');
            return new ShiftSplitStrategy(strategyConfig);

        case 'session':
        case 'session-shift':
            logger.debug('[Strategy] Creating SessionStrategy');
            return new SessionStrategy(strategyConfig);

        case 'weekly-guard':
        case 'weekly':
            logger.debug('[Strategy] Creating WeeklyGuardStrategy');
            return new WeeklyGuardStrategy(strategyConfig);

        case 'warmup':
        case 'warm-up':
            logger.debug('[Strategy] Creating WarmupStrategy');
            return new WarmupStrategy(strategyConfig);

        case 'pipelined':
        case 'pipelined-5pct':
        case 'pipeline':
            logger.debug('[Strategy] Creating PipelinedStrategy (5% step rotation)');
            return new PipelinedStrategy(strategyConfig);

        case 'sticky':
            logger.debug('[Strategy] Creating StickyStrategy');
            return new StickyStrategy(strategyConfig);

        case 'round-robin':
        case 'roundrobin':
            logger.debug('[Strategy] Creating RoundRobinStrategy');
            return new RoundRobinStrategy(strategyConfig);

        case 'hybrid':
            logger.debug('[Strategy] Creating HybridStrategy');
            return new HybridStrategy(strategyConfig);

        default:
            logger.warn(`[Strategy] Unknown strategy "${strategyName}", falling back to ${DEFAULT_STRATEGY}`);
            return new PipelinedStrategy(strategyConfig);
    }
}

export function isValidStrategy(name, customModesList = null) {
    if (!name || typeof name !== 'string') return false;
    const lower = name.toLowerCase();
    if (lower.startsWith('custom:')) {
        if (Array.isArray(customModesList) && customModesList.length > 0) {
            return Boolean(findCustomProfile(lower, customModesList));
        }
        return lower.length > 'custom:'.length;
    }
    return STRATEGY_NAMES.includes(lower) || lower === 'roundrobin';
}

export function getStrategyLabel(name, customModesList = null) {
    const raw = String(name || DEFAULT_STRATEGY);
    const lower = raw.toLowerCase();
    if (lower.startsWith('custom:')) {
        const profile = findCustomProfile(lower, customModesList);
        return profile ? `Custom Profile: ${profile.name}` : `Custom Profile (${raw.slice(7)})`;
    }
    if (lower === 'roundrobin') return STRATEGY_LABELS['round-robin'];
    return STRATEGY_LABELS[lower] || STRATEGY_LABELS[DEFAULT_STRATEGY];
}

export { StickyStrategy } from './sticky-strategy.js';
export { RoundRobinStrategy } from './round-robin-strategy.js';
export { HybridStrategy } from './hybrid-strategy.js';
export { PipelinedStrategy } from './pipelined-strategy.js';
export { LockedStrategy } from './locked-strategy.js';
export { SessionStrategy } from './session-strategy.js';
export { DaySplitStrategy } from './day-split-strategy.js';
export { ShiftSplitStrategy } from './shift-split-strategy.js';
export { WeeklyGuardStrategy } from './weekly-guard-strategy.js';
export { WarmupStrategy } from './warmup-strategy.js';
export {
    CustomStrategy,
    normalizeCustomProfile,
    evaluateCustomProfileRisk,
    slugifyProfileId,
    CUSTOM_BASE_CORES,
    CUSTOM_CANDIDATE_ORDERS,
    CUSTOM_UNAVAILABLE_POLICIES
} from './custom-strategy.js';
export { BaseStrategy } from './base-strategy.js';
export { HealthTracker, TokenBucketTracker } from './trackers/index.js';

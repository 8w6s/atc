/**
 * Outbound Proxy IP Pool Manager
 *
 * Distributes requests across a pool of HTTP/HTTPS forward proxies to prevent
 * multi-account Google Cloud Code rate limiting, IP correlation, and regional blocks.
 *
 * Supports:
 * - sticky-account: Consistently maps each account to a dedicated proxy IP (safest)
 * - round-robin: Cycles through healthy proxies sequentially
 * - random: Selects randomly among healthy proxies
 * - Automatic proxy health monitoring, cooldowns, and direct IP fallback
 * - HTTP CONNECT tunneling with TLS upgrade for upstream-transport
 */

import http from 'http';
import tls from 'tls';
import crypto from 'crypto';
import { config } from '../config.js';
import { logger } from './logger.js';

class ProxyPoolManager {
    constructor(options = {}) {
        this.overrideEnabled = options.enabled !== undefined ? options.enabled : null;
        this.overrideProxies = options.proxies || null;
        this.overrideStrategy = options.strategy || null;
        this.overrideFallbackDirect = options.fallbackDirect !== undefined ? options.fallbackDirect : null;
        this.healthState = new Map(); // proxyUrl -> { failures: 0, lastFailure: 0, cooldownUntil: 0 }
        this.roundRobinIndex = 0;
        this.COOLDOWN_MS = 60 * 1000; // 60s cooldown for failing proxies
        this.MAX_FAILURES_BEFORE_COOLDOWN = 2;
    }

    /**
     * Get parsed list of configured proxies
     * @returns {Array<{ protocol: string, host: string, port: number, auth: string|null, url: string }>}
     */
    get proxies() {
        return this.getConfiguredProxies().map(p => this.parseProxy(p)).filter(Boolean);
    }

    /**
     * Parse proxy URL into structured component object
     * @param {string} proxyUrl
     * @returns {{ protocol: string, host: string, port: number, auth: string|null, url: string }|null}
     */
    parseProxy(proxyUrl) {
        try {
            const parsed = new URL(proxyUrl);
            const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
            const auth = (parsed.username || parsed.password)
                ? `${decodeURIComponent(parsed.username || '')}:${decodeURIComponent(parsed.password || '')}`
                : null;
            return {
                protocol: parsed.protocol,
                host: parsed.hostname,
                port,
                auth,
                url: proxyUrl
            };
        } catch {
            return null;
        }
    }

    /**
     * Get configured proxy list from memory or config
     * @returns {string[]} Array of normalized proxy URLs
     */
    getConfiguredProxies() {
        if (Array.isArray(this.overrideProxies)) {
            return this.overrideProxies
                .map(p => String(p).trim())
                .filter(p => p.startsWith('http://') || p.startsWith('https://'));
        }
        const pool = config?.proxyIpPool;
        if (Array.isArray(pool) && pool.length > 0) {
            return pool
                .map(p => String(p).trim())
                .filter(p => p.startsWith('http://') || p.startsWith('https://'));
        }
        return [];
    }

    /**
     * Check if proxy pool feature is enabled and has active proxies
     * @returns {boolean}
     */
    isEnabled() {
        const enabled = this.overrideEnabled !== null ? this.overrideEnabled : !!config?.proxyPoolEnabled;
        return enabled && this.getConfiguredProxies().length > 0;
    }

    /**
     * Filter proxies that are currently healthy or have passed their cooldown period
     * @returns {string[]}
     */
    getHealthyProxies() {
        const all = this.getConfiguredProxies();
        if (all.length === 0) return [];

        const now = Date.now();
        const healthy = all.filter(p => {
            const state = this.healthState.get(p);
            if (!state) return true;
            if (state.cooldownUntil && state.cooldownUntil > now) {
                return false; // Still in cooldown
            }
            return true;
        });

        // If fallback to direct is allowed and all proxies are in cooldown,
        // respect cooldown and return empty so direct IP is used
        const allowFallback = this.overrideFallbackDirect !== null
            ? this.overrideFallbackDirect
            : (config?.proxyFallbackDirect !== false);

        if (healthy.length === 0 && all.length > 0 && !allowFallback) {
            let oldestProxy = all[0];
            let oldestTime = Infinity;
            for (const p of all) {
                const s = this.healthState.get(p);
                const t = s?.lastFailure || 0;
                if (t < oldestTime) {
                    oldestTime = t;
                    oldestProxy = p;
                }
            }
            return [oldestProxy];
        }

        return healthy;
    }

    /**
     * Select a proxy for a given account key and strategy
     * Supports both selectProxy('acc@example.com', 'round-robin') and selectProxy({ accountKey, strategy })
     *
     * @param {string|Object} accountOrOptions - Unique identifier or options object
     * @param {string} [strategyOverride] - 'sticky-account' | 'round-robin' | 'random'
     * @returns {string|null} Selected proxy URL or null if pool disabled
     */
    selectProxy(accountOrOptions = '', strategyOverride = null) {
        if (!this.isEnabled()) return null;

        let accountKey = '';
        let strategy = strategyOverride || this.overrideStrategy || config?.proxyRotationStrategy || 'sticky-account';

        if (typeof accountOrOptions === 'object' && accountOrOptions !== null) {
            accountKey = accountOrOptions.accountKey || '';
            if (accountOrOptions.strategy) strategy = accountOrOptions.strategy;
        } else {
            accountKey = accountOrOptions;
        }

        const healthy = this.getHealthyProxies();
        if (healthy.length === 0) return null;

        if (strategy === 'sticky-account') {
            const keyStr = String(accountKey || 'anonymous').toLowerCase();
            const hash = crypto.createHash('sha256').update(keyStr).digest();
            const index = hash.readUInt32BE(0) % healthy.length;
            return healthy[index];
        }

        if (strategy === 'round-robin') {
            const index = this.roundRobinIndex % healthy.length;
            this.roundRobinIndex = (this.roundRobinIndex + 1) % healthy.length;
            return healthy[index];
        }

        // random
        const randomIndex = Math.floor(Math.random() * healthy.length);
        return healthy[randomIndex];
    }

    recordFailure(proxyUrl, error = null) {
        this.reportResult(proxyUrl, false, error);
    }

    /**
     * Report proxy request outcome to manage health and cooldowns
     *
     * @param {string} proxyUrl - Proxy URL that was used
     * @param {boolean} success - Whether the connection succeeded
     * @param {Error} [error] - Error details if failed
     */
    reportResult(proxyUrl, success, error = null) {
        if (!proxyUrl) return;

        let state = this.healthState.get(proxyUrl);
        if (!state) {
            state = { failures: 0, lastFailure: 0, cooldownUntil: 0 };
            this.healthState.set(proxyUrl, state);
        }

        if (success) {
            if (state.failures > 0) {
                state.failures = 0;
                state.cooldownUntil = 0;
            }
        } else {
            const now = Date.now();
            state.failures++;
            state.lastFailure = now;
            if (state.failures >= this.MAX_FAILURES_BEFORE_COOLDOWN) {
                state.cooldownUntil = now + this.COOLDOWN_MS;
                logger.warn(`[ProxyPool] Proxy ${proxyUrl} entered cooldown for ${this.COOLDOWN_MS / 1000}s (${error?.message || 'failures'})`);
            }
        }
    }

    /**
     * Establish an HTTP CONNECT tunnel to target host:port through the selected proxy,
     * and upgrade the resulting socket to a secure TLS stream.
     *
     * @param {Object} options
     * @param {string} options.proxyUrl - Proxy URL (http://user:pass@host:port)
     * @param {string} options.targetHost - Upstream host (e.g. daily-cloudcode-pa.googleapis.com)
     * @param {number} [options.targetPort=443] - Upstream port
     * @param {number} [options.timeoutMs=10000] - Connection timeout
     * @param {string[]} [options.alpnProtocols=['http/1.1']] - ALPN protocols
     * @returns {Promise<tls.TLSSocket>}
     */
    createProxiedTLSSocket({
        proxyUrl,
        targetHost,
        targetPort = 443,
        timeoutMs = 10000,
        alpnProtocols = ['http/1.1']
    }) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(proxyUrl);
            const proxyPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);

            const connectHeaders = {
                Host: `${targetHost}:${targetPort}`
            };

            if (parsed.username || parsed.password) {
                const creds = `${decodeURIComponent(parsed.username || '')}:${decodeURIComponent(parsed.password || '')}`;
                connectHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
            }

            const req = http.request({
                host: parsed.hostname,
                port: proxyPort,
                method: 'CONNECT',
                path: `${targetHost}:${targetPort}`,
                headers: connectHeaders,
                timeout: timeoutMs
            });

            req.on('connect', (res, rawSocket) => {
                if (res.statusCode !== 200) {
                    rawSocket.destroy();
                    const err = new Error(`Proxy CONNECT rejected with HTTP ${res.statusCode} ${res.statusMessage || ''}`);
                    return reject(err);
                }

                // Upgrade raw tunnel socket to secure TLS
                const tlsSocket = tls.connect({
                    socket: rawSocket,
                    servername: targetHost,
                    ALPNProtocols: alpnProtocols
                });

                tlsSocket.on('error', (err) => {
                    rawSocket.destroy();
                    reject(err);
                });

                tlsSocket.on('secureConnect', () => {
                    resolve(tlsSocket);
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error(`Proxy CONNECT timeout after ${timeoutMs}ms`));
            });

            req.on('error', (err) => {
                reject(err);
            });

            req.end();
        });
    }

    /**
     * Get pool statistics for UI dashboard
     * @returns {{total: number, healthy: number, cooldown: number, strategy: string, enabled: boolean}}
     */
    getStatus() {
        const all = this.getConfiguredProxies();
        const healthy = this.getHealthyProxies();
        return {
            total: all.length,
            healthy: healthy.length,
            cooldown: Math.max(0, all.length - healthy.length),
            strategy: config?.proxyRotationStrategy || 'sticky-account',
            enabled: this.isEnabled()
        };
    }
}

export const proxyPool = new ProxyPoolManager();
export { ProxyPoolManager };

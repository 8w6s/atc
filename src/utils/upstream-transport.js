import crypto from 'crypto';
import https from 'https';
import { Readable } from 'stream';
import zlib from 'zlib';
import { config } from '../config.js';

/*
 * Google Frontend (GFE) correlates requests sharing a keep-alive TLS socket and
 * records OriginContext headers (sec-fetch-*, accept-language, etc.) injected by
 * Node's global Undici fetch. Keep one HTTP/1.1 connection pool per credential
 * with a 30s idle timeout (well below GFE's ~240s cutoff) and emit only the wire
 * headers sent by a native Go HTTP client.
 */
const MAX_POOLS = 64;
const POOL_IDLE_TTL_MS = 10 * 60 * 1000;
const IDLE_SOCKET_TIMEOUT_MS = 30 * 1000;
const ACTIVE_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_HANDLER_SYM = Symbol('atcIdleTimeoutHandler');
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function clearIdleTimeout(socket) {
    const fn = socket?.[IDLE_HANDLER_SYM];
    if (fn) {
        socket.removeListener('timeout', fn);
        socket[IDLE_HANDLER_SYM] = null;
    }
}

const agentPools = new Map();
const accountPacerNextAt = new Map();

function waitForPacerSlot(poolKey, gapMs, signal) {
    if (!gapMs || gapMs <= 0) return Promise.resolve();
    const now = Date.now();
    const prevNext = accountPacerNextAt.get(poolKey) || 0;
    const scheduledAt = Math.max(now, prevNext);
    const jitterPct = Math.max(0, Math.min(80, Number(config?.pacerJitterPct ?? 30))) / 100;
    const minFactor = 1 - Math.min(0.15, jitterPct * 0.5);
    const spanFactor = (1 + jitterPct) - minFactor;
    const jitteredGap = Math.round(gapMs * (minFactor + Math.random() * spanFactor));
    accountPacerNextAt.set(poolKey, scheduledAt + jitteredGap);

    if (accountPacerNextAt.size > MAX_POOLS * 2) {
        for (const [k, ts] of accountPacerNextAt.entries()) {
            if (ts <= now) accountPacerNextAt.delete(k);
        }
    }

    const delayMs = scheduledAt - now;
    if (delayMs <= 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason || new Error('Aborted'));
            return;
        }
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        function onAbort() {
            clearTimeout(timer);
            reject(signal.reason || new Error('Aborted'));
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

function hashKey(prefix, value) {
    const digest = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
    return `${prefix}:${digest}`;
}

function getHeaderCaseInsensitive(headers, targetName) {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') {
        return headers.get(targetName) ?? undefined;
    }
    const lower = targetName.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower && v !== undefined && v !== null) {
            return String(v);
        }
    }
    return undefined;
}

function resolvePoolKey(options, authHeader, rawBody) {
    if (options?.accountKey) {
        return hashKey('acct', String(options.accountKey).toLowerCase());
    }
    if (authHeader) {
        return hashKey('auth', authHeader);
    }
    if (rawBody instanceof URLSearchParams) {
        const tokenHint = rawBody.get('refresh_token') || rawBody.get('code');
        if (tokenHint) return hashKey('oauth', tokenHint);
    }
    return 'anon';
}

function evictStalePools(now) {
    for (const [key, entry] of agentPools.entries()) {
        if (now - entry.lastUsed > POOL_IDLE_TTL_MS) {
            entry.agent.destroy();
            agentPools.delete(key);
        }
    }
    while (agentPools.size >= MAX_POOLS) {
        const oldestKey = agentPools.keys().next().value;
        if (!oldestKey) break;
        const oldest = agentPools.get(oldestKey);
        oldest?.agent.destroy();
        agentPools.delete(oldestKey);
    }
}

function getIsolatedAgent(poolKey, testTlsOptions = null) {
    const now = Date.now();
    const effectiveKey = testTlsOptions ? `test:${poolKey}` : poolKey;
    const existing = agentPools.get(effectiveKey);
    if (existing) {
        existing.lastUsed = now;
        agentPools.delete(effectiveKey);
        agentPools.set(effectiveKey, existing);
        return existing.agent;
    }

    evictStalePools(now);

    /*
     * Node's Agent `timeout` option applies to active in-flight sockets as well as
     * idle ones, which would abort deep thinking models whose TTFT exceeds 30s.
     * Arm the 30s timeout only when the socket enters the free pool (matching Go's
     * http.Transport.IdleConnTimeout) and clear/extend it while a request is active.
     */
    const agent = new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 15000,
        maxSockets: 6,
        maxFreeSockets: 2,
        ALPNProtocols: ['http/1.1'],
        ...(testTlsOptions || {})
    });

    agent.on('free', (socket) => {
        clearIdleTimeout(socket);
        const onIdle = () => {
            socket[IDLE_HANDLER_SYM] = null;
            socket.destroy();
        };
        socket[IDLE_HANDLER_SYM] = onIdle;
        const idleSec = Math.max(5, Math.min(180, Number(config?.keepAliveIdleSec) || 30));
        socket.setTimeout(idleSec * 1000, onIdle);
    });

    agentPools.set(effectiveKey, { agent, lastUsed: now });
    return agent;
}

function serializeBody(body) {
    if (body === undefined || body === null) return null;
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
    if (typeof body === 'string') return Buffer.from(body, 'utf8');
    return Buffer.from(String(body), 'utf8');
}

function buildWireHeaders(rawHeaders, bodyBuffer, method) {
    const out = {};
    const userAgent = getHeaderCaseInsensitive(rawHeaders, 'user-agent');
    const contentType = getHeaderCaseInsensitive(rawHeaders, 'content-type');
    const authorization = getHeaderCaseInsensitive(rawHeaders, 'authorization');

    if (userAgent) {
        out['User-Agent'] = userAgent;
    }
    if (contentType && (bodyBuffer !== null || method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        out['Content-Type'] = contentType;
    }
    if (bodyBuffer !== null) {
        out['Content-Length'] = String(bodyBuffer.length);
    }
    out['Accept-Encoding'] = 'gzip';
    if (authorization) {
        out['Authorization'] = authorization;
    }
    return out;
}

export function shouldUseUpstreamTransport(url, options) {
    try {
        const parsed = url instanceof URL ? url : new URL(String(url));
        if (parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        if (host === 'googleapis.com' || host.endsWith('.googleapis.com')) {
            return true;
        }
        if (options?.forceIsolatedTransport && (host === '127.0.0.1' || host === 'localhost')) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

export async function upstreamFetch(url, options = {}) {
    const parsedUrl = url instanceof URL ? url : new URL(String(url));
    const method = (options.method || 'GET').toUpperCase();
    const rawHeaders = options.headers || {};
    const authHeader = getHeaderCaseInsensitive(rawHeaders, 'authorization');
    const bodyBuffer = serializeBody(options.body);
    const wireHeaders = buildWireHeaders(rawHeaders, bodyBuffer, method);

    const isLoopback = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost';
    const testTlsOptions = isLoopback && options._testTlsOptions ? options._testTlsOptions : null;
    const poolKey = resolvePoolKey(options, authHeader, options.body);

    const configuredPacerMs = Number.isFinite(config?.pacerDelayMs) ? config.pacerDelayMs : 250;
    const effectivePacerMs = testTlsOptions
        ? (options._testPacerMs || 0)
        : (options.skipPacer ? 0 : configuredPacerMs);
    if (effectivePacerMs > 0) {
        await waitForPacerSlot(poolKey, effectivePacerMs, options.signal);
    }

    const agent = getIsolatedAgent(poolKey, testTlsOptions);

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                protocol: parsedUrl.protocol,
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: `${parsedUrl.pathname}${parsedUrl.search}`,
                method,
                headers: wireHeaders,
                agent,
                signal: options.signal
            },
            (res) => {
                const status = res.statusCode || 500;
                const statusText = res.statusMessage || '';
                const encoding = (res.headers['content-encoding'] || '').toLowerCase().trim();

                let bodyStream = res;
                let decompressed = false;

                if (encoding === 'gzip' || encoding === 'x-gzip') {
                    const gunzip = zlib.createGunzip();
                    res.on('error', (err) => gunzip.destroy(err));
                    bodyStream = res.pipe(gunzip);
                    decompressed = true;
                } else if (encoding === 'deflate') {
                    const inflate = zlib.createInflate();
                    res.on('error', (err) => inflate.destroy(err));
                    bodyStream = res.pipe(inflate);
                    decompressed = true;
                } else if (encoding === 'br') {
                    const brotli = zlib.createBrotliDecompress();
                    res.on('error', (err) => brotli.destroy(err));
                    bodyStream = res.pipe(brotli);
                    decompressed = true;
                }

                const responseHeaders = new Headers();
                for (const [k, v] of Object.entries(res.headers)) {
                    if (v === undefined) continue;
                    const lower = k.toLowerCase();
                    if (decompressed && (lower === 'content-encoding' || lower === 'content-length')) {
                        continue;
                    }
                    if (Array.isArray(v)) {
                        for (const item of v) responseHeaders.append(k, item);
                    } else {
                        responseHeaders.set(k, String(v));
                    }
                }

                if (NULL_BODY_STATUSES.has(status)) {
                    res.resume();
                    resolve(new Response(null, { status, statusText, headers: responseHeaders }));
                    return;
                }

                resolve(new Response(Readable.toWeb(bodyStream), { status, statusText, headers: responseHeaders }));
            }
        );

        const configuredTimeoutMs = Math.max(15000, (Number(config?.upstreamTimeoutSec) || 300) * 1000);
        const activeTimeoutMs = options.timeoutMs || configuredTimeoutMs;
        req.on('socket', (socket) => {
            clearIdleTimeout(socket);
            socket.setTimeout(activeTimeoutMs);
        });

        req.on('timeout', () => {
            req.destroy(new Error(`Upstream socket timeout after ${activeTimeoutMs}ms`));
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (bodyBuffer !== null && bodyBuffer.length > 0) {
            req.write(bodyBuffer);
        }
        req.end();
    });
}

export function clearUpstreamPools() {
    for (const entry of agentPools.values()) {
        entry.agent.destroy();
    }
    agentPools.clear();
    accountPacerNextAt.clear();
}

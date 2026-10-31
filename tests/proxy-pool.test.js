import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyPoolManager } from '../src/utils/proxy-pool.js';

test('ProxyPool - initialization & pool parsing', () => {
    const pool = new ProxyPoolManager({
        enabled: true,
        proxies: [
            'http://user:pass@1.1.1.1:8080',
            'http://2.2.2.2:3128'
        ]
    });

    assert.equal(pool.proxies.length, 2);
    assert.equal(pool.proxies[0].auth, 'user:pass');
    assert.equal(pool.proxies[0].host, '1.1.1.1');
    assert.equal(pool.proxies[0].port, 8080);
    assert.equal(pool.proxies[1].auth, null);
});

test('ProxyPool - sticky-account consistency', () => {
    const pool = new ProxyPoolManager({
        enabled: true,
        strategy: 'sticky-account',
        proxies: [
            'http://10.0.0.1:8080',
            'http://10.0.0.2:8080',
            'http://10.0.0.3:8080'
        ]
    });

    const accountA = 'dev1@example.com';
    const accountB = 'dev2@example.com';

    const pA1 = pool.selectProxy({ accountKey: accountA });
    const pA2 = pool.selectProxy({ accountKey: accountA });
    const pA3 = pool.selectProxy({ accountKey: accountA });

    assert.ok(pA1);
    assert.equal(pA1, pA2);
    assert.equal(pA1, pA3);

    const pB1 = pool.selectProxy({ accountKey: accountB });
    assert.ok(pB1);
});

test('ProxyPool - round-robin rotation', () => {
    const pool = new ProxyPoolManager({
        enabled: true,
        strategy: 'round-robin',
        proxies: [
            'http://10.0.0.1:8080',
            'http://10.0.0.2:8080'
        ]
    });

    const p1 = pool.selectProxy();
    const p2 = pool.selectProxy();
    const p3 = pool.selectProxy();

    assert.equal(p1, 'http://10.0.0.1:8080');
    assert.equal(p2, 'http://10.0.0.2:8080');
    assert.equal(p1, p3);
});

test('ProxyPool - error cooldown and direct fallback', () => {
    const pool = new ProxyPoolManager({
        enabled: true,
        strategy: 'round-robin',
        fallbackDirect: true,
        proxies: ['http://10.0.0.1:8080']
    });

    const selected = pool.selectProxy();
    assert.ok(selected);

    pool.recordFailure(selected, new Error('Connection refused'));
    pool.recordFailure(selected, new Error('Connection refused'));

    // Proxy is now in cooldown
    const fallback = pool.selectProxy();
    assert.equal(fallback, null, 'Should return null for direct IP fallback when all proxies are in cooldown');
});

/*
 * Standalone catalog of operational & account-safety tips rendered by the TUI
 * ticker banner. Append new entries to SAFETY_TIPS using the same object shape;
 * both the scrolling marquee and the Ctrl+D detail modal pick them up
 * automatically without touching dashboard layout code.
 */
export const SAFETY_TIPS = [
    {
        id: 'family-clone-isolation',
        badge: 'ANTI-BAN',
        title: 'Isolate Your Primary Google Account via Family Group Clones',
        ticker: 'Use a clone account instead of your main Google Account: claim AI Pro/Ultra promo on your main account, share via Google Family Group (18+, same country), and link ONLY 1 clone per Family into atc.',
        summary: 'Keep your primary Google identity (Gmail, Drive, Photos, billing) completely out of third-party coding proxies while still using your claimed Google AI Pro / Ultra plan.',
        points: [
            'Keep the Family Manager clean: Claim the Google One AI Pro / Ultra offer on your main account, enable "Share Google One with family" at one.google.com, and NEVER OAuth that primary account into atc.',
            'Link a dedicated adult clone: Invite a secondary Google account (must be 18+ age-verified and in the same country) at families.google.com. If Cloud Code restricts Antigravity access (403), the restriction lands on the clone rather than locking your main account.',
            'CRITICAL — Shared Family Quota Pool: Google pools Antigravity 5-hour and weekly model quotas across all members of the same Family Group. Adding all 5 family clones from the SAME Family into atc does NOT multiply quota by 5x — when one drains the pool, all 5 hit 0% while generating unnecessary multi-account rotation signals from one IP.',
            'Best setup: Put ONLY 1 active clone per Family Group into atc (keep remaining family slots as cold backups). Only use multiple accounts in atc if each clone belongs to a separate, independent plan/Family.',
            'Mind the 12-month rule: Google enforces a 12-month cooldown when switching Family Groups, and mass-creating 5 fresh accounts at once on the same IP/phone can trigger automated Google Account verification.'
        ],
        sources: [
            'https://support.google.com/googleone/answer/14534406',
            'https://support.google.com/googleone/answer/16287445',
            'https://discuss.ai.google.dev/t/question-regarding-family-sharing-antigravity-access-and-token-quotas/115617',
            'https://discuss.ai.google.dev/t/quota-pool-in-family-now-shared-not-credit/143424'
        ]
    },
    {
        id: 'single-account-lock',
        badge: 'SAFETY',
        title: 'Enable Single-Account Lock When Running One Quota Pool',
        ticker: 'Running a single AI Pro/Ultra plan or 1 Family clone? Turn ON Single-Account Lock ("atc lock on" or Settings) so atc never hops across consumer accounts on transient 429s.',
        summary: 'Antigravity consumer terms explicitly disallow automated multi-account rotation in third-party agents. Locking traffic to one active clone eliminates rapid account-hopping patterns.',
        points: [
            'Run "atc lock on" in terminal or toggle "Single-Account Lock: ON" inside Settings.',
            'All Claude Code requests stay pinned to your currently selected account with isolated HTTP/1.1 keep-alive sockets and per-account burst pacing (250ms).',
            'If you maintain multiple independent plans, keep Min Stay Floor >= 180s and Global Quota Floor >= 10% to avoid rapid ping-pong switching.'
        ],
        sources: []
    },
    {
        id: 'subagent-lite-routing',
        badge: 'QUOTA',
        title: 'Route Claude Code Subagents to Flash-Lite to Save 5h/Weekly Cap',
        ticker: 'Preserve flagship Gemini 4 Argon / Opus quota: map CLAUDE_CODE_SUBAGENT_MODEL to gemini-3.1-flash-lite in Model Mappings so background file searches do not drain your main pool.',
        summary: 'Claude Code spawns parallel subagents for grep, file discovery, and summarization. Running those on flagship models burns 5-hour and weekly quota 4-6x faster.',
        points: [
            'Open "Model Mappings" on the dashboard and keep CLAUDE_CODE_SUBAGENT_MODEL pointed at claude-haiku-5-5 -> gemini-3.1-flash-lite.',
            'atc automatically spaces parallel subagent bursts per account via the Burst Pacer (250ms default) while keeping 0ms extra latency when idle.'
        ],
        sources: []
    },
    {
        id: 'verify-vs-ban-403',
        badge: 'RECOVERY',
        title: 'Handle [verify-req] vs [banned] Correctly Without Retry Storms',
        ticker: 'See [verify-req] on an account? Press V on the dashboard to complete Google verification in browser — do not spam re-logins. On [banned], atc locks background refresh automatically.',
        summary: 'Not every HTTP 403 means a permanent suspension. Distinguishing verification challenges from Terms-of-Service restrictions prevents worsening account flags.',
        points: [
            '[verify-req]: Google requested an interactive account/ToS check (VALIDATION_REQUIRED). Select the account and press V to open the exact verification URL in your browser.',
            '[banned]: Service access was restricted on Cloud Code API. atc immediately halts OAuth/quota polling on that account so it stops sending rejected requests.',
            'Run "atc doctor --fix" anytime to audit client version tuple, loopback port sync, and safety thresholds.'
        ],
        sources: []
    },
    {
        id: 'proxy-ip-pool',
        badge: 'PROXY-IP',
        title: 'Prevent Multi-Account Bans with Outbound Proxy IP Pool',
        ticker: 'Running >2 accounts? Enable the Proxy IP Pool in Settings with "Sticky per Account" so Google sees distinct, consistent IPs instead of multi-account credential bursts from one residential machine.',
        summary: 'Google Frontend correlates high-frequency requests across multiple accounts originating from identical client IPs. Using an IP pool with sticky-account routing isolates each account to a dedicated IP.',
        points: [
            'Enable "Proxy Pool Master: Enabled" under Settings -> Proxy IP Pool tab.',
            'Keep "Proxy Rotation Mode: Sticky per Account" (default). Each Google account deterministically binds to one proxy IP, eliminating suspicious rapid IP hopping on a single account.',
            'If a proxy times out, atc automatically applies a 60s cooldown and fails over cleanly to another healthy proxy or direct connection without dropping your request.'
        ],
        sources: []
    },
    {
        id: 'claude-desktop-integration',
        badge: 'DESKTOP',
        title: 'Use atc with Claude Desktop via Auto-Synced Bridge',
        ticker: 'Connect Claude Desktop: run "atc desktop setup" to auto-sync MCP bridges and use the launcher script to forward all Desktop requests through your local multi-account proxy pool.',
        summary: 'Claude Desktop connects seamlessly through atc with auto-configured MCP server bridges and environment launcher scripts.',
        points: [
            'Run "atc desktop setup" to automatically discover and update claude_desktop_config.json on Windows, macOS, or Linux.',
            'Use the generated launcher script in ~/.config/atc/launch-claude-desktop to start Claude Desktop with ANTHROPIC_BASE_URL pointed to atc.',
            'All Claude Desktop chats enjoy the same multi-account quota expansion, thinking preservation, and anti-ban safeguards as Claude Code.'
        ],
        sources: []
    }
];

/*
 * Compute the current tip index and visible horizontal slice for a given
 * wall-clock timestamp so the existing 75ms dashboard render loop drives a
 * smooth, deterministic marquee with zero extra timers.
 */
export function getTipTickerFrame(tips, nowMs, viewportCols, options = 0) {
    if (!Array.isArray(tips) || tips.length === 0 || viewportCols <= 10) {
        return { index: 0, tip: null, visibleText: '' };
    }

    const cycleOffset = typeof options === 'number' ? options : (options?.cycleOffset || 0);
    const speedMode = typeof options === 'object' ? (options?.speed || 'normal') : 'normal';

    if (speedMode === 'static') {
        const slideMs = 7000;
        const idx = (Math.floor(nowMs / slideMs) + cycleOffset) % tips.length;
        const tip = tips[idx];
        const raw = tip.ticker || tip.summary || tip.title || '';
        const truncated = raw.length > viewportCols
            ? `${raw.slice(0, Math.max(0, viewportCols - 1))}…`
            : raw.padEnd(viewportCols, ' ');
        return { index: idx, tip, visibleText: truncated };
    }

    const stepMs = speedMode === 'slow' ? 240 : (speedMode === 'fast' ? 85 : 150);
    const holdStartSteps = 12; // pause before scrolling
    const holdEndSteps = 10;   // pause at end before advancing

    const schedules = tips.map((tip) => {
        const text = tip.ticker || tip.summary || tip.title || '';
        const overflow = Math.max(0, text.length - viewportCols);
        const totalSteps = overflow > 0
            ? (holdStartSteps + overflow + holdEndSteps)
            : 46; // ~6.9s static hold when text fits without scrolling
        return { tip, text, overflow, totalSteps };
    });

    const grandTotalSteps = schedules.reduce((acc, s) => acc + s.totalSteps, 0);
    const globalStep = (Math.floor(nowMs / stepMs) + cycleOffset) % grandTotalSteps;

    let accSteps = 0;
    for (let i = 0; i < schedules.length; i++) {
        const sched = schedules[i];
        if (globalStep < accSteps + sched.totalSteps) {
            const localStep = globalStep - accSteps;
            let startChar = 0;
            if (sched.overflow > 0) {
                if (localStep < holdStartSteps) {
                    startChar = 0;
                } else if (localStep >= holdStartSteps + sched.overflow) {
                    startChar = sched.overflow;
                } else {
                    startChar = localStep - holdStartSteps;
                }
            }
            const slice = sched.text.slice(startChar, startChar + viewportCols);
            return {
                index: i,
                tip: sched.tip,
                visibleText: slice.padEnd(viewportCols, ' ')
            };
        }
        accSteps += sched.totalSteps;
    }

    const fallback = schedules[0];
    return {
        index: 0,
        tip: fallback.tip,
        visibleText: fallback.text.slice(0, viewportCols).padEnd(viewportCols, ' ')
    };
}

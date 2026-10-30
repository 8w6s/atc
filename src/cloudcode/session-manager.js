/**
 * Session Management for Cloud Code
 *
 * Handles session ID derivation for prompt caching continuity and concurrent conversations.
 * Session IDs are derived from the conversation signature (first message + system prompt)
 * so that:
 * 1. Successive turns within the same conversation reuse the same sessionId (prompt cache hits).
 * 2. Independent conversations and subagents get isolated sessionIds, allowing Google Cloud Code
 *    backend to process them fully in parallel without serialization or lock contention.
 */

import crypto from 'crypto';

// Runtime storage for session IDs (per conversation)
// Key: conversationKey (`${email}:${hash}`), Value: sessionId
const runtimeSessionStore = new Map();
const MAX_SESSIONS = 500;

/**
 * Extract a stable fingerprint for a conversation from the Anthropic request.
 */
function getConversationKey(anthropicRequest, accountEmail) {
    const firstMsg = anthropicRequest?.messages?.[0];
    let firstContent = '';

    if (typeof firstMsg?.content === 'string') {
        firstContent = firstMsg.content;
    } else if (Array.isArray(firstMsg?.content)) {
        firstContent = firstMsg.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('') || JSON.stringify(firstMsg.content);
    }

    // Include system prompt snippet if available to distinguish subagents with custom instructions
    let systemSnippet = '';
    if (typeof anthropicRequest?.system === 'string') {
        systemSnippet = anthropicRequest.system.slice(0, 120);
    } else if (Array.isArray(anthropicRequest?.system)) {
        systemSnippet = JSON.stringify(anthropicRequest.system).slice(0, 120);
    }

    if (!firstContent && !systemSnippet) {
        return null;
    }

    const payload = `${firstContent}::${systemSnippet}`;
    const hash = crypto.createHash('sha256').update(payload).digest('hex').substring(0, 20);
    return `${accountEmail || 'default'}:${hash}`;
}

/**
 * Get or create a session ID for the given conversation & account.
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} accountEmail - The account email to scope the session ID
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(anthropicRequest, accountEmail) {
    const convKey = getConversationKey(anthropicRequest, accountEmail);

    if (!convKey) {
        return generateBinaryStyleId();
    }

    if (runtimeSessionStore.has(convKey)) {
        return runtimeSessionStore.get(convKey);
    }

    const newSessionId = generateBinaryStyleId();

    // Prevent memory leaks in long-running proxy
    if (runtimeSessionStore.size >= MAX_SESSIONS) {
        const oldestKey = runtimeSessionStore.keys().next().value;
        if (oldestKey) runtimeSessionStore.delete(oldestKey);
    }

    runtimeSessionStore.set(convKey, newSessionId);
    return newSessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 * logic: `rs() + Date.now()` where `rs()` is randomUUID
 */
function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs (e.g. useful for testing or explicit reset)
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
}

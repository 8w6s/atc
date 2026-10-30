/*
 * Offline token estimator for Anthropic /v1/messages/count_tokens.
 * Claude Code queries count_tokens before deciding when to auto-compact context;
 * computing this locally avoids spending upstream Cloud Code quota or leaking
 * extra metadata requests.
 */

function countStringTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    let asciiChars = 0;
    let nonAsciiChars = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) < 128) asciiChars++;
        else nonAsciiChars++;
    }
    return Math.ceil(asciiChars / 3.7 + nonAsciiChars / 1.7);
}

function countBlockTokens(block) {
    if (!block) return 0;
    if (typeof block === 'string') return countStringTokens(block);
    if (typeof block !== 'object') return countStringTokens(String(block));

    switch (block.type) {
        case 'text':
            return countStringTokens(block.text) + 2;
        case 'thinking':
            return countStringTokens(block.thinking) + 6;
        case 'redacted_thinking':
            return Math.ceil((block.data?.length || 0) / 4) + 6;
        case 'tool_use': {
            const nameToks = countStringTokens(block.name) + 6;
            const inputStr = typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input || {});
            return nameToks + countStringTokens(inputStr);
        }
        case 'tool_result': {
            let inner = 8;
            if (typeof block.content === 'string') {
                inner += countStringTokens(block.content);
            } else if (Array.isArray(block.content)) {
                for (const sub of block.content) inner += countBlockTokens(sub);
            }
            return inner;
        }
        case 'image': {
            const b64Len = block.source?.data?.length || 0;
            if (b64Len === 0) return 258;
            const approxBytes = (b64Len * 3) / 4;
            return Math.max(258, Math.min(2048, Math.ceil(approxBytes / 750)));
        }
        case 'document': {
            const b64Len = block.source?.data?.length || 0;
            if (b64Len > 0) {
                return Math.max(512, Math.ceil(((b64Len * 3) / 4) / 600));
            }
            return countStringTokens(JSON.stringify(block.source || {})) + 16;
        }
        default:
            return countStringTokens(JSON.stringify(block));
    }
}

export function estimateAnthropicInputTokens(body = {}) {
    if (!body || typeof body !== 'object') return 1;
    let total = 8;

    if (typeof body.system === 'string') {
        total += countStringTokens(body.system) + 4;
    } else if (Array.isArray(body.system)) {
        for (const item of body.system) {
            total += countBlockTokens(item);
        }
        total += 4;
    }

    if (Array.isArray(body.tools) && body.tools.length > 0) {
        total += 16;
        for (const tool of body.tools) {
            total += 10;
            total += countStringTokens(tool?.name);
            total += countStringTokens(tool?.description);
            if (tool?.input_schema) {
                total += countStringTokens(JSON.stringify(tool.input_schema));
            }
        }
    }

    if (Array.isArray(body.messages)) {
        for (const msg of body.messages) {
            total += 4;
            if (typeof msg?.content === 'string') {
                total += countStringTokens(msg.content);
            } else if (Array.isArray(msg?.content)) {
                for (const part of msg.content) {
                    total += countBlockTokens(part);
                }
            }
        }
    }

    return Math.max(1, total);
}

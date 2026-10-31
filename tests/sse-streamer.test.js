import test from 'node:test';
import assert from 'node:assert/strict';
import { streamSSEResponse } from '../src/cloudcode/sse-streamer.js';
import { EmptyResponseError } from '../src/errors.js';

function createMockResponse(chunks) {
    const encoder = new TextEncoder();
    let idx = 0;
    const stream = new ReadableStream({
        pull(controller) {
            if (idx < chunks.length) {
                controller.enqueue(encoder.encode(chunks[idx++]));
            } else {
                controller.close();
            }
        }
    });
    return new Response(stream);
}

test('sse-streamer - empty stream throws EmptyResponseError', async () => {
    const res = createMockResponse([]);
    await assert.rejects(async () => {
        for await (const _ of streamSSEResponse(res, 'claude-sonnet-5-5')) {}
    }, EmptyResponseError);
});

test('sse-streamer - maps SAFETY finishReason to refusal', async () => {
    const chunk = 'data: ' + JSON.stringify({
        response: {
            candidates: [
                {
                    content: { parts: [{ text: 'Blocked content' }] },
                    finishReason: 'SAFETY'
                }
            ]
        }
    }) + '\n\n';

    const res = createMockResponse([chunk]);
    const streamState = {};
    const events = [];

    for await (const ev of streamSSEResponse(res, 'claude-sonnet-5-5', streamState)) {
        events.push(ev);
    }

    assert.equal(streamState.hasEmittedAnyEvent, true);
    const msgDelta = events.find(e => e.type === 'message_delta');
    assert.ok(msgDelta);
    assert.equal(msgDelta.delta.stop_reason, 'refusal');
});

test('sse-streamer - maps MALFORMED_FUNCTION_CALL to stop_sequence', async () => {
    const chunk = 'data: ' + JSON.stringify({
        response: {
            candidates: [
                {
                    content: { parts: [{ text: 'Calling tool' }] },
                    finishReason: 'MALFORMED_FUNCTION_CALL'
                }
            ]
        }
    }) + '\n\n';

    const res = createMockResponse([chunk]);
    const events = [];

    for await (const ev of streamSSEResponse(res, 'claude-sonnet-5-5')) {
        events.push(ev);
    }

    const msgDelta = events.find(e => e.type === 'message_delta');
    assert.ok(msgDelta);
    assert.equal(msgDelta.delta.stop_reason, 'stop_sequence');
});

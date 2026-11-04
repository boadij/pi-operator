import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBridge } from '../extension/bridge.ts';

test('bridge binds exact session identity, projects context, and queues sends as follow-ups', async (t) => {
  const dir = await mkdtemp('/tmp/op-test-');
  await stat(dir);
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const calls: unknown[] = [];
  const entries = [
    { id: 'entry-1', type: 'compaction', summary: 'kept summary' },
    {
      id: 'private',
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private-thought' },
          { type: 'image', data: 'private-image-data', mimeType: 'image/png' },
        ],
      },
    },
  ];
  const confirmations: string[] = [];
  const ctx = {
    getSystemPrompt: () => 'source prompt',
    ui: {
      confirm: async (_title: string, body: string) => {
        confirmations.push(body);
        return true;
      },
    },
    sessionManager: {
      getSessionId: () => 'source_1',
      getSessionFile: () => '/sessions/source.jsonl',
      buildSessionProjection: () => ({
        messages: [{ role: 'assistant', content: 'projected' }],
        entries: [
          {
            sourceEntry: {
              id: 'projected-1',
              type: 'compaction',
              summary: 'compaction summary',
            },
            messages: [{ role: 'assistant', content: 'projected' }],
          },
        ],
      }),
      getLeafId: () => 'entry-1',
      getEntries: () => entries,
    },
  };
  const pi = {
    sendMessage: (...args: unknown[]) => calls.push(args),
  };
  const bridge = createBridge(pi, ctx, dir);
  await bridge.start();
  t.after(() => bridge.close());
  assert.equal((await stat(bridge.path)).mode & 0o777, 0o600);

  const hello = await bridge.call('source_1', '/sessions/source.jsonl', {
    action: 'hello',
  });
  assert.equal(hello.sessionId, 'source_1');
  assert.equal(
    (await bridge.call('source_1', null, { action: 'hello' })).sessionFile,
    '/sessions/source.jsonl',
  );
  await assert.rejects(
    bridge.call('source_1', '/sessions/source.jsonl', {
      action: 'send',
      message: 'unauthorized',
      requestId: 'request-unauthorized',
    }),
    /Unauthorized/,
  );
  await assert.rejects(
    bridge.call('source_1', '/sessions/source.jsonl', { action: 'pair' }),
    /pairing code/,
  );
  const pairingCode = bridge.createPairingCode();
  await assert.rejects(
    bridge.call('source_1', '/sessions/source.jsonl', {
      action: 'pair',
      code: 'incorrect',
    }),
    /pairing code/,
  );
  const pairing = await bridge.call('source_1', '/sessions/source.jsonl', {
    action: 'pair',
    code: pairingCode,
  });
  assert.equal(JSON.stringify(pairing).includes(pairingCode), false);
  bridge.authorize(pairing.capability);
  await assert.rejects(
    bridge.call('source_1', '/sessions/source.jsonl', {
      action: 'pair',
      code: pairingCode,
    }),
    /pairing code/,
  );
  await assert.rejects(
    bridge.call('source_1', '/sessions/other.jsonl', { action: 'hello' }),
    /identity changed/,
  );
  const context = await bridge.call('source_1', '/sessions/source.jsonl', {
    action: 'context',
  });
  assert.doesNotMatch(JSON.stringify(context), new RegExp(pairingCode));
  assert.doesNotMatch(JSON.stringify(context), new RegExp(pairing.capability));
  assert.deepEqual(context.entries[0], {
    id: 'projected-1',
    messages: [{ role: 'assistant', content: 'projected' }],
    compactionSummary: 'compaction summary',
  });
  const history = await bridge.call('source_1', '/sessions/source.jsonl', {
    action: 'history',
    limit: 2,
  });
  const historyText = JSON.stringify(history.entries);
  assert.match(historyText, /private reasoning omitted/);
  assert.match(historyText, /image content unsupported/);
  assert.doesNotMatch(historyText, /private-thought|private-image-data/);
  const sent = await bridge.call('source_1', '/sessions/source.jsonl', {
    action: 'send',
    message: 'please act',
    requestId: 'request-1',
  });
  assert.match(sent.status, /submitted; delivery is not verified/);
  assert.equal((calls[0] as any)[1].deliverAs, 'followUp');
  assert.equal((calls[0] as any)[0].details.requestId, 'request-1');
  assert.deepEqual(confirmations, []);
  assert.match(
    (
      await bridge.call('source_1', '/sessions/source.jsonl', {
        action: 'send',
        message: 'please act',
        requestId: 'request-1',
      })
    ).status,
    /submitted/,
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    bridge.call('source_1', '/sessions/source.jsonl', {
      action: 'send',
      message: 'changed',
      requestId: 'request-1',
    }),
    /Replayed or invalid instruction request/,
  );
  entries.push({
    id: 'sent',
    type: 'custom_message',
    details: { requestId: 'request-1' },
  } as any);
  const delivery = await bridge.call('source_1', '/sessions/source.jsonl', {
    action: 'delivery',
    requestId: 'request-1',
  });
  assert.match(delivery.status, /committed session history/);
});

test('bridge bounds oversized projections and retrieves entries beyond the newest 200 by offset', async (t) => {
  const dir = await mkdtemp('/tmp/op-pages-');
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const longPrompt = 'p'.repeat(20_001);
  const entries = Array.from({ length: 251 }, (_, i) => ({
    id: `source-${i}`,
    type: 'message',
    message: { role: 'user', content: `evidence-${i}` },
  }));
  const ctx = {
    getSystemPrompt: () => longPrompt,
    sessionManager: {
      getSessionId: () => 'pages',
      getSessionFile: () => null,
      getLeafId: () => 'source-250',
      getEntries: () => entries,
      buildSessionProjection: () => ({
        entries: [
          {
            sourceEntry: { id: 'large', type: 'message' },
            messages: [{ role: 'user', content: 'x'.repeat(1_100_000) }],
          },
          {
            sourceEntry: { id: 'small', type: 'message' },
            messages: [{ role: 'user', content: 'kept' }],
          },
        ],
      }),
    },
  };
  const bridge = createBridge({}, ctx, dir);
  await bridge.start();
  t.after(() => bridge.close());
  const projection = await bridge.call('pages', null, { action: 'context' });
  assert.ok(Buffer.byteLength(JSON.stringify(projection)) < 1_000_000);
  assert.equal(projection.systemPrompt, longPrompt);
  assert.equal(projection.systemPromptIncluded, true);
  assert.deepEqual(
    projection.entries.map((entry: any) => entry.id),
    ['small'],
  );
  assert.equal(projection.omittedCount, 1);
  const history = await bridge.call('pages', null, {
    action: 'history',
    offset: 230,
    limit: 20,
  });
  assert.equal(history.entries[0].id, 'source-230');
  assert.equal(history.nextOffset, 250);

  const hugePrompt = 'p'.repeat(1_100_000);
  ctx.getSystemPrompt = () => hugePrompt;
  const promptOmitted = await bridge.call('pages', null, { action: 'context' });
  assert.ok(Buffer.byteLength(JSON.stringify(promptOmitted)) < 1_000_000);
  assert.equal(promptOmitted.systemPrompt, null);
  assert.equal(promptOmitted.systemPromptIncluded, false);
  assert.match(
    promptOmitted.systemPromptLimitation,
    /omitted; it was not truncated/,
  );
});

test('history reports oversized entries as skipped and advances its offset', async (t) => {
  const dir = await mkdtemp('/tmp/op-history-skip-');
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const unicodeText = 'é🙂漢'.repeat(130_000);
  const entries = [
    {
      id: 'too-large',
      type: 'message',
      message: { role: 'user', content: unicodeText },
    },
    {
      id: 'after-large',
      type: 'message',
      message: { role: 'user', content: 'later evidence' },
    },
  ];
  const bridge = createBridge(
    {},
    {
      sessionManager: {
        getSessionId: () => 'history_skip',
        getSessionFile: () => null,
        getEntries: () => entries,
      },
    },
    dir,
  );
  await bridge.start();
  t.after(() => bridge.close());
  const skipped = await bridge.call('history_skip', null, {
    action: 'history',
    offset: 0,
    limit: 1,
  });
  assert.deepEqual(skipped.entries, []);
  assert.deepEqual(skipped.skippedEntries, [
    {
      id: 'too-large',
      entryOffset: 0,
      partsAvailable: true,
      reason:
        'Redacted entry exceeds the response budget; retrieve its content in parts using entryId and entryOffset.',
    },
  ]);
  assert.equal(skipped.nextOffset, 1);
  const later = await bridge.call('history_skip', null, {
    action: 'history',
    offset: skipped.nextOffset,
    limit: 1,
  });
  assert.equal(later.entries[0].id, 'after-large');
  assert.deepEqual(later.skippedEntries, []);
  assert.equal(later.nextOffset, null);

  const serialized = JSON.stringify(entries[0]);
  const emojiIndex = serialized.indexOf('🙂');
  const invalidOffset = Buffer.byteLength(serialized.slice(0, emojiIndex)) + 1;
  assert.equal(
    Buffer.from(serialized)[invalidOffset] & 0b1100_0000,
    0b1000_0000,
  );
  await assert.rejects(
    bridge.call('history_skip', null, {
      action: 'history',
      entryId: 'too-large',
      entryOffset: 0,
      contentOffset: invalidOffset,
    }),
    /UTF-8 codepoint boundary/,
  );

  let contentOffset = 0;
  const parts: string[] = [];
  while (true) {
    const result = await bridge.call('history_skip', null, {
      action: 'history',
      entryId: 'too-large',
      entryOffset: 0,
      contentOffset,
    });
    assert.equal(result.sessionId, 'history_skip');
    assert.equal(result.part.entryId, 'too-large');
    assert.equal(result.part.entryOffset, 0);
    assert.equal(result.part.contentOffset, contentOffset);
    parts.push(result.part.content);
    if (result.part.nextContentOffset === null) {
      assert.equal(
        contentOffset + Buffer.byteLength(result.part.content),
        result.part.totalBytes,
      );
      break;
    }
    assert.ok(result.part.nextContentOffset > contentOffset);
    assert.equal(
      result.part.nextContentOffset,
      contentOffset + Buffer.byteLength(result.part.content),
      `offset=${contentOffset} partBytes=${Buffer.byteLength(result.part.content)} next=${result.part.nextContentOffset}`,
    );
    contentOffset = result.part.nextContentOffset;
  }
  assert.ok(
    Buffer.from(parts.join(''), 'utf8').equals(Buffer.from(serialized)),
  );
  const recovered = JSON.parse(parts.join(''));
  assert.equal(recovered.id, 'too-large');
  assert.equal(recovered.message.content, unicodeText);
});

test('bridge does not remove an active listener', async (t) => {
  const dir = await mkdtemp('/tmp/op-live-');
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const ctx = {
    sessionManager: { getSessionId: () => 'same', getSessionFile: () => null },
  };
  const first = createBridge({}, ctx, dir);
  const second = createBridge({}, ctx, dir);
  await first.start();
  t.after(() => first.close());
  await assert.rejects(second.start(), /already owns this session/);
});

test('pairing codes expire and cannot be used against a different session identity', async (t) => {
  const dir = await mkdtemp('/tmp/op-expired-');
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const bridge = createBridge(
    {},
    {
      sessionManager: {
        getSessionId: () => 'expired',
        getSessionFile: () => null,
      },
    },
    dir,
  );
  await bridge.start();
  t.after(() => bridge.close());
  const code = bridge.createPairingCode();
  const now = Date.now;
  Date.now = () => now() + 121_000;
  try {
    await assert.rejects(
      bridge.call('expired', null, { action: 'pair', code }),
      /pairing code/,
    );
  } finally {
    Date.now = now;
  }
  const fresh = bridge.createPairingCode();
  await assert.rejects(
    bridge.call('expired', '/different/session.jsonl', {
      action: 'pair',
      code: fresh,
    }),
    /identity changed/,
  );
});

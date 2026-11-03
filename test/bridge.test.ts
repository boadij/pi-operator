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
            sourceEntry: { type: 'compaction', summary: 'compaction summary' },
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
    bridge.call('source_1', '/sessions/other.jsonl', { action: 'hello' }),
    /identity changed/,
  );
  const context = await bridge.call('source_1', '/sessions/source.jsonl', {
    action: 'context',
  });
  assert.deepEqual(context.messages[0], {
    role: 'assistant',
    content: 'projected',
  });
  assert.deepEqual(context.compactionSummaries, ['compaction summary']);
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
  assert.deepEqual(confirmations, ['source_1\n\nplease act']);
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

test('bridge rejects a send when source-side confirmation is unavailable', async (t) => {
  const dir = await mkdtemp('/tmp/op-no-ui-');
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const sent: unknown[] = [];
  const ctx = {
    sessionManager: { getSessionId: () => 'no_ui', getSessionFile: () => null },
  };
  const bridge = createBridge(
    { sendMessage: (...args: unknown[]) => sent.push(args) },
    ctx,
    dir,
  );
  await bridge.start();
  t.after(() => bridge.close());
  await assert.rejects(
    bridge.call('no_ui', null, {
      action: 'send',
      message: 'unsafe',
      requestId: 'test',
    }),
    /source-side confirmation was rejected or unavailable/,
  );
  assert.equal(sent.length, 0);
});

test('bridge rejects a send when source-side confirmation is declined', async (t) => {
  const dir = await mkdtemp('/tmp/op-declined-');
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const sent: unknown[] = [];
  const ctx = {
    ui: { confirm: async () => false },
    sessionManager: {
      getSessionId: () => 'declined',
      getSessionFile: () => null,
    },
  };
  const bridge = createBridge(
    { sendMessage: (...args: unknown[]) => sent.push(args) },
    ctx,
    dir,
  );
  await bridge.start();
  t.after(() => bridge.close());
  await assert.rejects(
    bridge.call('declined', null, {
      action: 'send',
      message: 'declined',
      requestId: 'test',
    }),
    /source-side confirmation was rejected or unavailable/,
  );
  assert.equal(sent.length, 0);
});

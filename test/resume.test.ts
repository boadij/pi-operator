import assert from 'node:assert/strict';
import test from 'node:test';
import extension, {
  formatHistoryResult,
  summarizeHistoryResult,
} from '../extension/index.ts';
import { createBridge } from '../extension/bridge.ts';

test('history tool accepts legacy responses and reports a stalled legacy page', () => {
  const compatible = JSON.parse(
    formatHistoryResult(
      { entries: [{ id: 'legacy-entry' }], offset: 5, nextOffset: 6 },
      5,
    ),
  );
  assert.equal(compatible.entries[0].id, 'legacy-entry');
  assert.deepEqual(compatible.skippedEntries, []);
  assert.equal(compatible.warning, undefined);

  const stalled = JSON.parse(
    formatHistoryResult({ entries: [], offset: 5, nextOffset: 5 }, 5),
  );
  assert.equal(stalled.skippedEntries[0].id, null);
  assert.match(stalled.skippedEntries[0].reason, /not retrieved/);
  assert.equal(stalled.nextOffset, 6);
  assert.match(stalled.warning, /older version.*not retrieved/);
});

test('history rendering summarizes pagination, omission, continuation, partial and errors without replacing evidence', () => {
  const result = {
    content: [
      {
        type: 'text',
        text: formatHistoryResult(
          {
            entries: [{ id: 'a' }],
            skippedEntries: [{ id: 'b' }],
            offset: 0,
            nextOffset: 2,
          },
          0,
        ),
      },
    ],
  };
  assert.equal(
    summarizeHistoryResult(result),
    '1 entry · 1 omitted · More available',
  );
  assert.match(result.content[0].text, /"id":"a"/);
  assert.equal(
    summarizeHistoryResult({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            part: { contentOffset: 0, nextContentOffset: 8, totalBytes: 12 },
          }),
        },
      ],
    }),
    'Read entry part · 0–8 of 12 bytes · More available',
  );
  assert.equal(summarizeHistoryResult(result, true), 'Reading source history…');
  assert.equal(
    summarizeHistoryResult({ isError: true }),
    'Source history read failed',
  );
});

test('persisted Operator initializes offline and reconnects only to its saved source', async (t) => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools: any[] = [];
  const commands: string[] = [];
  const sessionId = `resume-${process.pid}`;
  const sourceEntries = [
    {
      id: 'too-large',
      type: 'message',
      message: { role: 'user', content: 'x'.repeat(1_100_000) },
    },
    {
      id: 'after-large',
      type: 'message',
      message: { role: 'user', content: 'later evidence' },
    },
  ];
  const attachment = {
    version: 1,
    targetSessionId: sessionId,
    targetSessionFile: `/sessions/${sessionId}.jsonl`,
  };
  const ctx = {
    sessionManager: {
      getEntries: () => [
        {
          type: 'custom',
          customType: 'pi-operator-attachment',
          data: attachment,
        },
      ],
      getSessionId: () => 'operator',
      getSessionFile: () => '/sessions/operator.jsonl',
    },
    getSystemPrompt: () => 'operator prompt',
  };
  const pi: any = {
    registerFlag() {},
    getFlag: () => undefined,
    on: (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string) => commands.push(name),
    getActiveTools: () => [],
    getAllTools: () => [],
    appendEntry() {
      throw new Error('saved attachment must not be rewritten');
    },
  };
  extension(pi);
  await handlers.get('session_start')!({}, ctx);
  assert.ok(tools.some((tool) => tool.name === 'operator_read_context'));
  assert.ok(tools.some((tool) => tool.name === 'operator_source_status'));
  assert.ok(commands.includes('operator-pair'));
  const context = handlers.get('context')!;
  const event = { messages: [{ role: 'user', content: 'hello' }] };
  const disconnected = await context(event, {
    model: {},
    getSystemPrompt: () => 'prompt',
  });
  assert.match(disconnected.messages[0].content, /disconnected/);

  const source = createBridge(
    {},
    {
      getSystemPrompt: () => 'source policy '.repeat(10_000),
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => attachment.targetSessionFile,
        getLeafId: () => 'leaf',
        getEntries: () => sourceEntries,
        buildSessionProjection: () => ({
          entries: [
            {
              sourceEntry: { id: 'recent-source', type: 'message' },
              messages: [{ role: 'user', content: 'recent source marker' }],
            },
          ],
        }),
      },
    },
  );
  await source.start();
  t.after(() => source.close());
  const reconnected = await context(event, {
    model: { contextWindow: 32000 },
    getSystemPrompt: () => 'prompt',
  });
  assert.match(reconnected.messages[0].content, /Source system prompt omitted/);
  assert.match(reconnected.messages[0].content, /recent source marker/);
  assert.doesNotMatch(reconnected.messages[0].content, /source policy/);
  assert.match(reconnected.messages[0].content, new RegExp(sessionId));
  const readTool = tools.find((tool) => tool.name === 'operator_read_context');
  assert.equal(
    readTool.renderResult({ isError: true, content: [] }, {}, {}, undefined)
      .text,
    'Source history read failed',
  );
  const skippedPage = await readTool.execute('tool-call', {
    offset: 0,
    limit: 1,
  });
  const skippedResult = JSON.parse(skippedPage.content[0].text);
  assert.match(skippedResult.warning, /Retrieve each in parts/);
  assert.equal(skippedResult.skippedEntries[0].id, 'too-large');
  assert.equal(skippedResult.nextOffset, 1);
  const laterPage = await readTool.execute('tool-call', {
    offset: skippedResult.nextOffset,
    limit: 1,
  });
  assert.equal(
    JSON.parse(laterPage.content[0].text).entries[0].id,
    'after-large',
  );
  let contentOffset = 0;
  const parts: string[] = [];
  while (true) {
    const result = await readTool.execute('tool-call', {
      entryId: 'too-large',
      entryOffset: 0,
      contentOffset,
    });
    const part = JSON.parse(result.content[0].text).part;
    assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
    assert.equal(part.entryId, 'too-large');
    assert.equal(part.entryOffset, 0);
    assert.equal(part.contentOffset, contentOffset);
    parts.push(part.content);
    if (part.nextContentOffset === null) {
      assert.equal(
        contentOffset + Buffer.byteLength(part.content),
        part.totalBytes,
      );
      break;
    }
    assert.ok(part.nextContentOffset > contentOffset);
    assert.equal(
      part.nextContentOffset,
      contentOffset + Buffer.byteLength(part.content),
    );
    contentOffset = part.nextContentOffset;
  }
  assert.equal(JSON.parse(parts.join('')).id, 'too-large');
});

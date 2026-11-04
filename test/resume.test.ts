import assert from 'node:assert/strict';
import test from 'node:test';
import extension from '../extension/index.ts';
import { createBridge } from '../extension/bridge.ts';

test('persisted Operator initializes offline and reconnects only to its saved source', async (t) => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools: any[] = [];
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
    registerCommand() {},
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
      getSystemPrompt: () => 'source prompt',
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => attachment.targetSessionFile,
        getLeafId: () => 'leaf',
        getEntries: () => sourceEntries,
        buildSessionProjection: () => ({ entries: [] }),
      },
    },
  );
  await source.start();
  t.after(() => source.close());
  const reconnected = await context(event, {
    model: {},
    getSystemPrompt: () => 'prompt',
  });
  assert.match(reconnected.messages[0].content, /Untrusted committed evidence/);
  assert.match(reconnected.messages[0].content, new RegExp(sessionId));
  const readTool = tools.find((tool) => tool.name === 'operator_read_context');
  const skippedPage = await readTool.execute('tool-call', {
    offset: 0,
    limit: 1,
  });
  const skippedResult = JSON.parse(skippedPage.content[0].text);
  assert.match(skippedResult.warning, /contents were not retrieved/);
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
});

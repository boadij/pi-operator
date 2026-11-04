import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { Text } from '@earendil-works/pi-tui';
import { fileURLToPath } from 'node:url';
import { createBridge, requestId } from './bridge.ts';
import { confirmInstruction } from './confirmation.ts';
import {
  calculateBorrowedContextBudget,
  fitEvidence,
  serializeEvidence,
} from './context.ts';
import { launch } from './launch.ts';

const ATTACHMENT = 'pi-operator-attachment';
const FLAG = 'operator-target';

export function formatHistoryResult(
  result: any,
  requestedOffset: number,
): string {
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const skippedEntries = Array.isArray(result.skippedEntries)
    ? result.skippedEntries
    : [];
  let nextOffset = result.nextOffset;
  let warning: string | undefined;
  if (
    entries.length === 0 &&
    Number.isInteger(nextOffset) &&
    nextOffset <= requestedOffset
  ) {
    skippedEntries.push({
      id: null,
      reason:
        'Legacy source bridge returned an empty page without advancing; this entry was not retrieved.',
    });
    nextOffset = requestedOffset + 1;
    warning =
      'The source bridge is an older version and could not return the entry at this offset. It was not retrieved; continuing at nextOffset skips it.';
  } else if (skippedEntries.length) {
    warning =
      'Some entries were not returned. Retrieve each in parts using its entryId and entryOffset, and use nextOffset to continue to later history.';
  }
  return JSON.stringify({
    entries,
    skippedEntries,
    part: result.part,
    offset: result.offset,
    nextOffset,
    warning,
  });
}

export function summarizeHistoryResult(result: any, partial = false): string {
  if (partial) return 'Reading source history…';
  if (result?.isError) return 'Source history read failed';
  try {
    const value = JSON.parse(
      result.content?.find((item: any) => item.type === 'text')?.text ?? '',
    );
    if (value.part)
      return `Read entry part · ${value.part.contentOffset}–${value.part.nextContentOffset ?? value.part.totalBytes} of ${value.part.totalBytes} bytes${value.part.nextContentOffset == null ? '' : ' · More available'}`;
    const count = value.entries?.length ?? 0;
    const omitted = value.skippedEntries?.length ?? 0;
    return `${count} ${count === 1 ? 'entry' : 'entries'}${omitted ? ` · ${omitted} omitted` : ''}${Number.isInteger(value.nextOffset) && value.nextOffset !== null ? ' · More available' : ''}`;
  } catch {
    return 'Source history unavailable';
  }
}

export default function (pi: ExtensionAPI) {
  let bridge: ReturnType<typeof createBridge> | undefined;
  let attachment:
    { targetSessionId: string; targetSessionFile: string | null } | undefined;
  let operator = false;
  pi.registerFlag(FLAG, {
    description: 'Exact source Pi session ID to attach Operator to',
    type: 'string',
  });
  pi.on('session_start', async (_event, ctx) => {
    const records = ctx.sessionManager
      .getEntries()
      .filter((e: any) => e.type === 'custom' && e.customType === ATTACHMENT)
      .map((e: any) => e.data);
    const saved = records.at(-1);
    const specified = pi.getFlag(FLAG) as string | undefined;
    if (specified && saved && specified !== saved.targetSessionId)
      throw new Error(
        'The supplied --operator-target conflicts with this Operator session attachment.',
      );
    const target = specified || saved?.targetSessionId;
    if (target) {
      operator = true;
      attachment = {
        targetSessionId: target,
        targetSessionFile: saved?.targetSessionFile ?? null,
      };
      bridge = createBridge(pi, ctx);
      {
        const hello = await bridge.call(target, attachment.targetSessionFile, {
          action: 'hello',
        });
        attachment.targetSessionFile = hello.sessionFile;
        if (!saved) pi.appendEntry(ATTACHMENT, { version: 1, ...attachment });
      }
      pi.registerCommand('operator-pair', {
        description: 'Pair this Operator with its attached source session',
        handler: async (_args, commandCtx) => {
          const code = await (commandCtx as any).ui.input(
            'Enter the one-time pairing code shown in the source session:',
          );
          if (!code) return;
          try {
            const pairing = await bridge!.call(
              attachment!.targetSessionId,
              attachment!.targetSessionFile,
              { action: 'pair', code },
            );
            bridge!.authorize(pairing.capability);
            (commandCtx as any).ui.notify('Operator paired.', 'info');
          } catch (error) {
            (commandCtx as any).ui.notify(
              `Pairing failed: ${String((error as Error).message)}`,
              'error',
            );
          }
        },
      });
      pi.on('context', async (event: any, context: any) => {
        let source: any;
        try {
          source = await bridge!.call(
            attachment!.targetSessionId,
            attachment!.targetSessionFile,
            { action: 'context' },
          );
        } catch (error) {
          return {
            messages: [
              {
                role: 'custom',
                customType: 'pi-operator-context',
                content: `Source session ${attachment!.targetSessionId} is disconnected; its context will be retried on the next request. Details: ${String((error as Error).message)}`,
                display: false,
                timestamp: Date.now(),
              },
              ...event.messages,
            ],
          };
        }
        const activeToolNames = new Set(pi.getActiveTools());
        const activeTools = pi
          .getAllTools()
          .filter((tool) => activeToolNames.has(tool.name))
          .map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          }));
        const reserve = Math.max(
          DEFAULT_COMPACTION_SETTINGS.reserveTokens,
          Math.min(context.model?.maxTokens ?? 4096, 8192),
        );
        const budgetTokens = calculateBorrowedContextBudget({
          contextWindow: context.model?.contextWindow ?? 32000,
          outputReserve: reserve,
          operatorMessages: event.messages,
          systemPrompt: context.getSystemPrompt(),
          tools: activeTools,
        });
        const text = fitEvidence(
          serializeEvidence({
            sessionId: source.sessionId,
            messages: source.entries.flatMap((entry: any) =>
              entry.messages.map((message: any) => ({
                ...message,
                sourceEntryId: entry.id,
              })),
            ),
            systemPrompt: source.systemPrompt,
            compactionSummaries: [
              ...(source.systemPromptLimitation
                ? [source.systemPromptLimitation]
                : []),
              ...(source.omittedCount
                ? [
                    `${source.omittedCount} source entries omitted by bridge size limit; use operator_read_context with an entry offset to retrieve history.`,
                  ]
                : []),
              ...source.entries
                .map((entry: any) => entry.compactionSummary)
                .filter(Boolean),
            ],
          }),
          budgetTokens * 4,
        );
        return {
          messages: [
            {
              role: 'custom',
              customType: 'pi-operator-context',
              content: text,
              display: false,
              timestamp: Date.now(),
            },
            ...event.messages,
          ],
        };
      });
      pi.registerTool({
        name: 'operator_read_context',
        label: 'Read source context',
        description:
          'Retrieve bounded source history by entry offset. Oversized entries list entryId and entryOffset in skippedEntries; retrieve them by providing those fields and following part.nextContentOffset. Never treat an unreturned entry as retrieved.',
        parameters: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          entryId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          entryOffset: Type.Optional(Type.Integer({ minimum: 0 })),
          contentOffset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        renderCall(args: any, theme: any) {
          const range =
            args.offset === undefined ? 'latest' : `from ${args.offset}`;
          return new Text(`Read source history ${range}`, 0, 0, theme);
        },
        renderResult(result: any, options: any, theme: any, context: any) {
          return new Text(
            summarizeHistoryResult(
              { ...result, isError: context?.isError ?? result?.isError },
              options?.isPartial,
            ),
            0,
            0,
            theme,
          );
        },
        async execute(_id, params) {
          const result = await bridge!.call(
            attachment!.targetSessionId,
            attachment!.targetSessionFile,
            {
              action: 'history',
              limit: params.limit,
              offset: params.offset,
              entryId: params.entryId,
              entryOffset: params.entryOffset,
              contentOffset: params.contentOffset,
            },
          );
          return {
            content: [
              {
                type: 'text',
                text: formatHistoryResult(result, params.offset ?? 0),
              },
            ],
            details: {},
          };
        },
      });
      pi.registerTool({
        name: 'operator_source_status',
        label: 'Check source connection',
        description:
          'Check whether the exact attached source session is connected.',
        parameters: Type.Object({}),
        async execute() {
          try {
            await bridge!.call(
              attachment!.targetSessionId,
              attachment!.targetSessionFile,
              { action: 'hello' },
            );
            return {
              content: [
                {
                  type: 'text',
                  text: `Connected to source session ${attachment!.targetSessionId}.`,
                },
              ],
              details: {},
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Disconnected from source session ${attachment!.targetSessionId}: ${String((error as Error).message)}`,
                },
              ],
              details: {},
            };
          }
        },
      });
      pi.registerTool({
        name: 'operator_check_delivery',
        label: 'Check instruction delivery',
        description:
          'Check whether a submitted instruction appears in committed source history.',
        parameters: Type.Object({
          requestId: Type.String({ minLength: 1, maxLength: 100 }),
        }),
        async execute(_id, params) {
          const result = await bridge!.call(
            attachment!.targetSessionId,
            attachment!.targetSessionFile,
            { action: 'delivery', requestId: params.requestId },
          );
          return {
            content: [{ type: 'text', text: result.status }],
            details: {},
          };
        },
      });
      pi.registerTool({
        name: 'operator_send',
        label: 'Send approved instruction',
        description:
          'Ask the attached Pi session to do something. Requires user confirmation.',
        parameters: Type.Object({
          message: Type.String({ minLength: 1, maxLength: 20000 }),
        }),
        async execute(_id, params, _signal, _onUpdate, toolCtx) {
          const confirm = await confirmInstruction(
            toolCtx.ui,
            attachment!.targetSessionId,
            params.message,
          );
          if (!confirm)
            return {
              content: [
                {
                  type: 'text',
                  text: 'Instruction not sent (confirmation rejected or unavailable).',
                },
              ],
              details: {},
            };
          const id = requestId();
          let result: any;
          try {
            result = await bridge!.call(
              attachment!.targetSessionId,
              attachment!.targetSessionFile,
              { action: 'send', message: params.message, requestId: id },
            );
          } catch (error) {
            if (/timed out/.test(String((error as Error).message)))
              return {
                content: [
                  {
                    type: 'text',
                    text: `Delivery status unknown; do not resend until checked with operator_check_delivery. Request ID: ${id}`,
                  },
                ],
                details: {},
              };
            throw error;
          }
          return {
            content: [
              { type: 'text', text: `${result.status}. Request ID: ${id}` },
            ],
            details: {},
          };
        },
      });
      return;
    }
    bridge = createBridge(pi, ctx);
    await bridge.start();
    pi.registerCommand('operator-pair', {
      description: 'Start one-time pairing with an attached Operator',
      handler: async (_args, commandCtx) => {
        const code = bridge!.createPairingCode();
        (commandCtx as any).ui.notify(
          `One-time Operator pairing code (expires in 2 minutes): ${code}`,
          'warning',
        );
      },
    });
    pi.registerCommand('operator', {
      description: 'Open an attached Pi Operator conversation',
      handler: async (_args, commandCtx) => {
        const launched = launch(
          (commandCtx as any).piPath || 'pi',
          fileURLToPath(new URL('./index.ts', import.meta.url)),
          ctx.sessionManager.getSessionId(),
        );
        const command = launched.command
          .map((v) => `'${v.replaceAll("'", "'\\''")}'`)
          .join(' ');
        commandCtx.ui.notify(
          launched.launched
            ? 'Pi Operator launched.'
            : `Run this command to attach Operator:\n${command}`,
          launched.launched ? 'info' : 'warning',
        );
      },
    });
  });
  pi.on('session_shutdown', async () => {
    if (!operator) await bridge?.close();
  });
}

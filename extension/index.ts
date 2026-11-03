import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
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
      const hello = await bridge.call(target, attachment.targetSessionFile, {
        action: 'hello',
      });
      if (!saved) {
        attachment.targetSessionFile = hello.sessionFile;
        pi.appendEntry(ATTACHMENT, { version: 1, ...attachment });
      }
      pi.on('context', async (event: any, context: any) => {
        const source = await bridge!.call(
          attachment!.targetSessionId,
          attachment!.targetSessionFile,
          { action: 'context' },
        );
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
            messages: source.messages,
            systemPrompt: source.systemPrompt,
            compactionSummaries: source.compactionSummaries,
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
        description: 'Retrieve recent committed source-session messages.',
        parameters: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
        async execute(_id, params) {
          const result = await bridge!.call(
            attachment!.targetSessionId,
            attachment!.targetSessionFile,
            { action: 'history', limit: params.limit },
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result.entries) }],
            details: {},
          };
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
          const result = await bridge!.call(
            attachment!.targetSessionId,
            attachment!.targetSessionFile,
            { action: 'send', message: params.message, requestId: id },
          );
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

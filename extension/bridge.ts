import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { confirmInstruction } from './confirmation.ts';
import { redactHistoryEntries } from './context.ts';

const MAX = 1_000_000;
const MAX_HISTORY_PART = 20_000;
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const runtimeDir = join(homedir(), '.pi', 'operator');
const socketFor = (id: string, directory = runtimeDir) =>
  join(
    directory,
    `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.sock`,
  );

export function createBridge(pi: any, ctx: any, directory = runtimeDir) {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
  if (!validId(sessionId)) throw new Error('Unsupported Pi session ID.');
  const path = socketFor(sessionId, directory);
  let server: Server | undefined;
  let ownedSocket: { dev: number; ino: number } | undefined;
  return {
    path,
    async start() {
      await mkdir(directory, { mode: 0o700, recursive: true });
      const dir = await lstat(directory);
      if (!dir.isDirectory() || dir.uid !== process.getuid?.())
        throw new Error(
          'Operator runtime path must be a directory owned by the current user.',
        );
      await chmod(directory, 0o700);
      const probe = await new Promise<'active' | 'stale' | 'unknown'>(
        (resolve) => {
          const s = connect(path);
          const timer = setTimeout(() => {
            s.destroy();
            resolve('unknown');
          }, 500);
          s.once('connect', () => {
            clearTimeout(timer);
            s.destroy();
            resolve('active');
          });
          s.once('error', (error: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            resolve(
              error.code === 'ECONNREFUSED' || error.code === 'ENOENT'
                ? 'stale'
                : 'unknown',
            );
          });
          timer.unref();
        },
      );
      if (probe === 'active')
        throw new Error('An active Operator bridge already owns this session.');
      if (probe === 'unknown')
        throw new Error(
          'Could not determine whether an existing Operator socket is active; refusing to remove it.',
        );
      const existing = await lstat(path).catch(() => undefined);
      if (
        existing &&
        (!existing.isSocket() || existing.uid !== process.getuid?.())
      )
        throw new Error(
          'Refusing to remove an unexpected file at the Operator socket path.',
        );
      if (existing) await rm(path);
      server = createServer((socket) => handle(socket));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(path, () => resolve());
      });
      await chmod(path, 0o600);
      const socketStat = await lstat(path);
      ownedSocket = { dev: socketStat.dev, ino: socketStat.ino };
    },
    async close() {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      const current = await lstat(path).catch(() => undefined);
      if (
        ownedSocket &&
        current?.dev === ownedSocket.dev &&
        current.ino === ownedSocket.ino
      )
        await rm(path);
    },
    async call(
      targetId: string,
      targetFile: string | null,
      request: unknown,
    ): Promise<any> {
      if (!validId(targetId)) throw new Error('Invalid target session ID.');
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(socketFor(targetId, directory));
        let data = Buffer.alloc(0);
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('Operator bridge timed out.'));
        }, 3000);
        socket.on('data', (chunk) => {
          data = Buffer.concat([data, chunk]);
          if (data.length > MAX) {
            socket.destroy();
            reject(new Error('Bridge response too large.'));
            return;
          }
          const newline = data.indexOf(10);
          if (newline >= 0) {
            clearTimeout(timer);
            resolve(data.subarray(0, newline).toString('utf8'));
            socket.end();
          }
        });
        socket.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        socket.on('connect', () =>
          socket.write(
            JSON.stringify({ ...(request as object), targetId, targetFile }) +
              '\n',
          ),
        );
      });
      const result = JSON.parse(response);
      if (
        result.sessionId !== targetId ||
        (targetFile !== null && result.sessionFile !== targetFile)
      )
        throw new Error(
          'Attached Pi session identity changed; refusing connection.',
        );
      if (result.error) throw new Error(result.error);
      return result;
    },
  };
  async function handle(socket: Socket) {
    let data = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('data', async (chunk) => {
      data += chunk.toString();
      if (Buffer.byteLength(data) > MAX) {
        socket.end(JSON.stringify({ error: 'Request too large.' }) + '\n');
        return;
      }
      if (!data.includes('\n')) return;
      try {
        const q = JSON.parse(data.slice(0, data.indexOf('\n')));
        if (
          q.targetId !== sessionId ||
          (q.targetFile !== sessionFile &&
            !(q.action === 'hello' && q.targetFile === null))
        )
          throw new Error('Source session identity mismatch.');
        let body: any;
        switch (q.action) {
          case 'hello':
            body = {};
            break;
          case 'context': {
            const projection = ctx.sessionManager.buildSessionProjection();
            const entries: any[] = [];
            let omittedCount = projection.entries.length;
            const prompt = String(ctx.getSystemPrompt());
            const promptBytes = Buffer.byteLength(prompt);
            const includedPromptBody = {
              entries,
              omittedCount,
              leafId: ctx.sessionManager.getLeafId(),
              systemPrompt: prompt,
              systemPromptIncluded: true,
            };
            const emptyResponseSize =
              promptBytes <= MAX
                ? Buffer.byteLength(
                    JSON.stringify({
                      sessionId,
                      sessionFile,
                      ...includedPromptBody,
                    }),
                  )
                : MAX + 1;
            const systemPromptIncluded = emptyResponseSize < MAX;
            body = systemPromptIncluded
              ? includedPromptBody
              : {
                  entries,
                  omittedCount,
                  leafId: ctx.sessionManager.getLeafId(),
                  systemPrompt: null,
                  systemPromptIncluded: false,
                  systemPromptLimitation:
                    'The complete source system prompt exceeds the bridge response budget and was omitted; it was not truncated.',
                };
            let bytes = Math.max(
              0,
              MAX -
                Buffer.byteLength(
                  JSON.stringify({ sessionId, sessionFile, ...body }),
                ) -
                4096,
            );
            // Bound each entry before building a response; a single oversized
            // entry is left for the offset-based history reader.
            for (
              let index = projection.entries.length - 1;
              index >= 0;
              index--
            ) {
              const entry = projection.entries[index];
              const candidate = {
                id: entry.sourceEntry.id,
                messages: entry.messages,
                compactionSummary:
                  entry.sourceEntry.type === 'compaction'
                    ? entry.sourceEntry.summary
                    : undefined,
              };
              const size = Buffer.byteLength(JSON.stringify(candidate));
              if (size + 1 > bytes) {
                continue;
              }
              entries.unshift(candidate);
              omittedCount--;
              bytes -= size + 1;
            }
            body.omittedCount = omittedCount;
            break;
          }
          case 'history': {
            const all = ctx.sessionManager.getEntries();
            if (q.entryId !== undefined || q.entryOffset !== undefined) {
              const entryOffset = Number(q.entryOffset);
              if (
                !Number.isInteger(entryOffset) ||
                entryOffset < 0 ||
                typeof q.entryId !== 'string' ||
                all[entryOffset]?.id !== q.entryId
              )
                throw new Error(
                  'Historical entry identity changed; refusing part retrieval.',
                );
              const serialized = JSON.stringify(
                redactHistoryEntries([all[entryOffset]])[0],
              );
              const contentOffset = Number(q.contentOffset ?? 0);
              if (
                !Number.isInteger(contentOffset) ||
                contentOffset < 0 ||
                contentOffset >= Buffer.byteLength(serialized)
              )
                throw new Error('Invalid historical entry content offset.');
              const content = Buffer.from(serialized, 'utf8');
              if (
                contentOffset > 0 &&
                (content[contentOffset] & 0b1100_0000) === 0b1000_0000
              )
                throw new Error(
                  'Historical entry content offset must be a UTF-8 codepoint boundary.',
                );
              let end = Math.min(
                contentOffset + MAX_HISTORY_PART,
                content.length,
              );
              while (
                end < content.length &&
                (content[end] & 0b1100_0000) === 0b1000_0000
              )
                end--;
              body = {
                part: {
                  entryId: q.entryId,
                  entryOffset,
                  contentOffset,
                  content: content
                    .subarray(contentOffset, end)
                    .toString('utf8'),
                  nextContentOffset: end < content.length ? end : null,
                  totalBytes: content.length,
                },
              };
              break;
            }
            const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
            const limit = Math.min(
              200,
              Math.max(1, Math.floor(Number(q.limit) || 50)),
            );
            const page: any[] = [];
            const skippedEntries: {
              id: string | null;
              reason: string;
              entryOffset?: number;
              partsAvailable?: boolean;
            }[] = [];
            let bytes = 0;
            let scanned = 0;
            for (const entry of all.slice(offset, offset + limit)) {
              const safeEntry = redactHistoryEntries([entry])[0];
              const size = Buffer.byteLength(JSON.stringify(safeEntry));
              if (size > MAX - 4096) {
                skippedEntries.push({
                  id: typeof entry.id === 'string' ? entry.id : null,
                  entryOffset: offset + scanned,
                  partsAvailable: typeof entry.id === 'string',
                  reason:
                    'Redacted entry exceeds the response budget; retrieve its content in parts using entryId and entryOffset.',
                });
                scanned++;
                continue;
              }
              if (bytes + size > MAX - 4096) break;
              page.push(safeEntry);
              bytes += size;
              scanned++;
            }
            body = {
              entries: page,
              skippedEntries,
              offset,
              nextOffset:
                offset + scanned < all.length ? offset + scanned : null,
            };
            break;
          }
          case 'delivery': {
            const found = ctx.sessionManager
              .getEntries()
              .some(
                (entry: any) =>
                  entry.type === 'custom_message' &&
                  entry.details?.requestId === q.requestId,
              );
            body = {
              status: found
                ? 'delivered to committed session history'
                : 'submitted; delivery is not verified',
            };
            break;
          }
          case 'send':
            if (
              typeof q.message !== 'string' ||
              !q.message.trim() ||
              q.message.length > 20_000
            )
              throw new Error('Invalid instruction.');
            if (!(await confirmInstruction(ctx.ui, sessionId, q.message)))
              throw new Error(
                'Instruction not sent: source-side confirmation was rejected or unavailable.',
              );
            pi.sendMessage(
              {
                customType: 'pi-operator-instruction',
                content: q.message,
                display: true,
                details: { requestId: q.requestId },
              },
              { deliverAs: 'followUp', triggerTurn: true },
            );
            body = { status: 'submitted; delivery is not verified' };
            break;
          default:
            throw new Error('Unsupported bridge action.');
        }
        const response =
          JSON.stringify({ sessionId, sessionFile, ...body }) + '\n';
        if (Buffer.byteLength(response) > MAX)
          throw new Error(
            'Bridge response too large; request a smaller history range.',
          );
        socket.end(response);
      } catch (e) {
        socket.end(
          JSON.stringify({
            sessionId,
            sessionFile,
            error: String((e as Error).message),
          }) + '\n',
        );
      }
    });
  }
}

export const requestId = () => randomUUID();

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect, type Server, type Socket } from 'node:net';

const MAX = 1_000_000;
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
      const probe = await new Promise<boolean>((resolve) => {
        const s = connect(path);
        s.once('connect', () => {
          s.destroy();
          resolve(true);
        });
        s.once('error', () => resolve(false));
        setTimeout(() => {
          s.destroy();
          resolve(false);
        }, 500).unref();
      });
      if (probe)
        throw new Error('An active Operator bridge already owns this session.');
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
        let data = '';
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('Operator bridge timed out.'));
        }, 3000);
        socket.on('data', (chunk) => {
          data += chunk.toString();
          if (data.length > MAX) {
            socket.destroy();
            reject(new Error('Bridge response too large.'));
          }
          if (data.includes('\n')) {
            clearTimeout(timer);
            resolve(data);
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
      if (data.length > MAX) {
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
            body = {
              messages: projection.messages,
              compactionSummaries: projection.entries
                .map((entry: any) => entry.sourceEntry)
                .filter((entry: any) => entry.type === 'compaction')
                .map((entry: any) => entry.summary),
              leafId: ctx.sessionManager.getLeafId(),
              systemPrompt: ctx.getSystemPrompt(),
            };
            break;
          }
          case 'history':
            body = {
              entries: ctx.sessionManager
                .getEntries()
                .slice(-Math.min(200, Math.max(1, Number(q.limit) || 50))),
            };
            break;
          case 'delivery': {
            const found = ctx.sessionManager
              .getEntries()
              .some(
                (entry: any) =>
                  entry.message?.details?.requestId === q.requestId,
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

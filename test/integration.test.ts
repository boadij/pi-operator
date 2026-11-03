import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(
  root,
  'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
);
const extension = join(root, 'extension/index.ts');
const fauxExtension = join(root, 'fixtures/faux-provider.ts');
const markerSocket = (id: string, home: string) =>
  join(
    home,
    '.pi/operator',
    `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.sock`,
  );

function waitForFileContent(path: string, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      error ? reject(error) : resolve();
    };
    const watcher = watch(dirname(path), (_event, filename) => {
      if (!filename || filename.toString() === basename(path)) void check();
    });
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${expected} in ${path}`)),
      30_000,
    );
    watcher.once('error', (error) => finish(error));
    const check = async () => {
      try {
        if ((await readFile(path, 'utf8')).includes(expected)) finish();
      } catch {
        // The log may not exist until the faux provider handles its first request.
      }
    };
    void check();
  });
}

class RpcPi {
  private child: ChildProcessWithoutNullStreams;
  private records: any[] = [];
  private waiters = new Set<{
    predicate: (item: any) => boolean;
    resolve: (item: any) => void;
    timer: NodeJS.Timeout;
  }>();
  private sequence = 0;
  private confirmationCount = 0;
  private stderr = '';

  constructor(
    args: string[],
    env: NodeJS.ProcessEnv,
    executable = process.execPath,
    executableArgs = [cli, ...args],
  ) {
    this.child = spawn(executable, executableArgs, {
      cwd: root,
      env,
      stdio: 'pipe',
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const value = JSON.parse(line);
        const record = { ...value, sequence: ++this.sequence };
        this.records.push(record);
        if (
          record.type === 'extension_ui_request' &&
          record.method === 'confirm'
        ) {
          this.confirmationCount++;
          this.send({
            type: 'extension_ui_response',
            id: record.id,
            confirmed: true,
          });
        }
        for (const waiter of this.waiters) {
          if (waiter.predicate(record)) {
            clearTimeout(waiter.timer);
            this.waiters.delete(waiter);
            waiter.resolve(record);
          }
        }
      } catch {
        this.stderr += `Non-JSON RPC output: ${line}\n`;
      }
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.on('exit', (code, signal) => {
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve({
          type: 'process_exit',
          code,
          signal,
          stderr: this.stderr,
        });
      }
      this.waiters.clear();
    });
  }

  get lastSequence() {
    return this.sequence;
  }
  get confirmations() {
    return this.confirmationCount;
  }
  eventsSince(sequence: number) {
    return this.records.filter((record) => record.sequence > sequence);
  }

  private send(value: unknown) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  waitFor(
    predicate: (item: any) => boolean,
    after = 0,
    timeout = 30_000,
  ): Promise<any> {
    const existing = this.records.find(
      (record) => record.sequence > after && predicate(record),
    );
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: (record: any) =>
          record.sequence > after && predicate(record),
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new Error(
              `Timed out waiting for Pi RPC event. stderr=${this.stderr}`,
            ),
          );
        }, timeout),
      };
      this.waiters.add(waiter);
    });
  }

  async command(type: string, fields: Record<string, unknown> = {}) {
    const id = `req-${Math.random()}`;
    const after = this.lastSequence;
    this.send({ type, id, ...fields });
    const result = await this.waitFor(
      (item) => item.type === 'response' && item.id === id,
      after,
    );
    assert.equal(result.success, true, result.error ?? JSON.stringify(result));
    return result.data;
  }

  async start() {
    return this.command('get_state');
  }

  async promptAndWait(message: string) {
    const after = this.lastSequence;
    await this.command('prompt', { message });
    const settled = await this.waitFor(
      (item) => item.type === 'agent_settled',
      after,
      60_000,
    );
    assert.equal(settled.aborted, false);
    return this.records.filter((item) => item.sequence > after);
  }

  async stop() {
    if (this.hasExited) return;
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded)
      this.child.stdin.end();
    if (await this.waitForExit(5_000)) return;
    this.child.kill('SIGTERM');
    if (await this.waitForExit(2_000)) return;
    this.child.kill('SIGKILL');
    if (await this.waitForExit(2_000)) return;
    throw new Error(
      `Pi RPC child ${this.child.pid ?? '<unknown>'} did not exit after SIGKILL.`,
    );
  }

  get diagnostics() {
    return this.stderr;
  }

  get hasExited() {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.hasExited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (exited: boolean) => {
        clearTimeout(timer);
        this.child.off('exit', onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(this.hasExited), timeoutMs);
      this.child.once('exit', onExit);
      if (this.hasExited) finish(true);
    });
  }
}

test(
  'RpcPi.stop waits for process exit and escalates when SIGTERM is ignored',
  { timeout: 15_000 },
  async () => {
    const rpc = new RpcPi([], process.env, process.execPath, [
      '-e',
      `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`,
    ]);
    const started = Date.now();
    await rpc.stop();
    assert.equal(rpc.hasExited, true);
    assert.ok(
      Date.now() - started >= 6_500,
      'stop should wait through SIGTERM grace period before SIGKILL',
    );
  },
);

test(
  'two Pi sessions inherit fresh context and queue a confirmed follow-up without interrupting a busy source',
  { timeout: 120_000 },
  async (t) => {
    const home = await mkdtemp('/tmp/pio-e2e-');
    t.after(() => rm(home, { recursive: true, force: true }));
    const baseArgs = [
      '--mode',
      'rpc',
      '--no-extensions',
      '--no-builtin-tools',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--extension',
      extension,
      '--extension',
      fauxExtension,
      '--provider',
      'pi-operator-faux',
      '--model',
      'integration',
    ];
    const releaseSource = join(home, 'release-source-turn');
    const session = (
      name: string,
      extra: string[] = [],
      envExtra: NodeJS.ProcessEnv = {},
    ) =>
      new RpcPi([...baseArgs, '--session-dir', join(home, name), ...extra], {
        ...process.env,
        HOME: home,
        PI_OPERATOR_FAUX_LOG: join(home, `${name}.log`),
        ...envExtra,
      });
    const source = session('source', [], {
      PI_OPERATOR_FAUX_RELEASE_FILE: releaseSource,
    });
    let operator: RpcPi | undefined;
    let busySourceTurn: Promise<unknown> | undefined;
    t.after(async () => {
      await writeFile(releaseSource, 'cleanup').catch(() => {});
      await busySourceTurn?.catch(() => {});
      await operator?.stop();
      await source.stop();
    });

    const sourceState = await source.start();
    const sourceId = sourceState.sessionId as string;
    await source.promptAndWait('Source notes: PI_OPERATOR_MARKER_ALPHA');

    operator = session('operator', [
      '--system-prompt',
      join(root, 'extension/prompt.md'),
      '--operator-target',
      sourceId,
    ]);
    await operator.start();
    const answer1 = await operator.promptAndWait('ASK_SOURCE_MARKER');
    assert.match(
      JSON.stringify(answer1),
      /Source marker: PI_OPERATOR_MARKER_ALPHA/,
    );

    await source.promptAndWait('Update notes: PI_OPERATOR_MARKER_BETA');
    const answer2 = await operator.promptAndWait('ASK_FRESH_MARKER');
    assert.match(
      JSON.stringify(answer2),
      /Fresh source marker: PI_OPERATOR_MARKER_BETA/,
    );

    const operatorHistory = JSON.stringify(
      await operator.command('get_messages'),
    );
    assert.doesNotMatch(
      operatorHistory,
      /Source notes: PI_OPERATOR_MARKER_ALPHA|Update notes: PI_OPERATOR_MARKER_BETA/,
    );

    const busyStart = source.lastSequence;
    busySourceTurn = source.promptAndWait('HOLD_SOURCE_TURN');
    await waitForFileContent(join(home, 'source.log'), 'HOLD_SOURCE_TURN');
    const sendResult = await operator.promptAndWait('FORWARD_INSTRUCTION');
    assert.match(
      JSON.stringify(sendResult),
      /PI_OPERATOR_INTEGRATION_DELIVERY/,
    );
    assert.equal(operator.confirmations, 1);
    assert.equal(source.confirmations, 1);
    assert.equal(
      source
        .eventsSince(busyStart)
        .some((item) => item.type === 'agent_settled'),
      false,
      'source must remain active while the faux provider is holding its turn',
    );
    assert.equal(
      source.eventsSince(busyStart).some((item) => item.type === 'agent_end'),
      false,
      'source must not end or abort its active model run before the hold gate opens',
    );
    assert.doesNotMatch(
      await readFile(join(home, 'source.log'), 'utf8'),
      /PI_OPERATOR_INTEGRATION_DELIVERY/,
      'the follow-up must stay queued until the active source turn is released',
    );
    await writeFile(releaseSource, 'continue');
    await busySourceTurn;

    const operatorLog = (await readFile(join(home, 'operator.log'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .join('\n');
    const requestId = operatorLog.match(/Request ID: ([a-f0-9-]{36})/)?.[1];
    assert.ok(
      requestId,
      'Operator result should expose the message request ID',
    );
    const sourceMessages = JSON.stringify(await source.command('get_messages'));
    assert.ok(
      sourceMessages.indexOf(
        'Held source turn completed without interruption.',
      ) >= 0,
    );
    assert.ok(
      sourceMessages.indexOf(
        'Held source turn completed without interruption.',
      ) <
        sourceMessages.indexOf('Source received the integration instruction.'),
    );
    assert.match(sourceMessages, /PI_OPERATOR_INTEGRATION_DELIVERY/);

    const deliveryResult = await operator.promptAndWait('CHECK_DELIVERY');
    assert.match(
      JSON.stringify(deliveryResult),
      /Delivery verified from committed history/,
    );
    assert.match(
      JSON.stringify(await operator.command('get_messages')),
      new RegExp(requestId),
    );

    const socket = markerSocket(sourceId, home);
    assert.ok(socket.length < 104, `Unix socket path too long: ${socket}`);
  },
);

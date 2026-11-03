import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  constructor(args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [cli, ...args], {
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
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM');
        resolve();
      }, 5_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  get diagnostics() {
    return this.stderr;
  }
}

test(
  'two independent Pi sessions inherit fresh context and send a confirmed source follow-up',
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
    const session = (name: string, extra: string[] = []) =>
      new RpcPi([...baseArgs, '--session-dir', join(home, name), ...extra], {
        ...process.env,
        HOME: home,
        PI_OPERATOR_FAUX_LOG: join(home, `${name}.log`),
      });
    const source = session('source');
    let operator: RpcPi | undefined;
    t.after(async () => {
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

    const sourceBeforeSend = source.lastSequence;
    const sendResult = await operator.promptAndWait('FORWARD_INSTRUCTION');
    assert.match(
      JSON.stringify(sendResult),
      /PI_OPERATOR_INTEGRATION_DELIVERY/,
    );
    assert.equal(operator.confirmations, 1);
    assert.equal(source.confirmations, 1);
    await source.waitFor(
      (item) => item.type === 'agent_settled',
      sourceBeforeSend,
      60_000,
    );

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchArgv, shellQuote } from '../extension/launch.ts';

test('launch isolates Operator and passes exact target as an argv value', () => {
  const args = launchArgv(
    'pi',
    '/tmp/extension.ts',
    '/tmp/prompt.md',
    '/tmp/sessions',
    'abc; echo unsafe',
  );
  assert.ok(args.includes('--no-extensions'));
  assert.ok(args.includes('--no-builtin-tools'));
  assert.equal(args.at(-1), 'abc; echo unsafe');
});

test('Herdr shell command quoting keeps paths with spaces and metacharacters intact', () => {
  const path = "/tmp/My Projects/a'b;$(touch nope).ts";
  assert.equal(shellQuote(path), "'/tmp/My Projects/a'\\''b;$(touch nope).ts'");
  const command = [path, '--operator-target', 'source; id']
    .map(shellQuote)
    .join(' ');
  assert.equal(
    command,
    "'/tmp/My Projects/a'\\''b;$(touch nope).ts' '--operator-target' 'source; id'",
  );
});

test('preview workflow checks the REST open-PR state in both jobs', async () => {
  const workflow = await readFile(
    fileURLToPath(new URL('../.github/workflows/preview.yml', import.meta.url)),
    'utf8',
  );
  assert.equal(
    (workflow.match(/\.state' <<<"\$json"\)" = open/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(workflow, /\.state' <<<"\$json"\)" = OPEN/);
});

test('preview cleanup ignores absent npm tags but preserves other failures', async () => {
  const workflow = await readFile(
    fileURLToPath(new URL('../.github/workflows/preview.yml', import.meta.url)),
    'utf8',
  );
  const marker = '        run: |\n';
  const position = workflow.lastIndexOf(marker);
  assert.ok(position >= 0);
  const script = workflow
    .slice(position + marker.length)
    .trimEnd()
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
  for (const [npmStatus, output, expected] of [
    [0, 'removed', 0],
    [1, 'npm error code E404', 0],
    [1, 'npm error code E403', 1],
  ] as const) {
    const run = spawnSync(
      'bash',
      [
        '-e',
        '-c',
        `npm() { echo "$MOCK_OUTPUT"; return "$MOCK_STATUS"; }\n${script}`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PR: '1',
          MOCK_OUTPUT: output,
          MOCK_STATUS: String(npmStatus),
        },
      },
    );
    assert.equal(run.status, expected, run.stderr);
  }
});

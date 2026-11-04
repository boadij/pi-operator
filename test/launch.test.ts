import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

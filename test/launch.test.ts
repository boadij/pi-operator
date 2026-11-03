import test from 'node:test';
import assert from 'node:assert/strict';
import { launchArgv } from '../extension/launch.ts';

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

import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmInstruction } from '../extension/confirmation.ts';

test('instruction is denied without confirmation UI and exact target and text are confirmed', async () => {
  assert.equal(
    await confirmInstruction(undefined, 'target-1', 'do this'),
    false,
  );
  let prompt = '';
  const accepted = await confirmInstruction(
    {
      confirm: async (title, body) => {
        prompt = `${title}\n${body}`;
        return true;
      },
    },
    'target-1',
    'do this',
  );
  assert.equal(accepted, true);
  assert.equal(
    prompt,
    'Send instruction to attached Pi session?\ntarget-1\n\ndo this',
  );
  assert.equal(
    await confirmInstruction(
      { confirm: async () => false },
      'target-1',
      'do this',
    ),
    false,
  );
});

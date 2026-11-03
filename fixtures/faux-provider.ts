import { appendFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';

function waitForRelease(path: string): Promise<void> {
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
      if (filename?.toString() === basename(path)) void check();
    });
    const timer = setTimeout(
      () =>
        finish(new Error('Timed out waiting for busy-source release gate.')),
      60_000,
    );
    watcher.once('error', (error) => finish(error));
    const check = async () => {
      try {
        await access(path);
        finish();
      } catch {
        // The test creates this file only after confirming that the source stayed busy.
      }
    };
    void check();
  });
}

export default function (pi: any) {
  const faux = fauxProvider({
    provider: 'pi-operator-faux',
    models: [{ id: 'integration', contextWindow: 64_000, maxTokens: 2_000 }],
  });
  pi.registerProvider(faux.provider);

  const respond = async (context: any) => {
    faux.appendResponses([respond]);
    const transcript = JSON.stringify(context.messages);
    const log = process.env.PI_OPERATOR_FAUX_LOG;
    if (log) appendFileSync(log, `${JSON.stringify(transcript)}\n`);

    const releaseFile = process.env.PI_OPERATOR_FAUX_RELEASE_FILE;
    if (
      releaseFile &&
      transcript.includes('HOLD_SOURCE_TURN') &&
      !transcript.includes('Held source turn completed without interruption.')
    ) {
      await waitForRelease(releaseFile);
      return fauxAssistantMessage(
        'Held source turn completed without interruption.',
      );
    }
    if (transcript.includes('delivered to committed session history'))
      return fauxAssistantMessage('Delivery verified from committed history.');
    if (transcript.includes('CHECK_DELIVERY')) {
      const requestId = transcript.match(/Request ID: ([a-f0-9-]{36})/)?.[1];
      if (!requestId)
        return fauxAssistantMessage('Missing the sent request ID.');
      return fauxAssistantMessage(
        fauxToolCall('operator_check_delivery', { requestId }),
        { stopReason: 'toolUse' },
      );
    }
    if (transcript.includes('submitted; delivery is not verified'))
      return fauxAssistantMessage(
        'Instruction was submitted to the source session.',
      );
    if (transcript.includes('FORWARD_INSTRUCTION'))
      return fauxAssistantMessage(
        fauxToolCall('operator_send', {
          message: 'PI_OPERATOR_INTEGRATION_DELIVERY',
        }),
        { stopReason: 'toolUse' },
      );
    if (transcript.includes('ASK_FRESH_MARKER'))
      return fauxAssistantMessage(
        transcript.includes('PI_OPERATOR_MARKER_BETA')
          ? 'Fresh source marker: PI_OPERATOR_MARKER_BETA'
          : 'Fresh source marker missing',
      );
    if (transcript.includes('ASK_SOURCE_MARKER'))
      return fauxAssistantMessage(
        transcript.includes('PI_OPERATOR_MARKER_ALPHA')
          ? 'Source marker: PI_OPERATOR_MARKER_ALPHA'
          : 'Source marker missing',
      );
    if (transcript.includes('PI_OPERATOR_INTEGRATION_DELIVERY'))
      return fauxAssistantMessage(
        'Source received the integration instruction.',
      );
    return fauxAssistantMessage('Faux provider completed the source turn.');
  };
  faux.setResponses([respond]);
}

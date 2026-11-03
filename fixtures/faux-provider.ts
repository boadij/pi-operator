import { appendFileSync } from 'node:fs';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';

export default function (pi: any) {
  const faux = fauxProvider({
    provider: 'pi-operator-faux',
    models: [{ id: 'integration', contextWindow: 64_000, maxTokens: 2_000 }],
  });
  pi.registerProvider(faux.provider);

  const respond = (context: any) => {
    faux.appendResponses([respond]);
    const transcript = JSON.stringify(context.messages);
    const log = process.env.PI_OPERATOR_FAUX_LOG;
    if (log) appendFileSync(log, `${JSON.stringify(transcript)}\n`);

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

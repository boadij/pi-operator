export async function confirmInstruction(
  ui:
    { confirm?: (title: string, body: string) => Promise<boolean> } | undefined,
  targetSessionId: string,
  message: string,
): Promise<boolean> {
  if (typeof ui?.confirm !== 'function') return false;
  return ui.confirm(
    'Send instruction to attached Pi session?',
    `${targetSessionId}\n\n${message}`,
  );
}

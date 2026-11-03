import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function launchArgv(
  piPath: string,
  extensionPath: string,
  promptPath: string,
  sessionDir: string,
  target: string,
): string[] {
  return [
    piPath,
    '--no-extensions',
    '--extension',
    resolve(extensionPath),
    '--no-builtin-tools',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--system-prompt',
    resolve(promptPath),
    '--session-dir',
    resolve(sessionDir),
    '--operator-target',
    target,
  ];
}

export function launch(piPath: string, extensionPath: string, target: string) {
  const base = join(homedir(), '.pi', 'operator-sessions');
  const argv = launchArgv(
    piPath,
    extensionPath,
    join(import.meta.dirname, 'prompt.md'),
    join(base, target),
    target,
  );
  if (process.env.HERDR_PANE_ID) {
    const split = spawnSync(
      'herdr',
      ['pane', 'split', '--current', '--direction', 'right', '--no-focus'],
      { encoding: 'utf8' },
    );
    if (!split.error && split.status === 0) {
      try {
        const paneId = JSON.parse(split.stdout).result.pane.pane_id;
        const run = spawnSync('herdr', ['pane', 'run', paneId, ...argv], {
          stdio: 'ignore',
        });
        if (!run.error && run.status === 0)
          return { launched: true, command: argv };
      } catch {
        // Use the universal fallback if Herdr does not return its pane identifier.
      }
    }
  }
  if (process.env.TMUX) {
    const command = argv
      .map((v) => `'${v.replaceAll("'", "'\\''")}'`)
      .join(' ');
    const run = spawnSync('tmux', ['split-window', '-d', command], {
      stdio: 'ignore',
    });
    if (!run.error && run.status === 0)
      return { launched: true, command: argv };
  }
  return { launched: false, command: argv };
}

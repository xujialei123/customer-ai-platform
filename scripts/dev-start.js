import { spawn } from 'node:child_process';

const commands = [
  ['pnpm', ['dev:rag']],
  ['pnpm', ['dev:api']]
];

for (const [command, args] of commands) {
  const child = spawn(command, args, {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
}

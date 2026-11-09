import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';

const port = Number(process.env.PORT ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
await new Promise((resolve, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); reject(new Error(`Port ${port} is already in use. Stop the existing local TrueForge server before starting this command.`)); });
  socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(); else reject(new Error('Could not check the local TrueForge port.', { cause: error })); });
  socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Timed out checking the local TrueForge port.')); });
});
// The editor MCP server binds to loopback; keep the rest of the outbound URL policy enabled.
const child = spawn('npx', ['--yes', '@truefoundry/trueforge@0.184.2', '--port', String(port)], {
  cwd: homedir(), stdio: 'inherit',
  env: { ...process.env, OUTBOUND_URL_ALLOWED_HOSTS: JSON.stringify(['127.0.0.1', 'localhost']) },
});
child.on('error', error => { throw new Error('Could not start local TrueForge.', { cause: error }); });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });

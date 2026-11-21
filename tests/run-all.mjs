/* Test entry point: starts the local static server, runs the browser suites against it, and tears
   the server down whatever the outcome. The server binds 127.0.0.1 only (see serve.mjs). The port
   comes from PORT (default 8137); pass another to avoid a server already running on the default. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = process.env.PORT || 8137;
const server = spawn(process.execPath, ['serve.mjs', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
let serverReady = false;
server.stdout.on('data', (d) => { if (String(d).includes('localhost')) serverReady = true; });
server.on('exit', (code) => { if (code !== 0 && code !== null) console.error(`static server exited with ${code}`); });

// Wait for the server to accept connections before launching the browser.
for (let i = 0; i < 50 && !serverReady; i++) await delay(100);
if (!serverReady) { console.error('static server did not start'); server.kill(); process.exit(1); }

const runner = spawn(process.execPath, ['tests/run-tests.mjs', `http://localhost:${PORT}`], { stdio: 'inherit' });
const exitCode = await new Promise((resolve) => {
  runner.on('exit', resolve);
  runner.on('error', (err) => { console.error(err); resolve(1); });
});
server.kill();
process.exit(exitCode ?? 1);

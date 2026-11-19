// Development: Vite dev server with hot reload for the window, and esbuild in watch
// mode for the main process (Electron restarts when it changes).
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { context } from 'esbuild';
import electronPath from 'electron';
import { electronBuildOptions } from './build.mjs';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];

let child = null;
function startElectron() {
  if (child) {
    child.removeAllListeners('exit');
    child.kill();
  }
  child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });
  child.on('exit', () => {
    server.close();
    process.exit(0);
  });
}

const ctx = await context({
  ...electronBuildOptions,
  plugins: [{ name: 'restart-electron', setup: (b) => b.onEnd((r) => r.errors.length === 0 && startElectron()) }],
});
await ctx.watch();

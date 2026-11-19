// Builds the app: the window (Vite) into dist/renderer, and the Electron main
// process and preload script (esbuild) into dist/electron.
import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';

export const electronBuildOptions = {
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
  outdir: 'dist/electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
};

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  await viteBuild({ configFile: 'vite.config.ts', logLevel: 'warn' });
  await esbuild(electronBuildOptions);
  console.log('Built dist/renderer and dist/electron');
}

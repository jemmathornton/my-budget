import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The built app talks to nothing: drop the dev server from the Content Security Policy and
 * forbid <base>, form posts and plugins. (In development the dev server is still allowed.)
 */
function productionCsp(): Plugin {
  return {
    name: 'production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        / connect-src 'self' ws:\/\/localhost:5317 http:\/\/localhost:5317"/,
        ` connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'"`,
      );
    },
  };
}

// The renderer is loaded from file:// in the packaged app, so asset paths must be relative.
export default defineConfig({
  base: './',
  plugins: [react(), productionCsp()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: true,
    // One bundle loaded from disk: chunk size doesn't matter for a desktop app.
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port: 5317,
    strictPort: true,
  },
});

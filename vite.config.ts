import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [
    // monaco-vim's browser export is UMD; use its ESM build and adapt its
    // older internal imports to Monaco's current package export paths.
    { find: /^monaco-vim$/, replacement: fileURLToPath(new URL('./node_modules/monaco-vim/dist/index.mjs', import.meta.url)) },
    { find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: 'monaco-editor/$1' },
  ] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4317', ws: true },
      '/projects': {
        target: 'http://127.0.0.1:4317', ws: true,
        bypass(req) { if (req.headers.accept?.includes('text/html') && !req.url?.includes('/api/') && !req.url?.includes('/mcp/')) return '/index.html'; },
      },
      '/excalidraw-assets': { target: 'http://127.0.0.1:4317' },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});

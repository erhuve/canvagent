import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4317', ws: true },
      '/excalidraw-assets': { target: 'http://127.0.0.1:4317' },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});

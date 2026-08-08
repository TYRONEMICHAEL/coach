import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The web body imports the session core from ../src directly — one brain,
// no publishing step. The dev server proxies /api to the local relay.
export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});

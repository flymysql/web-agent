import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
      },
    },
  },
  resolve: {
    alias: {
      '@ai-browser-agent/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
    },
  },
});

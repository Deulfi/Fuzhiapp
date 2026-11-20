import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        logger: resolve(__dirname, 'logger.html'),
      },
    },
  },
  server: { port: 5173, strictPort: true },
});

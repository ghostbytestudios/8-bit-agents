import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  // Relative URLs, so the site works at any path (GitHub Pages serves it under /8-bit-agents/).
  base: './',
  build: {
    rollupOptions: {
      input: { index: page('index.html'), privacy: page('privacy.html') },
    },
  },
});

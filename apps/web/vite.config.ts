import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Docker serves the API as `app`; set WEFT_PROXY_TARGET to point a local dev server at another backend.
const target = process.env.WEFT_PROXY_TARGET ?? 'http://app:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': target,
      '/health': target,
    },
  },
});

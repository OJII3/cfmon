import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, request) => {
            const origin = request.headers.origin;
            if (origin && new URL(origin).host === request.headers.host) {
              outgoing.setHeader('origin', 'http://localhost:8787');
            }
          });
        },
      },
    },
  },
});

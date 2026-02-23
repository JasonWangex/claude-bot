import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3456',
    },
  },
  preview: {
    allowedHosts: ['dev-server'],
    proxy: {
      '/api': 'http://localhost:3456',
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router'],
          antd: ['antd', '@ant-design/icons'],
        },
      },
    },
  },
});

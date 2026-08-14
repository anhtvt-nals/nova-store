import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
    dedupe: ['react', 'react-dom'],
  },
  build: { outDir: 'dist/public', emptyOutDir: true },
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    host: '0.0.0.0',
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT || 3001}` },
  },
  preview: { port: Number(process.env.WEB_PORT || 5173), host: '0.0.0.0' },
});

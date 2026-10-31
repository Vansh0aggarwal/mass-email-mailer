import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },

    // Ensure only one copy of React is used.
    dedupe: ['react', 'react-dom'],
  },

  server: {
    port: 5173,

    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
    },
  },

  build: {
    // Use esbuild for minification.
    minify: 'esbuild',

    // Chunk-size warning threshold.
    chunkSizeWarningLimit: 600,

    // Let Vite/Rollup manage dependency chunking automatically.
    // Avoid custom manualChunks to prevent runtime dependency-order issues.
  },
});
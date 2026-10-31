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
    // Use esbuild for minification (faster than terser, comparable output).
    minify: 'esbuild',
    // Raise the warning threshold slightly — we're splitting intentionally.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        /**
         * Manual chunk splitting strategy:
         * - "vendor-react"   : React core — cached long-term; changes rarely.
         * - "vendor-router"  : react-router-dom — downloaded once per deploy.
         * - "vendor-query"   : @tanstack/react-query — separate from React core.
         * - "vendor-charts"  : recharts — large (~150 KB gz); only needed on /analytics.
         * - "vendor-ui"      : lucide-react icons — shared across many pages.
         * All actual page code is split automatically by React.lazy() in App.tsx.
         */
        manualChunks(id: string) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/react-router-dom') || id.includes('node_modules/react-router/')) {
            return 'vendor-router';
          }
          if (id.includes('node_modules/@tanstack/react-query')) {
            return 'vendor-query';
          }
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-') || id.includes('node_modules/victory-')) {
            return 'vendor-charts';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-ui';
          }
          // All other node_modules go into a generic vendor chunk.
          if (id.includes('node_modules/')) {
            return 'vendor-misc';
          }
        },
      },
    },
  },
});

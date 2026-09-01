import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [
          // Jotai HMR support: caches atom instances in globalThis.jotaiAtomCache
          // so HMR re-execution returns stable atoms instead of orphaning data.
          'jotai-babel/plugin-debug-label',
          'jotai-babel/plugin-react-refresh',
        ],
      },
    }),
    tailwindcss(),
  ],
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        univer: resolve(__dirname, 'src/renderer/univer/index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      // Force a single React copy (Bun hoists to root; this avoids
      // "multiple React copies" errors from workspace packages).
      'react': resolve(__dirname, '../../node_modules/react'),
      'react-dom': resolve(__dirname, '../../node_modules/react-dom'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'jotai'],
    exclude: ['@app/ui'],
  },
  server: {
    port: Number(process.env.APP_VITE_PORT) || 5173,
    strictPort: true,
    open: false,
  },
})

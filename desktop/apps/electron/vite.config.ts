import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const configDir = dirname(fileURLToPath(import.meta.url))

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
  root: resolve(configDir, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(configDir, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(configDir, 'src/renderer/index.html'),
        powerpoint: resolve(configDir, 'src/renderer/powerpoint.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(configDir, 'src/renderer'),
      '@shared': resolve(configDir, 'src/shared'),
      // Force a single React copy (Bun hoists to root; this avoids
      // "multiple React copies" errors from workspace packages).
      'react': resolve(configDir, '../../node_modules/react'),
      'react-dom': resolve(configDir, '../../node_modules/react-dom'),
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

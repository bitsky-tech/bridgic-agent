import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { debugViteSettings } from '../../scripts/debug/startup'

const configDir = dirname(fileURLToPath(import.meta.url))

const rendererConfig = defineConfig({
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
        word: resolve(configDir, 'src/renderer/word.html'),
        excel: resolve(configDir, 'src/renderer/excel.html'),
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
    include: ['react', 'react-dom', 'jotai', 'pptxgenjs', 'jszip'],
    exclude: ['@app/ui'],
  },
  server: {
    port: Number(process.env.APP_VITE_PORT) || 5173,
    strictPort: true,
    open: false,
  },
})

export default defineConfig(({ command }) => {
  const debug = debugViteSettings(command, process.env)
  return {
    ...rendererConfig,
    define: { __DESKTOP_DEBUG__: JSON.stringify(debug.enabled) },
    server: {
      ...rendererConfig.server,
      ...(debug.enabled ? { proxy: {
        '/__debug-api': {
          target: debug.target,
          changeOrigin: true,
          headers: { authorization: `Bearer ${debug.token}` },
        },
      } } : {}),
    },
  }
})

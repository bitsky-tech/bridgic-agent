import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { debugViteSettings } from '../../scripts/debug/startup'
import { parseRendererEntry, RENDERER_ENTRY_ENV, RENDERER_ENTRY_FILES } from '../../scripts/renderer-entries'

const configDir = dirname(fileURLToPath(import.meta.url))

const rendererConfig = defineConfig({
  root: resolve(configDir, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(configDir, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: Object.fromEntries(Object.entries(RENDERER_ENTRY_FILES).map(
        ([entry, file]) => [entry, resolve(configDir, 'src/renderer', file)],
      )),
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
    // Workers are outside Vite's HTML import crawl. Discover their dependencies
    // at startup so the first Office import cannot reload every renderer.
    entries: ['*.html', 'lib/**/*.worker.ts'],
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
  const entry = command === 'build' ? parseRendererEntry(process.env[RENDERER_ENTRY_ENV]) : undefined
  return {
    ...rendererConfig,
    plugins: [
      // Production builds skip Babel; atom labels and HMR are development-only.
      react(command === 'serve' ? { babel: { plugins: [
        'jotai-babel/plugin-debug-label',
        'jotai-babel/plugin-react-refresh',
      ] } } : {}),
      tailwindcss(),
    ],
    build: {
      ...rendererConfig.build,
      // Independent builds must not overwrite chunks (including workers) used
      // by another page. Electron continues to load the sibling root HTML files.
      assetsDir: entry ? `assets/${entry}` : 'assets',
      emptyOutDir: !entry,
      rollupOptions: {
        input: entry
          ? { [entry]: resolve(configDir, 'src/renderer', RENDERER_ENTRY_FILES[entry]) }
          : rendererConfig.build!.rollupOptions!.input,
      },
    },
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

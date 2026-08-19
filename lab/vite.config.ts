import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const configuredPort = Number(process.env.BRIDGIC_AGENT_LAB_PORT)
const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 4319
const configuredApiPort = Number(process.env.BRIDGIC_AGENT_LAB_API_PORT)
const apiPort = Number.isInteger(configuredApiPort) && configuredApiPort > 0
  ? configuredApiPort
  : port + 1
const apiTarget = `http://127.0.0.1:${apiPort}`

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': apiTarget,
    },
  },
  preview: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': apiTarget,
    },
  },
})

import { resolve, sep } from 'node:path'

import { createApiHandler } from './api'
import { LAB_HOST, readLabPort } from './constants'

const distRoot = resolve(import.meta.dir, '..', 'dist')
const apiHandler = createApiHandler()

function resolveAsset(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const assetPath = resolve(distRoot, relativePath)
  if (assetPath !== distRoot && !assetPath.startsWith(`${distRoot}${sep}`)) return null
  return assetPath
}

const server = Bun.serve({
  hostname: LAB_HOST,
  port: readLabPort(),
  async fetch(request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) return apiHandler(request)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 })
    }

    const assetPath = resolveAsset(url.pathname)
    if (assetPath) {
      const asset = Bun.file(assetPath)
      if (await asset.exists()) {
        return new Response(request.method === 'HEAD' ? null : asset, {
          headers: {
            'Cache-Control': url.pathname.startsWith('/assets/')
              ? 'public, max-age=31536000, immutable'
              : 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
    }

    const index = Bun.file(resolve(distRoot, 'index.html'))
    if (!await index.exists()) {
      return new Response('Run `bun run build` before `bun run preview`.', { status: 503 })
    }
    return new Response(request.method === 'HEAD' ? null : index, {
      headers: {
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})

console.log(`[Bridgic Agent Lab] Preview: ${server.url}`)

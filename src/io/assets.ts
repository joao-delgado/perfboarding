import type { AssetMeta } from '../model/types'

/**
 * In-memory asset store. Bytes live here; the project only records metadata,
 * and the zip carries the files. Content-addressed so duplicate uploads dedupe.
 */
const bytes = new Map<string, Uint8Array>()
const urls = new Map<string, string>()

export async function hashBytes(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function putAsset(
  data: Uint8Array,
  mime: string,
  name: string,
): Promise<{ id: string; meta: AssetMeta }> {
  const id = await hashBytes(data)
  if (!bytes.has(id)) bytes.set(id, data)
  return { id, meta: { mime, name } }
}

export function setAsset(id: string, data: Uint8Array): void {
  bytes.set(id, data)
  const old = urls.get(id)
  if (old) {
    URL.revokeObjectURL(old)
    urls.delete(id)
  }
}

export function getAsset(id: string): Uint8Array | undefined {
  return bytes.get(id)
}

export function assetUrl(id: string, mime: string): string {
  const existing = urls.get(id)
  if (existing) return existing
  const data = bytes.get(id)
  if (!data) return ''
  const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: mime }))
  urls.set(id, url)
  return url
}

export function assetUrlMap(assets: Record<string, AssetMeta>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, meta] of Object.entries(assets)) {
    const url = assetUrl(id, meta.mime)
    if (url) out[id] = url
  }
  return out
}

export function clearAssets(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url)
  urls.clear()
  bytes.clear()
}

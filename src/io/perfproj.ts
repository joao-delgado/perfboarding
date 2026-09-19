import { unzipSync, zipSync } from 'fflate'
import { usedAssetIds } from '../model/project'
import type { Project } from '../model/types'
import { getAsset, setAsset } from './assets'

/**
 * A .perfproj is a zip:
 *   meta.json     { formatVersion, app }
 *   project.json  the document, in hole-unit coordinates
 *   assets/<id>   texture files, content-addressed
 */
export const FORMAT_VERSION = 1
export const PERFPROJ_MIME = 'application/x-perfproj'

const enc = new TextEncoder()
const dec = new TextDecoder()

export function serializeProject(project: Project): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'meta.json': enc.encode(
      JSON.stringify({ formatVersion: FORMAT_VERSION, app: 'perf-wiring' }, null, 2),
    ),
    'project.json': enc.encode(JSON.stringify(project, null, 2)),
  }
  for (const id of usedAssetIds(project)) {
    const data = getAsset(id)
    if (data) files[`assets/${id}`] = data
  }
  return zipSync(files, { level: 6 })
}

export interface LoadResult {
  project: Project
  warnings: string[]
}

export function deserializeProject(data: Uint8Array): LoadResult {
  const files = unzipSync(data)
  const warnings: string[] = []

  const metaRaw = files['meta.json']
  if (metaRaw) {
    try {
      const meta = JSON.parse(dec.decode(metaRaw)) as { formatVersion?: number }
      if (meta.formatVersion && meta.formatVersion > FORMAT_VERSION) {
        warnings.push(
          `This file was written by a newer version (format ${meta.formatVersion}); some data may be ignored.`,
        )
      }
    } catch {
      warnings.push('meta.json could not be parsed.')
    }
  }

  const projRaw = files['project.json']
  if (!projRaw) throw new Error('Not a .perfproj file: project.json is missing.')
  const project = JSON.parse(dec.decode(projRaw)) as Project

  for (const [path, bytes] of Object.entries(files)) {
    if (path.startsWith('assets/')) setAsset(path.slice('assets/'.length), bytes)
  }

  // A project written elsewhere may reference a texture whose bytes were lost.
  for (const def of Object.values(project.defs ?? {})) {
    if (def.texture && !project.assets?.[def.texture.assetId]) {
      warnings.push(`Part "${def.name}" references a missing texture.`)
    }
  }

  return { project, warnings }
}

export function projectBlob(project: Project): Blob {
  const bytes = serializeProject(project)
  return new Blob([bytes as unknown as BlobPart], { type: PERFPROJ_MIME })
}

export function suggestedFilename(project: Project): string {
  const base = (project.name || 'untitled').replace(/[^\w-]+/g, '-').toLowerCase()
  return `${base}.perfproj`
}

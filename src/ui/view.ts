import { PITCH_PX } from '../model/geometry'
import type { Camera } from '../model/store'
import type { Vec } from '../model/types'

/**
 * Screen <-> board transform.
 *
 * Viewing the board from below is a render-time mirror of the canonical top
 * view, never a second coordinate space: `col -> (cols - 1) - col`.
 */
export interface View {
  camera: Camera
  mirrored: boolean
  /** World x to mirror about when viewing from below (centre of all boards). */
  mirrorAxis: number
}

export function scale(v: View): number {
  return v.camera.zoom * PITCH_PX
}

export function worldToScreen(v: View, p: Vec): Vec {
  const x = v.mirrored ? 2 * v.mirrorAxis - p.x : p.x
  return { x: v.camera.x + x * scale(v), y: v.camera.y + p.y * scale(v) }
}

export function screenToWorld(v: View, p: Vec): Vec {
  const s = scale(v)
  const x = (p.x - v.camera.x) / s
  const y = (p.y - v.camera.y) / s
  return { x: v.mirrored ? 2 * v.mirrorAxis - x : x, y }
}

/** Transform for the root <g>: everything inside is in board coordinates. */
export function rootTransform(v: View): string {
  const s = scale(v)
  const base = `translate(${v.camera.x} ${v.camera.y}) scale(${s})`
  return v.mirrored ? `${base} translate(${2 * v.mirrorAxis} 0) scale(-1 1)` : base
}

/**
 * Counter-transform for text inside a mirrored root, so labels stay readable.
 * Applied about the text's own anchor point.
 */
export function textTransform(v: View, at: Vec): string {
  return v.mirrored ? `translate(${at.x} ${at.y}) scale(-1 1) translate(${-at.x} ${-at.y})` : ''
}

export function zoomAt(camera: Camera, screenPoint: Vec, factor: number): Camera {
  const next = Math.max(0.1, Math.min(16, camera.zoom * factor))
  const k = next / camera.zoom
  return {
    zoom: next,
    x: screenPoint.x - (screenPoint.x - camera.x) * k,
    y: screenPoint.y - (screenPoint.y - camera.y) * k,
  }
}

/**
 * How much of the viewport a fitted box fills on its tight axis. Filling it
 * edge to edge is technically the "right" fit and reads as the build shoved in
 * your face the moment a project opens, so the frame keeps a margin of its own
 * that scales with the window, unlike the fixed pixel `margin`.
 */
const FIT_FILL = 0.85

/** Fit a world-space box in the viewport with a margin. */
export function fitBox(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  w: number,
  h: number,
  margin = 70,
): Camera {
  const bw = Math.max(1, box.maxX - box.minX)
  const bh = Math.max(1, box.maxY - box.minY)
  const zoom = Math.max(
    0.1,
    Math.min(
      8,
      Math.min((w - margin * 2) / (bw * PITCH_PX), (h - margin * 2) / (bh * PITCH_PX)) * FIT_FILL,
    ),
  )
  const s = zoom * PITCH_PX
  return {
    zoom,
    x: (w - bw * s) / 2 - box.minX * s,
    y: (h - bh * s) / 2 - box.minY * s,
  }
}

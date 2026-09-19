/**
 * SVG path emission for the shape model.
 *
 * This is the only place that knows about `d` strings, so swapping the SVG
 * renderer for a canvas one stays contained to `ui/`.
 */

import { outlineUnion, roundRing, segmentControls, segmentIsCurved } from '../model/shapes'
import type { ArtShape, Outline, PartInstance, PathNode } from '../model/types'

const n = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Number(v.toFixed(5)))

export function nodesD(nodes: PathNode[], closed: boolean): string {
  if (nodes.length === 0) return ''
  const parts: string[] = [`M ${n(nodes[0].x)} ${n(nodes[0].y)}`]
  const last = closed ? nodes.length : nodes.length - 1
  for (let i = 0; i < last; i++) {
    const a = nodes[i]
    const b = nodes[(i + 1) % nodes.length]
    if (!segmentIsCurved(a, b)) {
      parts.push(`L ${n(b.x)} ${n(b.y)}`)
      continue
    }
    const [c1, c2] = segmentControls(a, b)
    parts.push(`C ${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(b.x)} ${n(b.y)}`)
  }
  if (closed) parts.push('Z')
  return parts.join(' ')
}

/**
 * The filled part body, as a single `d`: the real geometric union of every
 * added shape minus every subtracted one (`model/shapes.ts#outlineUnion`), so
 * overlapping shapes never leave a stray stroke line where their edges used
 * to coincide. Render with `fill-rule="evenodd"` — required for the holes cut
 * shapes produce, and harmless everywhere else since these rings never
 * self-overlap.
 */
export function outlineFillD(outline: Outline): string {
  const radius = outline.cornerRadius ?? 0
  const parts: string[] = []
  for (const poly of outlineUnion(outline)) {
    for (const ring of poly) {
      if (ring.length === 0) continue
      if (radius > 0) {
        // The fillet is applied to the union's rings, not to the sub-shapes,
        // so it follows the silhouette the user is actually looking at.
        parts.push(nodesD(roundRing(ring, radius), true))
        continue
      }
      parts.push(`M ${n(ring[0].x)} ${n(ring[0].y)}`)
      for (let i = 1; i < ring.length; i++) parts.push(`L ${n(ring[i].x)} ${n(ring[i].y)}`)
      parts.push('Z')
    }
  }
  return parts.join(' ')
}

/** An art shape's own geometry, in its local frame. Text has no `d`. */
export function artShapeD(s: ArtShape): string {
  switch (s.kind) {
    case 'rect':
      return ''
    case 'ellipse':
      return ''
    case 'path':
      return nodesD(s.nodes, s.closed)
    case 'text':
      return ''
  }
}

export function artTransform(s: ArtShape): string {
  return s.rotation ? `translate(${n(s.x)} ${n(s.y)}) rotate(${n(s.rotation)})` : `translate(${n(s.x)} ${n(s.y)})`
}

/**
 * Part-local -> board space as a single SVG transform. It composes exactly as
 * `partToBoard` does: mirror local X for a bottom-mounted part, then rotate,
 * then translate — SVG applies the rightmost transform first.
 */
export function partTransform(inst: PartInstance): string {
  const mirror = inst.side === 'bottom' ? ' scale(-1 1)' : ''
  return `translate(${n(inst.x)} ${n(inst.y)}) rotate(${inst.rotation})${mirror}`
}

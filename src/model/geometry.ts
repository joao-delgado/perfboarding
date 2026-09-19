import type { Anchor, PartDef, PartInstance, Rotation, Side, Vec } from './types'

/** Screen pixels per hole at zoom 1. 0.1in pitch shown at a comfortable size. */
export const PITCH_PX = 26
/** Hole (drill) radius in hole units — Fritzing punches 0.035in on a 0.1in pitch. */
export const HOLE_R = 0.155
/** Copper pad outer radius in hole units (0.075in OD). */
export const PAD_R = 0.32
/** 0.1 inch pitch. Every millimetre anywhere in the app comes from this one number. */
export const MM_PER_HOLE = 25.4 / 10

export function rotatePoint(p: Vec, r: Rotation): Vec {
  switch (r) {
    case 90:
      return { x: -p.y, y: p.x }
    case 180:
      return { x: -p.x, y: -p.y }
    case 270:
      return { x: p.y, y: -p.x }
    default:
      return { x: p.x, y: p.y }
  }
}

/**
 * Part-local point -> board coordinates.
 *
 * A part mounted on the bottom is mirrored in its own local X before rotating,
 * because you are looking at its underside. Its pins still pass through the
 * same holes, which is what makes both-sides assembly work at all.
 */
export function partToBoard(p: Vec, inst: PartInstance): Vec {
  const local = inst.side === 'bottom' ? { x: -p.x, y: p.y } : p
  const r = rotatePoint(local, inst.rotation)
  return { x: inst.x + r.x, y: inst.y + r.y }
}

/** Inverse of partToBoard, for hit-testing in part-local space. */
export function boardToPart(p: Vec, inst: PartInstance): Vec {
  const d = { x: p.x - inst.x, y: p.y - inst.y }
  const inv = ((360 - inst.rotation) % 360) as Rotation
  const r = rotatePoint(d, inv)
  return inst.side === 'bottom' ? { x: -r.x, y: r.y } : r
}

export function partPinPositions(def: PartDef, inst: PartInstance): Map<string, Vec> {
  const out = new Map<string, Vec>()
  for (const pin of def.pins) out.set(pin.id, partToBoard(pin, inst))
  return out
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function boundsOf(points: Vec[]): Bounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
}

export function pointInPolygon(pt: Vec, poly: Vec[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Round to the nearest hole. Snapping a uniform lattice is arithmetic, not search. */
export function snapToHole(p: Vec): Vec {
  return { x: Math.round(p.x), y: Math.round(p.y) }
}

export function snapToStep(p: Vec, step: number): Vec {
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step }
}

export function holeInBoard(p: Vec, cols: number, rows: number): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows && Number.isInteger(p.x) && Number.isInteger(p.y)
}

/**
 * Constrain `to` onto the nearest of the 8 compass directions from `from`.
 * This is Fritzing's calcConstraint: build the candidate lines, project onto
 * the closest one. Shift-drag uses it for both wires and parts.
 */
export function constrain8(from: Vec, to: Vec): Vec {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const candidates: Vec[] = [
    { x: to.x, y: from.y },
    { x: from.x, y: to.y },
  ]
  const d = (dx + dy) / 2
  candidates.push({ x: from.x + d, y: from.y + d })
  const e = (dx - dy) / 2
  candidates.push({ x: from.x + e, y: from.y - e })

  let best = candidates[0]
  let bestDist = Infinity
  for (const c of candidates) {
    const dist = Math.hypot(c.x - to.x, c.y - to.y)
    if (dist < bestDist) {
      bestDist = dist
      best = c
    }
  }
  return best
}

/**
 * Soft orthogonal assist: if the segment is already within `tolDeg` of an
 * axis or a 45, pull it exactly onto it. Free angles otherwise.
 */
export function orthoAssist(from: Vec, to: Vec, tolDeg = 7): Vec {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return to
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI
  const nearest = Math.round(ang / 45) * 45
  if (Math.abs(ang - nearest) > tolDeg) return to
  return constrain8(from, to)
}

export function anchorPos(
  a: Anchor,
  pinLookup: (partId: string, pinId: string) => Vec | undefined,
): Vec | undefined {
  if (a.kind === 'hole' || a.kind === 'free') return { x: a.x, y: a.y }
  return pinLookup(a.partId, a.pinId)
}

export function sameAnchor(a: Anchor, b: Anchor): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'pin' && b.kind === 'pin') return a.partId === b.partId && a.pinId === b.pinId
  if (a.kind !== 'pin' && b.kind !== 'pin') return a.x === b.x && a.y === b.y
  return false
}

export function otherSide(s: Side): Side {
  return s === 'top' ? 'bottom' : 'top'
}

function orient(a: Vec, b: Vec, c: Vec): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

export function segmentsIntersect(p1: Vec, p2: Vec, p3: Vec, p4: Vec): boolean {
  const d1 = orient(p3, p4, p1)
  const d2 = orient(p3, p4, p2)
  const d3 = orient(p1, p2, p3)
  const d4 = orient(p1, p2, p4)
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
}

export function pointInBounds(p: Vec, b: Bounds): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
}

/** Marquee test for a polyline segment: touching the box counts, as in every
 *  other editor's intersect-style rubber band. */
export function segmentIntersectsBounds(a: Vec, b: Vec, r: Bounds): boolean {
  if (pointInBounds(a, r) || pointInBounds(b, r)) return true
  const tl = { x: r.minX, y: r.minY }
  const tr = { x: r.maxX, y: r.minY }
  const br = { x: r.maxX, y: r.maxY }
  const bl = { x: r.minX, y: r.maxY }
  return (
    segmentsIntersect(a, b, tl, tr) ||
    segmentsIntersect(a, b, tr, br) ||
    segmentsIntersect(a, b, br, bl) ||
    segmentsIntersect(a, b, bl, tl)
  )
}

/** Normalised box from two dragged corners. */
export function boundsFromCorners(a: Vec, b: Vec): Bounds {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  }
}

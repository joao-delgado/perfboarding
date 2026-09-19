/**
 * Shape geometry for part bodies and part artwork.
 *
 * Two families live here and they are deliberately different:
 *
 *  - `OutlineShape` is BODY geometry. Its coordinates are part-local hole
 *    units, snapped to half-hole steps, and it carries no transform of its
 *    own — moving a body shape rewrites its points. Bodies must stay on the
 *    lattice, so there is nowhere for a free rotation to hide.
 *
 *  - `ArtShape` is DECORATION. It carries `x`/`y`/`rotation` and is free of
 *    the grid entirely. Every kind is authored so its local origin is its
 *    rotation centre, which is what lets the transform be a plain
 *    `translate(x,y) rotate(r)` everywhere it is drawn.
 *
 * No rendering concerns: this module never emits SVG. Path `d` strings are
 * built in `ui/svgPath.ts`.
 */

import * as pc from 'polygon-clipping'
import { boundsOf, type Bounds, distToSegment, partToBoard, pointInPolygon } from './geometry'
import { uid } from './ids'
import type {
  ArtShape,
  Artwork,
  Outline,
  OutlineShape,
  PartDef,
  PartInstance,
  PathNode,
  Project,
  Vec,
} from './types'

/** Samples per curved segment. Enough for mm readouts and footprint boxes. */
const CURVE_STEPS = 16
/** Default thickness of a shape drawn with the Line tool, in hole units. */
export const DEFAULT_LINE_WIDTH = 0.3

// ---------------------------------------------------------------- path maths

function cubicAt(p0: Vec, c1: Vec, c2: Vec, p1: Vec, t: number): Vec {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  }
}

/** True when the segment leaving `a` for `b` is curved rather than straight. */
export function segmentIsCurved(a: PathNode, b: PathNode): boolean {
  return !!a.hOut || !!b.hIn
}

export function segmentControls(a: PathNode, b: PathNode): [Vec, Vec] {
  return [a.hOut ?? { x: a.x, y: a.y }, b.hIn ?? { x: b.x, y: b.y }]
}

/** Polyline approximation of a node path. The first point is `nodes[0]`. */
export function samplePath(nodes: PathNode[], closed: boolean, steps = CURVE_STEPS): Vec[] {
  if (nodes.length === 0) return []
  const out: Vec[] = [{ x: nodes[0].x, y: nodes[0].y }]
  const last = closed ? nodes.length : nodes.length - 1
  for (let i = 0; i < last; i++) {
    const a = nodes[i]
    const b = nodes[(i + 1) % nodes.length]
    if (!segmentIsCurved(a, b)) {
      out.push({ x: b.x, y: b.y })
      continue
    }
    const [c1, c2] = segmentControls(a, b)
    for (let s = 1; s <= steps; s++) out.push(cubicAt(a, c1, c2, b, s / steps))
  }
  return out
}

/** Reverse a node path's direction, swapping each node's handles with it. */
export function reverseNodes(nodes: PathNode[]): PathNode[] {
  return [...nodes].reverse().map((n) => ({ x: n.x, y: n.y, hIn: n.hOut, hOut: n.hIn }))
}

export function node(x: number, y: number): PathNode {
  return { x, y }
}

export function mapNodes(nodes: PathNode[], f: (p: Vec) => Vec): PathNode[] {
  return nodes.map((n) => {
    const p = f(n)
    const out: PathNode = { x: p.x, y: p.y }
    if (n.hIn) out.hIn = f(n.hIn)
    if (n.hOut) out.hOut = f(n.hOut)
    return out
  })
}

// ------------------------------------------------------------ outline shapes

export function makeOutlinePath(nodes: PathNode[], closed: boolean): OutlineShape {
  return { id: uid('sh'), kind: 'path', nodes, closed }
}

export function makeOutlineRect(x: number, y: number, w: number, h: number): OutlineShape {
  return { id: uid('sh'), kind: 'rect', x, y, w, h }
}

export function makeOutlineEllipse(cx: number, cy: number, rx: number, ry: number): OutlineShape {
  return { id: uid('sh'), kind: 'ellipse', cx, cy, rx, ry }
}

/** Convenience for seed parts and migration: a closed straight-sided polygon. */
export function polygonShape(points: Vec[]): OutlineShape {
  return makeOutlinePath(points.map((p) => node(p.x, p.y)), true)
}

/**
 * The four corners of a thin rectangle from `p0` to `p1`, `width` wide. This
 * is the whole of what the "Line" tool draws — a lead is not a stroked
 * special case, it is a shape exactly like a rect or a circle.
 */
export function lineNodes(p0: Vec, p1: Vec, width: number): PathNode[] {
  const dx = p1.x - p0.x
  const dy = p1.y - p0.y
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * (width / 2)
  const ny = (dx / len) * (width / 2)
  return [
    node(p0.x + nx, p0.y + ny),
    node(p1.x + nx, p1.y + ny),
    node(p1.x - nx, p1.y - ny),
    node(p0.x - nx, p0.y - ny),
  ]
}

export function makeOutlineLine(p0: Vec, p1: Vec, width = DEFAULT_LINE_WIDTH): OutlineShape {
  return { id: uid('sh'), name: 'Line', kind: 'path', nodes: lineNodes(p0, p1, width), closed: true }
}

export function outlineShapeLabel(s: OutlineShape): string {
  if (s.name) return s.name
  if (s.kind === 'rect') return 'Rectangle'
  if (s.kind === 'ellipse') return s.rx === s.ry ? 'Circle' : 'Ellipse'
  return 'Path'
}

export function sampleOutlineShape(s: OutlineShape, steps = CURVE_STEPS): Vec[] {
  if (s.kind === 'rect') {
    return [
      { x: s.x, y: s.y },
      { x: s.x + s.w, y: s.y },
      { x: s.x + s.w, y: s.y + s.h },
      { x: s.x, y: s.y + s.h },
    ]
  }
  if (s.kind === 'ellipse') {
    const out: Vec[] = []
    const n = Math.max(8, steps * 2)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      out.push({ x: s.cx + Math.cos(a) * s.rx, y: s.cy + Math.sin(a) * s.ry })
    }
    return out
  }
  return samplePath(s.nodes, s.closed, steps)
}

export function sampleOutline(o: Outline, steps = CURVE_STEPS): Vec[] {
  const out: Vec[] = []
  for (const s of o.shapes) {
    if (s.hidden) continue
    out.push(...sampleOutlineShape(s, steps))
  }
  return out
}

export function outlineShapeBounds(s: OutlineShape): Bounds {
  if (s.kind === 'rect') {
    return { minX: Math.min(s.x, s.x + s.w), minY: Math.min(s.y, s.y + s.h), maxX: Math.max(s.x, s.x + s.w), maxY: Math.max(s.y, s.y + s.h) }
  }
  if (s.kind === 'ellipse') {
    return { minX: s.cx - s.rx, minY: s.cy - s.ry, maxX: s.cx + s.rx, maxY: s.cy + s.ry }
  }
  return boundsOf(samplePath(s.nodes, s.closed))
}

export function outlineBounds(o: Outline): Bounds {
  const pts = sampleOutline(o)
  return boundsOf(pts)
}

/** Board-space boundary points of a placed part, for footprints and hit tests. */
export function partOutlinePoints(def: PartDef, inst: PartInstance): Vec[] {
  return sampleOutline(def.outline).map((p) => partToBoard(p, inst))
}

export function outlineIsEmpty(o: Outline): boolean {
  return o.shapes.filter((s) => !s.subtract).length === 0
}

/**
 * The real geometric union of every added shape, minus every subtracted one.
 *
 * This is what makes overlapping shapes look like ONE body: two raw polygons
 * concatenated into one `d` still stroke each other's edges wherever they
 * overlap (SVG strokes the geometry it is given, not the visible silhouette),
 * so the only way to get a clean single outline is to actually compute it.
 * Curves are flattened to their sampled polyline first — `polygon-clipping`
 * only knows straight edges — which is the same precision `sampleOutlineShape`
 * already uses for hit-testing, so nothing here is less exact than what the
 * editor already treats as "the shape".
 *
 * Returns polygons as `[outerRing, ...holeRings]`, hole windings included;
 * render with `fill-rule="evenodd"` so the winding polygon-clipping happens
 * to produce is never something callers need to know about.
 */
export function outlineUnion(o: Outline): Vec[][][] {
  const ring = (s: OutlineShape): pc.Ring => sampleOutlineShape(s).map((p) => [p.x, p.y])
  const adds: pc.Polygon[] = []
  const subs: pc.Polygon[] = []
  for (const s of o.shapes) {
    if (s.hidden) continue
    ;(s.subtract ? subs : adds).push([ring(s)])
  }
  if (adds.length === 0) return []
  let result: pc.MultiPolygon
  try {
    result = adds.length === 1 && subs.length === 0 ? adds : pc.union(adds[0], ...adds.slice(1))
    if (subs.length) result = pc.difference(result, subs[0], ...subs.slice(1))
  } catch {
    // A degenerate input (a zero-area sliver mid-drag) can make the clipping
    // library throw. Falling back to the raw shapes for one frame is far
    // less jarring than the body vanishing.
    result = adds
  }
  return result.map((poly) => poly.map((r) => r.map(([x, y]) => ({ x, y }))))
}

/**
 * Fillet every corner of a closed ring, returning it as a node path.
 *
 * Each corner is trimmed back along both of its edges by `t = r / tan(phi/2)`
 * (`phi` = the interior angle) and the gap bridged with the cubic that best
 * approximates the circular arc — handle length `(4/3) r tan(alpha/4)` along
 * the edge tangents, which is exactly Bezier's 0.5523 r at 90 degrees.
 *
 * `t` is clamped to half of each adjacent edge, so neighbouring corners can
 * never eat into one another: on a ring that is already a flattened curve the
 * edges are short, the clamp bites, and the curve is left as it was. That is
 * what lets one radius be applied to a whole union without knowing which of
 * its corners came from a rectangle and which from a circle.
 */
export function roundRing(raw: Vec[], radius: number): PathNode[] {
  // Drop repeated points, wrap-around included: polygon-clipping closes its
  // rings by repeating the first point, and a duplicate at the seam would
  // otherwise read as a zero-length edge and lose that corner.
  const ring = raw.filter((p, i) => {
    const q = raw[(i - 1 + raw.length) % raw.length]
    return i === 0 || Math.hypot(p.x - q.x, p.y - q.y) > 1e-9
  })
  if (ring.length > 1) {
    const first = ring[0]
    const last = ring[ring.length - 1]
    if (Math.hypot(first.x - last.x, first.y - last.y) <= 1e-9) ring.pop()
  }
  const n = ring.length
  if (radius <= 1e-6 || n < 3) return ring.map((p) => node(p.x, p.y))
  const out: PathNode[] = []
  for (let i = 0; i < n; i++) {
    const v = ring[i]
    const prev = ring[(i - 1 + n) % n]
    const next = ring[(i + 1) % n]
    const ax = prev.x - v.x
    const ay = prev.y - v.y
    const bx = next.x - v.x
    const by = next.y - v.y
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    // A duplicated point has no corner to round; dropping it also keeps the
    // neighbours' clamps honest.
    if (la < 1e-9 || lb < 1e-9) continue
    const ua = { x: ax / la, y: ay / la }
    const ub = { x: bx / lb, y: by / lb }
    const phi = Math.acos(Math.max(-1, Math.min(1, ua.x * ub.x + ua.y * ub.y)))
    // Collinear (nothing to round) or a zero-width spike (rounding it would
    // fold the path back through itself).
    if (phi > Math.PI - 1e-4 || phi < 1e-4) {
      out.push(node(v.x, v.y))
      continue
    }
    const half = Math.tan(phi / 2)
    const t = Math.min(radius / half, la / 2, lb / 2)
    const r = t * half
    const h = (4 / 3) * r * Math.tan((Math.PI - phi) / 4)
    const p1 = { x: v.x + ua.x * t, y: v.y + ua.y * t }
    const p2 = { x: v.x + ub.x * t, y: v.y + ub.y * t }
    out.push({ ...p1, hOut: { x: p1.x - ua.x * h, y: p1.y - ua.y * h } })
    out.push({ ...p2, hIn: { x: p2.x - ub.x * h, y: p2.y - ub.y * h } })
  }
  return out
}

export function translateOutlineShape(s: OutlineShape, d: Vec): OutlineShape {
  if (s.kind === 'rect') return { ...s, x: s.x + d.x, y: s.y + d.y }
  if (s.kind === 'ellipse') return { ...s, cx: s.cx + d.x, cy: s.cy + d.y }
  return { ...s, nodes: mapNodes(s.nodes, (p) => ({ x: p.x + d.x, y: p.y + d.y })) }
}

/** Refit a body shape into a new bounding box, as a resize handle drag does. */
export function setOutlineShapeBox(s: OutlineShape, box: Bounds): OutlineShape {
  const b = outlineShapeBounds(s)
  const bw = b.maxX - b.minX
  const bh = b.maxY - b.minY
  const nw = box.maxX - box.minX
  const nh = box.maxY - box.minY
  if (s.kind === 'rect') return { ...s, x: box.minX, y: box.minY, w: nw, h: nh }
  if (s.kind === 'ellipse') {
    return { ...s, cx: box.minX + nw / 2, cy: box.minY + nh / 2, rx: nw / 2, ry: nh / 2 }
  }
  const kx = bw > 1e-6 ? nw / bw : 1
  const ky = bh > 1e-6 ? nh / bh : 1
  return {
    ...s,
    nodes: mapNodes(s.nodes, (p) => ({
      x: box.minX + (p.x - b.minX) * kx,
      y: box.minY + (p.y - b.minY) * ky,
    })),
  }
}

/** Hit test in part-local units: inside the shape, or close to one of its edges. */
export function outlineShapeHit(s: OutlineShape, p: Vec, tol: number): boolean {
  const pts = sampleOutlineShape(s)
  if (pts.length === 0) return false
  if (pointInPolygon(p, pts)) return true
  for (let i = 0; i < pts.length; i++) {
    if (distToSegment(p, pts[i], pts[(i + 1) % pts.length]) <= tol) return true
  }
  return false
}

// --------------------------------------------------------------- art shapes

/**
 * Character advance as a fraction of the font size, used to estimate a text
 * box when nothing has measured the real one. The part editor measures the
 * rendered `<text>` and passes the result in; everything else lives with the
 * estimate, which only ever drives selection UI, never rendering.
 */
const TEXT_ADVANCE = 0.55
const TEXT_LINE = 1.15

function rotVec(p: Vec, deg: number): Vec {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/** Local -> part-local coordinates for one art shape. */
export function artToPart(s: ArtShape, p: Vec): Vec {
  const r = rotVec(p, s.rotation)
  return { x: s.x + r.x, y: s.y + r.y }
}

/** Part-local -> that art shape's own local coordinates. */
export function partToArt(s: ArtShape, p: Vec): Vec {
  return rotVec({ x: p.x - s.x, y: p.y - s.y }, -s.rotation)
}

export function artLocalBounds(s: ArtShape, measured?: Bounds): Bounds {
  switch (s.kind) {
    case 'rect':
      return { minX: -s.w / 2, minY: -s.h / 2, maxX: s.w / 2, maxY: s.h / 2 }
    case 'ellipse':
      return { minX: -s.rx, minY: -s.ry, maxX: s.rx, maxY: s.ry }
    case 'path': {
      const b = boundsOf(samplePath(s.nodes, s.closed))
      // A one-node path has no extent; give the handles something to grab.
      if (b.maxX - b.minX < 1e-6 && b.maxY - b.minY < 1e-6) {
        return { minX: b.minX - 0.1, minY: b.minY - 0.1, maxX: b.maxX + 0.1, maxY: b.maxY + 0.1 }
      }
      return b
    }
    case 'text': {
      if (measured) return measured
      const w = Math.max(1, s.text.length) * s.fontSize * TEXT_ADVANCE
      const h = s.fontSize * TEXT_LINE
      const minX = s.align === 'start' ? 0 : s.align === 'middle' ? -w / 2 : -w
      return { minX, minY: -h / 2, maxX: minX + w, maxY: h / 2 }
    }
  }
}

/** The four corners of an art shape's local box, in part-local coordinates. */
export function artCorners(s: ArtShape, measured?: Bounds): Vec[] {
  const b = artLocalBounds(s, measured)
  return [
    artToPart(s, { x: b.minX, y: b.minY }),
    artToPart(s, { x: b.maxX, y: b.minY }),
    artToPart(s, { x: b.maxX, y: b.maxY }),
    artToPart(s, { x: b.minX, y: b.maxY }),
  ]
}

export function artBounds(s: ArtShape, measured?: Bounds): Bounds {
  return boundsOf(artCorners(s, measured))
}

/** Part-local sample points of an art shape's actual geometry, for hit tests. */
export function artSamples(s: ArtShape, measured?: Bounds): Vec[] {
  if (s.kind === 'path') return samplePath(s.nodes, s.closed).map((p) => artToPart(s, p))
  if (s.kind === 'ellipse') {
    const out: Vec[] = []
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2
      out.push(artToPart(s, { x: Math.cos(a) * s.rx, y: Math.sin(a) * s.ry }))
    }
    return out
  }
  return artCorners(s, measured)
}

export function artHit(s: ArtShape, p: Vec, tol: number, measured?: Bounds): boolean {
  const pts = artSamples(s, measured)
  if (pts.length === 0) return false
  const filled = s.kind !== 'path' || s.closed
  if (filled && pointInPolygon(p, pts)) return true
  const last = filled ? pts.length : pts.length - 1
  const reach = Math.max(tol, s.strokeWidth / 2)
  for (let i = 0; i < last; i++) {
    if (distToSegment(p, pts[i], pts[(i + 1) % pts.length]) <= reach) return true
  }
  return false
}

/**
 * Put a path shape's nodes back around its own origin, moving `x`/`y` to
 * compensate. Every art shape's origin must stay its bounding-box centre or
 * rotation would drift, so this runs after any node edit.
 */
export function recentreArt(s: ArtShape): ArtShape {
  if (s.kind !== 'path') return s
  const b = boundsOf(samplePath(s.nodes, s.closed))
  const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
  if (Math.abs(c.x) < 1e-9 && Math.abs(c.y) < 1e-9) return s
  const moved = artToPart(s, c)
  return {
    ...s,
    x: moved.x,
    y: moved.y,
    nodes: mapNodes(s.nodes, (p) => ({ x: p.x - c.x, y: p.y - c.y })),
  }
}

/**
 * Refit an art shape so its local bounding box becomes `box` (expressed in the
 * shape's CURRENT local frame), keeping the rest of the frame fixed. Used by
 * every resize handle.
 */
export function setArtLocalBox(s: ArtShape, box: Bounds, measured?: Bounds): ArtShape {
  const b = artLocalBounds(s, measured)
  const bw = b.maxX - b.minX
  const bh = b.maxY - b.minY
  const nw = Math.max(0.02, box.maxX - box.minX)
  const nh = Math.max(0.02, box.maxY - box.minY)
  const newCentre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }

  // After the resize, where does the shape's own box centre sit in local
  // coordinates? Zero for anything we re-centre; proportional for text, whose
  // origin is its anchor rather than its middle.
  let centreAfter: Vec = { x: 0, y: 0 }
  let next: ArtShape

  switch (s.kind) {
    case 'rect':
      next = { ...s, w: nw, h: nh }
      break
    case 'ellipse':
      next = { ...s, rx: nw / 2, ry: nh / 2 }
      break
    case 'path': {
      const kx = bw > 1e-6 ? nw / bw : 1
      const ky = bh > 1e-6 ? nh / bh : 1
      next = {
        ...s,
        nodes: mapNodes(s.nodes, (p) => ({ x: (p.x - b.minX) * kx - nw / 2, y: (p.y - b.minY) * ky - nh / 2 })),
      }
      break
    }
    case 'text': {
      const k = bh > 1e-6 ? nh / bh : 1
      next = { ...s, fontSize: Math.max(0.05, s.fontSize * k) }
      centreAfter = { x: ((b.minX + b.maxX) / 2) * k, y: ((b.minY + b.maxY) / 2) * k }
      break
    }
  }

  const shift = rotVec({ x: newCentre.x - centreAfter.x, y: newCentre.y - centreAfter.y }, s.rotation)
  return { ...next, x: s.x + shift.x, y: s.y + shift.y }
}

let artCounter = 0

function artBase(name: string, x: number, y: number, fill: string, stroke: string): Omit<ArtShape & { kind: 'rect' }, 'kind' | 'w' | 'h' | 'radius'> {
  artCounter += 1
  return {
    id: uid('art'),
    name: `${name} ${artCounter}`,
    x,
    y,
    rotation: 0,
    opacity: 1,
    fill,
    stroke,
    strokeWidth: 0.06,
  }
}

export function makeArtRect(x: number, y: number, w: number, h: number, fill: string, stroke: string): ArtShape {
  return { ...artBase('Rect', x, y, fill, stroke), kind: 'rect', w, h, radius: 0 }
}

export function makeArtEllipse(x: number, y: number, rx: number, ry: number, fill: string, stroke: string): ArtShape {
  return { ...artBase('Ellipse', x, y, fill, stroke), kind: 'ellipse', rx, ry }
}

export function makeArtPath(nodes: PathNode[], closed: boolean, fill: string, stroke: string): ArtShape {
  return { ...artBase(closed ? 'Path' : 'Line', 0, 0, closed ? fill : 'none', stroke), kind: 'path', nodes, closed }
}

export function makeArtText(x: number, y: number, text: string, fill: string): ArtShape {
  return {
    ...artBase('Text', x, y, fill, 'none'),
    kind: 'text',
    text,
    fontSize: 0.5,
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    bold: false,
    italic: false,
    align: 'middle',
    strokeWidth: 0,
  }
}

export function emptyArtwork(): Artwork {
  return { shapes: [], clipToOutline: true }
}

// ---------------------------------------------------------------- migration

interface LegacyOutline {
  points?: Vec[]
  closed?: boolean
  shapes?: OutlineShape[]
}

/** Documents written before multi-shape outlines carried one polygon. */
export function migrateOutline(raw: unknown): Outline {
  const o = (raw ?? {}) as LegacyOutline
  if (Array.isArray(o.shapes)) return { shapes: o.shapes }
  if (Array.isArray(o.points) && o.points.length > 0) {
    return { shapes: [polygonShape(o.points)] }
  }
  return { shapes: [] }
}

export function normalizeDef(def: PartDef): PartDef {
  const outline = migrateOutline(def.outline)
  if (outline === def.outline) return def
  return { ...def, outline }
}

/** Bring every part definition in a loaded document up to the current shape model. */
export function normalizeProject(project: Project): Project {
  const defs: Record<string, PartDef> = {}
  for (const [id, def] of Object.entries(project.defs ?? {})) defs[id] = normalizeDef(def)
  return { ...project, defs }
}

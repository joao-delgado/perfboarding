/**
 * The project as solid geometry.
 *
 * THE FRAME. The document is 2D hole units with y running DOWN the screen.
 * This module maps that onto three.js's y-up world as:
 *
 *     world.x = board.x      world.z = board.y      world.y = UP, out of the
 *                                                   board's TOP face
 *
 * so one hole is one world unit in x and z, and the only thing ever converted
 * is a height (`model/solid.ts` keeps those in mm, because that is how a
 * datasheet quotes them). Nothing here invents a second coordinate space: a
 * part's board position is read straight out of the model.
 *
 * The board plane is y = 0; the substrate straddles it, so the top face is at
 * +T/2 and the bottom face at -T/2. A part mounted on the bottom extrudes
 * DOWNWARD from the bottom face, which is what lets you see both sides at
 * once — the entire point of this view.
 *
 * Nothing in here touches the store or React. `buildWorld` takes a project and
 * returns a disposable group, so the renderer can throw the whole thing away
 * and rebuild on any document change.
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { anchorPos, type Bounds, partPinPositions } from '../model/geometry'
import { boardExtent, boardStripGeoms, stripSpanCells } from '../model/pads'
import { boardAt, contentBounds } from '../model/project'
import { outlineBounds, outlineUnion, roundRing, samplePath } from '../model/shapes'
import {
  BOARD_THICKNESS_MM,
  mmToHoles,
  partHeightMm,
  PIN_DIAMETER_MM,
  PIN_PROTRUSION_MM,
  WIRE_DIAMETER_MM,
} from '../model/solid'
import type { Hidden } from '../model/visibility'
import type {
  Anchor,
  Board,
  PartDef,
  PartInstance,
  Project,
  Rotation,
  Side,
  Vec,
  Wire,
} from '../model/types'
import { bandTexture, latticeTexture, padTexture } from './textures'

/** Board thickness in hole units. */
export const BOARD_T = mmToHoles(BOARD_THICKNESS_MM)
const HALF_T = BOARD_T / 2
const WIRE_R = mmToHoles(WIRE_DIAMETER_MM) / 2
const PIN_R = mmToHoles(PIN_DIAMETER_MM) / 2
const PIN_OUT = mmToHoles(PIN_PROTRUSION_MM)

/**
 * Lift the copper planes clear of the substrate. 0.025mm — far too small to
 * see, and on its own far too small to beat depth quantisation, which is why
 * the copper material also carries a polygon offset. See `copperPlane`.
 */
const SURFACE_EPS = 0.01

/** Minimum extrusion, so a part given a silly height is still a solid. */
const MIN_HEIGHT = 0.02

const SELECT_COLOR = 0x1e88e5

/** What a picked mesh means. Parked on `Object3D.userData`. */
export interface Pick {
  kind: 'part' | 'wire' | 'board'
  id: string
}

export interface World {
  root: THREE.Group
  /** Everything the raycaster should consider, flat — no recursion needed. */
  pickables: THREE.Object3D[]
  /** Light up a selection without rebuilding a single triangle. */
  highlight(parts: string[], wires: string[], boards: string[]): void
  dispose(): void
}

type Tracked = { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] }

function deg(r: Rotation): number {
  return (r * Math.PI) / 180
}

/** The substrate rect, matching `BoardSurface` so 2D and 3D agree to the mm. */
export function boardRect(board: Board): { x0: number; y0: number; w: number; h: number } {
  const e = boardExtent(board)
  return { x0: e.minX - 0.6, y0: e.minY - 0.6, w: e.maxX - e.minX + 1.2, h: e.maxY - e.minY + 1.2 }
}

/**
 * The filleted silhouette rings of a part body, in part-local hole units.
 * Same source as the 2D `outlineFillD`, so the extrusion is the shape you drew.
 */
function outlineRings(def: PartDef): Vec[][][] {
  const radius = def.outline.cornerRadius ?? 0
  return outlineUnion(def.outline).map((poly) =>
    poly.map((ring) => (radius > 0 ? samplePath(roundRing(ring, radius), true) : ring)),
  )
}

/**
 * The body as extrudable shapes.
 *
 * `mirror` negates part-local x for a bottom-mounted part — the same mirror
 * `partToBoard` applies, done to the GEOMETRY rather than as a negative mesh
 * scale, because a negative scale flips triangle winding and the lighting with
 * it. `-y` puts shape space the right way round for the mesh rotation in
 * `addPart`, which is the one place the frame is nailed down.
 */
function partShapes(def: PartDef, mirror: boolean): THREE.Shape[] {
  const sx = mirror ? -1 : 1
  // A bottom part is rotated the other way about x (see addPart), so its
  // shape-space y must not be flipped or the body would land mirrored in z.
  const sy = mirror ? 1 : -1
  const out: THREE.Shape[] = []
  for (const poly of outlineRings(def)) {
    if (poly.length === 0 || poly[0].length < 3) continue
    const toPath = (ring: Vec[]) => {
      const path = new THREE.Path()
      path.moveTo(ring[0].x * sx, ring[0].y * sy)
      for (let i = 1; i < ring.length; i++) path.lineTo(ring[i].x * sx, ring[i].y * sy)
      path.closePath()
      return path
    }
    const shape = new THREE.Shape(toPath(poly[0]).getPoints(0))
    for (let i = 1; i < poly.length; i++) {
      if (poly[i].length >= 3) shape.holes.push(toPath(poly[i]))
    }
    out.push(shape)
  }
  return out
}

/**
 * Map the baked artwork texture onto the extruded cap.
 *
 * ExtrudeGeometry's default UVs for a cap are the raw shape coordinates, so
 * the whole mapping is one repeat/offset pair rather than a custom generator.
 * The texture is rendered over the body's part-local bounding box, v up.
 */
function capTexture(src: THREE.Texture, def: PartDef, mirror: boolean): THREE.Texture {
  const b: Bounds = outlineBounds(def.outline)
  const w = Math.max(1e-6, b.maxX - b.minX)
  const h = Math.max(1e-6, b.maxY - b.minY)
  const t = src.clone()
  t.needsUpdate = true
  if (mirror) {
    // shape.x = -local.x, shape.y = +local.y
    t.repeat.set(-1 / w, -1 / h)
    t.offset.set(-b.minX / w, 1 + b.minY / h)
  } else {
    // shape.x = +local.x, shape.y = -local.y
    t.repeat.set(1 / w, 1 / h)
    t.offset.set(-b.minX / w, 1 + b.minY / h)
  }
  return t
}

/**
 * Re-group an extrusion so the two caps can take different materials.
 *
 * ExtrudeGeometry emits BOTH lids of a shape as ONE group, which is no use
 * here: the face pointing away from the board carries the part's artwork and
 * the face against it is bare laminate. Within a lid group the z = 0 lid
 * comes first, so one scan for the first vertex at full depth splits it.
 *
 * CRUCIALLY it emits one lid group and one side group PER SHAPE, not per
 * geometry — a part body is one shape per disjoint polygon of its outline, so
 * a resistor (capsule plus two leads) has six groups. Every one of them has to
 * be re-emitted. An earlier version took the first lid and the first side with
 * `.find()` and then called `clearGroups()`, which silently deleted every
 * other polygon of the body: the part rendered as a single stray lead.
 *
 * Leaves material index 0 on the OUTWARD caps, 1 on the walls (both as
 * ExtrudeGeometry had them) and puts the inward caps on a new index 2.
 */
function splitCaps(geom: THREE.ExtrudeGeometry, depth: number): boolean {
  const pos = geom.getAttribute('position')
  const mid = depth / 2
  const regrouped: { start: number; count: number; materialIndex: number }[] = []
  let split = false

  for (const g of geom.groups) {
    const index = g.materialIndex ?? 0
    if (index !== 0 || g.count === 0) {
      regrouped.push({ start: g.start, count: g.count, materialIndex: index })
      continue
    }
    let at = -1
    for (let i = g.start; i < g.start + g.count; i++) {
      if (pos.getZ(i) > mid) {
        at = i
        break
      }
    }
    // A lid group that is all one height (a zero-depth body, or an inward
    // lid that was never emitted) keeps the outward material and is left be.
    if (at <= g.start) {
      regrouped.push({ start: g.start, count: g.count, materialIndex: 0 })
      continue
    }
    regrouped.push({ start: g.start, count: at - g.start, materialIndex: 2 })
    regrouped.push({ start: at, count: g.start + g.count - at, materialIndex: 0 })
    split = true
  }

  if (!split) return false
  geom.clearGroups()
  for (const g of regrouped) geom.addGroup(g.start, g.count, g.materialIndex)
  return true
}

export function buildWorld(
  project: Project,
  hidden: Hidden,
  /** Baked top-face artwork, by def id. Absent means a plain coloured body. */
  partTextures: Map<string, THREE.Texture>,
): World {
  const root = new THREE.Group()
  const pickables: THREE.Object3D[] = []
  const track: Tracked = { geometries: [], materials: [] }
  /** Every material belonging to one selectable object, for highlighting. */
  const owned = new Map<string, THREE.MeshStandardMaterial[]>()
  /** And every mesh, so a selection can be outlined without a rebuild. */
  const meshesOf = new Map<string, THREE.Mesh[]>()
  /** Live outline overlays, torn down on the next highlight call. */
  let outlines: THREE.LineSegments[] = []

  const keep = <T extends THREE.Material>(m: T): T => {
    track.materials.push(m)
    return m
  }
  const own = (kind: Pick['kind'], id: string, m: THREE.MeshStandardMaterial) => {
    const key = `${kind}:${id}`
    const list = owned.get(key)
    if (list) list.push(m)
    else owned.set(key, [m])
    return m
  }
  const outlineMat = new THREE.LineBasicMaterial({
    color: SELECT_COLOR,
    // Drawn over whatever it outlines: the cage is a UI affordance, not a
    // solid, and a half-occluded one reads as a rendering fault.
    depthTest: false,
    transparent: true,
  })
  outlineMat.toneMapped = false
  track.materials.push(outlineMat)

  const mesh = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[], pick?: Pick) => {
    track.geometries.push(g)
    const o = new THREE.Mesh(g, m)
    if (pick) {
      o.userData.pick = pick
      pickables.push(o)
      const key = `${pick.kind}:${pick.id}`
      const list = meshesOf.get(key)
      if (list) list.push(o)
      else meshesOf.set(key, [o])
    }
    return o
  }

  // ---- boards -------------------------------------------------------------

  for (const board of project.boards) {
    const r = boardRect(board)
    const g = new THREE.Group()
    root.add(g)

    const substrate = keep(
      new THREE.MeshStandardMaterial({ color: board.color, roughness: 0.78, metalness: 0.02 }),
    )
    own('board', board.id, substrate)
    const box = mesh(new THREE.BoxGeometry(r.w, BOARD_T, r.h), substrate, {
      kind: 'board',
      id: board.id,
    })
    box.position.set(r.x0 + r.w / 2, 0, r.y0 + r.h / 2)
    g.add(box)

    // Copper. One plane per face per region, each filled with a repeating
    // tile — a hole is never a mesh, for exactly the reason it is never a DOM
    // node in 2D. Opaque tiles (they paint the substrate colour themselves),
    // so the board needs no transparency anywhere.
    const faces: { side: Side; y: number; rx: number }[] = [
      { side: 'top', y: HALF_T + SURFACE_EPS, rx: -Math.PI / 2 },
      { side: 'bottom', y: -HALF_T - SURFACE_EPS, rx: Math.PI / 2 },
    ]
    const copperPlane = (
      cx: number,
      cz: number,
      w: number,
      h: number,
      tex: THREE.Texture,
      rx: number,
      ry: number,
      face: { y: number; rx: number },
    ) => {
      const t = tex.clone()
      t.needsUpdate = true
      t.repeat.set(rx, ry)
      const m = keep(
        new THREE.MeshStandardMaterial({
          map: t,
          roughness: 0.55,
          metalness: 0.35,
          // The copper is a DECAL on the substrate: two surfaces a hundredth
          // of a millimetre apart, which no depth buffer can separate on its
          // own — the board shimmers as you orbit. A negative polygon offset
          // biases the copper towards the camera in depth space, which is
          // resolution-independent and the standard fix for coplanar decals.
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -4,
        }),
      )
      own('board', board.id, m)
      const p = mesh(new THREE.PlaneGeometry(w, h), m, { kind: 'board', id: board.id })
      p.rotation.x = face.rx
      p.position.set(cx, face.y, cz)
      g.add(p)
    }

    for (const face of faces) {
      const lat = latticeTexture(board.color, board.padColor)
      copperPlane(
        board.x - 0.5 + board.cols / 2,
        board.y - 0.5 + board.rows / 2,
        board.cols,
        board.rows,
        lat,
        board.cols,
        board.rows,
        face,
      )
      for (const strip of boardStripGeoms(board)) {
        const span = stripSpanCells(strip)
        copperPlane(
          strip.originX - 0.5 + span.w / 2,
          strip.originY - 0.5 + span.h / 2,
          span.w,
          span.h,
          padTexture(board.color, board.padColor, strip.vertical),
          strip.vertical ? 1 : strip.count,
          strip.vertical ? strip.count : 1,
          face,
        )
      }
    }
  }

  // ---- parts --------------------------------------------------------------

  /** Lead stubs, merged into one mesh per scene rather than one per pin. */
  const legs: THREE.BufferGeometry[] = []

  for (const inst of project.parts) {
    if (hidden.parts.has(inst.id)) continue
    const def = project.defs[inst.defId]
    if (!def) continue
    addPart(def, inst)
  }

  function addPart(def: PartDef, inst: PartInstance) {
    const bottom = inst.side === 'bottom'
    const depth = Math.max(MIN_HEIGHT, mmToHoles(partHeightMm(def)))
    const shapes = partShapes(def, bottom)

    const holder = new THREE.Group()
    holder.position.set(inst.x, bottom ? -HALF_T : HALF_T, inst.y)
    // The document rotates clockwise in a y-down frame; about the y axis of a
    // y-up frame that is the opposite sign. Verified against `rotatePoint`.
    holder.rotation.y = -deg(inst.rotation)
    root.add(holder)

    if (shapes.length > 0) {
      const geom = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false })
      const body = keep(
        new THREE.MeshStandardMaterial({ color: def.fill, roughness: 0.55, metalness: 0.08 }),
      )
      own('part', inst.id, body)

      const src = partTextures.get(def.id)
      let materials: THREE.Material | THREE.Material[] = body
      if (src) {
        const artworkMat = () => {
          const m = keep(
            new THREE.MeshStandardMaterial({
              map: capTexture(src, def, bottom),
              roughness: 0.55,
              metalness: 0.08,
            }),
          )
          own('part', inst.id, m)
          return m
        }
        // [outward cap, walls, inward cap]. The walls always keep the body
        // colour; the face against the board gets the artwork only if the
        // part says so — see `PartDef.undersideArtwork`.
        //
        // Both caps take the SAME uv mapping, so the underside comes out
        // mirrored. That is deliberate: turning a part over mirrors it, which
        // is the same rule `setPartSide` already follows for a part moved to
        // the other face of the board.
        materials = splitCaps(geom, depth)
          ? [artworkMat(), body, def.undersideArtwork ? artworkMat() : body]
          : [artworkMat(), body]
      }

      const m = mesh(geom, materials, { kind: 'part', id: inst.id })
      // Extrusion runs along local +z; this swings it to world +y for a part
      // on top and world -y for one underneath, and lays the silhouette into
      // the xz plane. See `partShapes` for the matching shape-space flip.
      m.rotation.x = bottom ? Math.PI / 2 : -Math.PI / 2
      holder.add(m)
    }

    // Leads. A pin over a board passes through it and pokes out the far side.
    // A pin off every board draws nothing: a panel part or a module on flying
    // leads is wired to, not soldered into anything, so a stub there was a
    // lead hanging in mid-air under the body.
    for (const pos of partPinPositions(def, inst).values()) {
      if (!boardAt(project, pos.x, pos.y)) continue
      const from = bottom ? -HALF_T : HALF_T
      const to = bottom ? HALF_T + PIN_OUT : -HALF_T - PIN_OUT
      const len = Math.abs(to - from)
      const leg = new THREE.CylinderGeometry(PIN_R, PIN_R, len, 8)
      leg.translate(pos.x, (from + to) / 2, pos.y)
      legs.push(leg)
    }
  }

  if (legs.length > 0) {
    const merged = mergeGeometries(legs, false)
    for (const g of legs) g.dispose()
    if (merged) {
      const m = keep(
        new THREE.MeshStandardMaterial({ color: '#b9bcc2', roughness: 0.35, metalness: 0.85 }),
      )
      root.add(mesh(merged, m))
    }
  }

  // ---- wires --------------------------------------------------------------

  const pinAt = (partId: string, pinId: string): Vec | undefined => {
    const inst = project.parts.find((p) => p.id === partId)
    if (!inst) return undefined
    const def = project.defs[inst.defId]
    if (!def) return undefined
    return partPinPositions(def, inst).get(pinId)
  }

  // Flat (2D) runs first, in paint order, so crossings can be resolved before
  // any geometry is built.
  const runs: Run[] = []
  project.wires.forEach((w, order) => {
    if (hidden.wires.has(w.id)) return
    const a = anchorPos(w.from, pinAt)
    const b = anchorPos(w.to, pinAt)
    if (!a || !b) return
    const flat = [a, ...w.waypoints, b]
    runs.push({ w, order, flat, cum: cumulative(flat), bridges: [] })
  })
  resolveCrossings(runs)

  for (const run of runs) addWire(run)

  /**
   * Does this end dive into the board, or stop where it is?
   *
   * Only an end over an actual board has a hole to go into. A pin of an
   * OFF-board part — a panel switch, a battery, a button on a flying lead —
   * has nothing underneath it, so plunging sent the wire curling down past
   * the component to the empty board plane instead of into it. Stopping at
   * ride height instead puts the tube end inside the part's own body, which
   * is what "the wire goes into the button" looks like. A free end never
   * plunges either: it is a deliberate dangling lead.
   */
  function plunges(anchor: Anchor, at: Vec): boolean {
    if (anchor.kind === 'free') return false
    return !!boardAt(project, Math.round(at.x), Math.round(at.y))
  }

  function addWire(run: Run) {
    const { w, flat } = run
    const a = flat[0]
    const b = flat[flat.length - 1]

    // The run rides at its own radius above the face it belongs to, so it
    // sits ON the board the way the 2D polyline says it does. Each end that
    // is in a hole then drops into the board; a free end — a lead going
    // off-board — has nothing to drop into and stays at height.
    const sign = w.side === 'bottom' ? -1 : 1
    const ride = sign * (HALF_T + WIRE_R)
    const pts = liftedPoints(run, ride, sign)
    if (plunges(w.from, a)) pts.unshift(new THREE.Vector3(a.x, 0, a.y))
    if (plunges(w.to, b)) pts.push(new THREE.Vector3(b.x, 0, b.y))

    const curve = roundedPath(pts, WIRE_R * 1.6)
    if (!curve) return
    const len = curve.getLength()
    // TubeGeometry samples the curve by arc length, so a hard corner only
    // reads as a corner if there are samples close either side of it.
    const segments = Math.max(16, Math.min(900, Math.ceil(len * 14)))
    const geom = new THREE.TubeGeometry(curve, segments, WIRE_R, 10, false)

    const mat = keep(
      new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.3, metalness: 0.05 }),
    )
    own('wire', w.id, mat)
    if (w.banded) {
      // Two-tone jumper: the stripe texture repeats along u, which
      // TubeGeometry runs down the length of the tube.
      const t = bandTexture(w.color)
      t.repeat.set(Math.max(1, Math.round(len / (WIRE_R * 6))), 1)
      mat.map = t
      mat.color.set('#ffffff')
    }
    root.add(mesh(geom, mat, { kind: 'wire', id: w.id }))
  }

  // ---- highlight / dispose ------------------------------------------------

  function highlight(parts: string[], wires: string[], boards: string[]) {
    for (const list of owned.values()) {
      for (const m of list) m.emissive.setHex(0x000000)
    }
    for (const o of outlines) {
      o.removeFromParent()
      o.geometry.dispose()
    }
    outlines = []

    const lit = [
      ...parts.map((id) => `part:${id}`),
      ...wires.map((id) => `wire:${id}`),
      ...boards.map((id) => `board:${id}`),
    ]
    for (const key of lit) {
      // A tint alone is not enough: a blue module tinted blue looks like a
      // blue module. The edge cage is what makes "this one" unambiguous.
      for (const m of owned.get(key) ?? []) {
        m.emissive.setHex(SELECT_COLOR)
        m.emissiveIntensity = key.startsWith('wire:') ? 0.95 : 0.3
      }
      for (const m of meshesOf.get(key) ?? []) {
        // 40 degrees keeps a body's real corners and drops the faceting of a
        // round tube, which would otherwise come back as a cage of seams.
        const edges = new THREE.EdgesGeometry(m.geometry, 40)
        if (edges.getAttribute('position').count === 0) {
          edges.dispose()
          continue
        }
        const line = new THREE.LineSegments(edges, outlineMat)
        line.renderOrder = 999
        // A child of the mesh, so it inherits the whole instance transform
        // and needs no matrix bookkeeping of its own.
        m.add(line)
        outlines.push(line)
      }
    }
  }

  function dispose() {
    for (const o of outlines) o.geometry.dispose()
    outlines = []
    for (const g of track.geometries) g.dispose()
    for (const m of track.materials) {
      const map = (m as THREE.MeshStandardMaterial).map
      // Cloned textures share the cached image; disposing the clone is right
      // and leaves the cache in `textures.ts` intact.
      if (map) map.dispose()
      m.dispose()
    }
    root.clear()
  }

  return { root, pickables, highlight, dispose }
}

/**
 * How far a wire lifts to clear one wire under it, centreline to centreline.
 * 1.4 diameters: a diameter to touch, plus enough air that the rounding at a
 * bridge's shoulder (which cuts inside the corner) never eats into it.
 */
const HOP_STEP = WIRE_R * 2.8

/**
 * The closest two wire centrelines may come anywhere along a bridge — one
 * diameter, plus room for the shoulder fillet and the tube's own faceting.
 */
const CLEARANCE = WIRE_R * 2.4

/** A bridge's ramp runs this far per unit of rise, so it climbs at ~37°. */
const RAMP = 1.3

/**
 * Highest a wire will ever lift. Only a genuine pile-up — three or more wires
 * crossing within a wire's width of the same spot — ever stacks, so this is a
 * backstop against a pathological sketch building a tower, not a budget.
 */
const MAX_LIFT = HOP_STEP * 3

/**
 * Two bridges whose ramps come closer than this become one. Touching down for
 * a few tenths of a hole between two crossings is what made a run over a
 * bundle of parallel wires come out as a row of springs.
 */
const MIN_FLAT = 0.6

/** A junction, not a crossing: this close to either wire's END they are joined. */
const JUNCTION_EPS = 0.3

/**
 * Floor on the sine of a crossing angle. The plateau a crossing needs grows as
 * 1/sin, so a near-parallel pass would otherwise ask for an unbounded bridge.
 */
const MIN_SIN = 0.25

/**
 * One raised stretch of a run: a flat top over [s0, s1] at `lift` above ride
 * height, with ramps of `lift * RAMP` either side. Positions are ARC LENGTH
 * along the flat polyline, so a bridge may run straight through a bend.
 */
interface Bridge {
  s0: number
  s1: number
  lift: number
}

interface Run {
  w: Wire
  order: number
  flat: Vec[]
  /** Arc length at each vertex of `flat`. */
  cum: number[]
  bridges: Bridge[]
}

interface Crossing {
  /** Arc length along the wire going over. */
  s: number
  /** Arc length along the wire underneath. */
  su: number
  /** Sine of the angle between the two, already floored at MIN_SIN. */
  sin: number
}

function cumulative(flat: Vec[]): number[] {
  const cum = [0]
  for (let k = 1; k < flat.length; k++) {
    cum.push(cum[k - 1] + Math.hypot(flat[k].x - flat[k - 1].x, flat[k].y - flat[k - 1].y))
  }
  return cum
}

/**
 * Where two segments meet, as parameters along each, INCLUSIVE of their
 * ends. A wire's bend lying exactly on another wire is still a crossing —
 * waypoints are not electrical — so the ends cannot be excluded here; real
 * junctions are filtered by the caller, which knows where each run ENDS.
 */
function segmentHit(a: Vec, b: Vec, c: Vec, d: Vec): { t: number; u: number; sin: number } | null {
  const rx = b.x - a.x
  const ry = b.y - a.y
  const sx = d.x - c.x
  const sy = d.y - c.y
  const denom = rx * sy - ry * sx
  const lens = Math.hypot(rx, ry) * Math.hypot(sx, sy)
  if (lens < 1e-12 || Math.abs(denom) < 1e-9 * lens) return null
  const qx = c.x - a.x
  const qy = c.y - a.y
  const t = (qx * sy - qy * sx) / denom
  const u = (qx * ry - qy * rx) / denom
  const E = 1e-9
  if (t < -E || t > 1 + E || u < -E || u > 1 + E) return null
  return { t, u, sin: Math.max(MIN_SIN, Math.abs(denom) / lens) }
}

/** Every place `r` crosses `o` in plan, away from either wire's ends. */
function crossings(r: Run, o: Run): Crossing[] {
  const ends = [r.flat[0], r.flat[r.flat.length - 1], o.flat[0], o.flat[o.flat.length - 1]]
  const out: Crossing[] = []
  for (let k = 0; k + 1 < r.flat.length; k++) {
    for (let m = 0; m + 1 < o.flat.length; m++) {
      const hit = segmentHit(r.flat[k], r.flat[k + 1], o.flat[m], o.flat[m + 1])
      if (!hit) continue
      const p = lerpVec(r.flat[k], r.flat[k + 1], hit.t)
      if (ends.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < JUNCTION_EPS)) continue
      const s = r.cum[k] + hit.t * (r.cum[k + 1] - r.cum[k])
      const su = o.cum[m] + hit.u * (o.cum[m + 1] - o.cum[m])
      // A crossing AT a vertex is found once from each segment meeting there.
      const dup = out.find((x) => Math.abs(x.s - s) < 1e-6 && Math.abs(x.su - su) < 1e-6)
      if (dup) dup.sin = Math.min(dup.sin, hit.sin)
      else out.push({ s, su, sin: hit.sin })
    }
  }
  return out
}

/** How far above ride height `run` is at arc length `s`. */
function liftAt(run: Run, s: number): number {
  let lift = 0
  for (const b of run.bridges) {
    const off = s < b.s0 ? b.s0 - s : s > b.s1 ? s - b.s1 : 0
    lift = Math.max(lift, b.lift - off / RAMP)
  }
  return lift
}

/** The highest `run` gets anywhere in [a, b]. Its profile is piecewise linear, so corners and ends suffice. */
function maxLift(run: Run, a: number, b: number): number {
  let lift = Math.max(liftAt(run, a), liftAt(run, b))
  for (const br of run.bridges) {
    for (const s of [br.s0, br.s1]) if (s > a && s < b) lift = Math.max(lift, liftAt(run, s))
  }
  return lift
}

/**
 * Half-width of the flat top a crossing needs, measured along the run going
 * over. Off the top, the ramp falls away at 1/RAMP while the wire below gets
 * farther away sideways at `sin` per unit of run — a square crossing is clear
 * almost at once, a shallow one needs a long top. Solved numerically, because
 * it runs a handful of times per wire and the closed form hides the geometry.
 */
function plateauHalf(lift: number, under: number, sin: number): number {
  // Beyond this, the two tubes are side by side rather than stacked.
  const reach = CLEARANCE / sin
  const STEP = 0.01
  for (let p = 0; p < reach; p += STEP) {
    let clear = true
    for (let d = p; d < reach; d += STEP) {
      const side = d * sin
      if (lift - (d - p) / RAMP < under + Math.sqrt(CLEARANCE ** 2 - side * side)) {
        clear = false
        break
      }
    }
    if (clear) return p
  }
  return reach
}

/**
 * Decide which wire goes over which, and how it gets there.
 *
 * Two wires drawn at the same height interpenetrate wherever they cross —
 * tubes passing through each other, which is both ugly and a lie about a
 * board you are going to build. Real jumpers bridge one another, so these
 * do too.
 *
 * WHO goes over is `project.wires` order, which is already paint order in 2D
 * and already has a UI: the Inspector's Order group. "Bring to front" now
 * literally means "route this one over the others", in both views.
 *
 * HOW HIGH is decided per crossing, from how high the wire underneath
 * actually is there — so one step clears a flat wire and only a real pile-up
 * stacks. HOW WIDE comes from the crossing angle (`plateauHalf`). Bridges
 * whose ramps would nearly meet are merged into one flat span, which is what
 * a real jumper over a bundle of wires does.
 */
function resolveCrossings(runs: Run[]): void {
  // Paint order, so every wire underneath already has its final profile.
  for (const r of runs) {
    const need: Bridge[] = []
    for (const o of runs) {
      if (o.order >= r.order || o.w.side !== r.w.side) continue
      for (const x of crossings(r, o)) {
        // How high the wire below is anywhere it is close enough to touch.
        const band = CLEARANCE / x.sin
        const under = maxLift(o, x.su - band, x.su + band)
        const lift = Math.min(MAX_LIFT, under + HOP_STEP)
        const half = plateauHalf(lift, under, x.sin)
        need.push({ s0: x.s - half, s1: x.s + half, lift })
      }
    }
    r.bridges = mergeBridges(need)
  }
}

/**
 * Overlapping (or nearly overlapping) bridges become one, at the higher lift.
 * Every ramp falls at the same 1/RAMP, so the merged profile is everywhere at
 * least as high as each of the bridges it replaced — merging never costs
 * clearance.
 */
function mergeBridges(list: Bridge[]): Bridge[] {
  list.sort((a, b) => a.s0 - b.s0)
  const out: Bridge[] = []
  for (const b of list) {
    const last = out[out.length - 1]
    if (last && b.s0 - b.lift * RAMP < last.s1 + last.lift * RAMP + MIN_FLAT) {
      last.s1 = Math.max(last.s1, b.s1)
      last.lift = Math.max(last.lift, b.lift)
    } else {
      out.push({ ...b })
    }
  }
  return out
}

function lerpVec(a: Vec, b: Vec, t: number): Vec {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/**
 * The run's 3D points: every vertex of the flat polyline, plus every corner of
 * every bridge profile, each lifted to the profile's height there. A bridge
 * corner landing within a whisker of a vertex is dropped in favour of the
 * vertex, or `roundedPath` would be handed a near-zero segment and leave a
 * hard kink where the wire should bend.
 */
function liftedPoints(run: Run, ride: number, sign: number): THREE.Vector3[] {
  const { flat, cum } = run
  const total = cum[cum.length - 1]
  const SNAP = 0.03

  const marks: { s: number; p: Vec }[] = flat.map((p, k) => ({ s: cum[k], p }))
  for (const b of run.bridges) {
    const ramp = b.lift * RAMP
    for (const s of [b.s0 - ramp, b.s0, b.s1, b.s1 + ramp]) {
      if (s <= 0 || s >= total) continue
      if (cum.some((c) => Math.abs(c - s) < SNAP)) continue
      let k = 0
      while (k < cum.length - 2 && cum[k + 1] < s) k++
      const len = cum[k + 1] - cum[k]
      marks.push({ s, p: lerpVec(flat[k], flat[k + 1], len > 0 ? (s - cum[k]) / len : 0) })
    }
  }
  // Stable, so a vertex keeps its place among the bridge corners at the same s.
  marks.sort((a, b) => a.s - b.s)
  return marks.map((m) => new THREE.Vector3(m.p.x, ride + sign * liftAt(run, m.s), m.p.y))
}

/**
 * A polyline with its corners rounded, as one curve.
 *
 * A bare polyline tube kinks hard at a bend and pinches its cross-section;
 * trimming each corner back and bridging it with a quadratic is what makes a
 * 3D jumper read as bent wire rather than as mitred pipe. The trim is clamped
 * to half of each adjacent segment, so a short run between two close bends
 * degrades to the sharp corner instead of overshooting.
 */
function roundedPath(pts: THREE.Vector3[], radius: number): THREE.CurvePath<THREE.Vector3> | null {
  const p = pts.filter((v, i) => i === 0 || v.distanceTo(pts[i - 1]) > 1e-6)
  if (p.length < 2) return null

  const path = new THREE.CurvePath<THREE.Vector3>()
  let cursor = p[0].clone()
  /** Carry on from `corner` with no arc: a deliberate hard angle. */
  const sharp = (corner: THREE.Vector3) => {
    if (cursor.distanceTo(corner) > 1e-6) path.add(new THREE.LineCurve3(cursor.clone(), corner.clone()))
    cursor = corner.clone()
  }

  for (let i = 1; i < p.length - 1; i++) {
    const prev = p[i - 1]
    const corner = p[i]
    const next = p[i + 1]

    // A plunge into a hole is the only exactly VERTICAL segment a run has,
    // and it must stay a hard right angle: rounding it makes the wire hook
    // over the pin like a shepherd's crook instead of going into it.
    if (isPlunge(prev, corner) || isPlunge(corner, next)) {
      sharp(corner)
      continue
    }

    const inLen = corner.distanceTo(prev)
    const outLen = corner.distanceTo(next)
    const t = Math.min(radius, inLen / 2, outLen / 2)
    // No room for an arc. Still has to go THROUGH the corner — skipping it
    // outright would cut it off, since the next line starts at the next
    // corner's shoulder.
    if (t < 1e-5) {
      sharp(corner)
      continue
    }
    const a = corner.clone().lerp(prev, t / inLen)
    const b = corner.clone().lerp(next, t / outLen)
    if (cursor.distanceTo(a) > 1e-6) path.add(new THREE.LineCurve3(cursor.clone(), a))
    path.add(new THREE.QuadraticBezierCurve3(a, corner.clone(), b))
    cursor = b
  }
  const end = p[p.length - 1]
  if (cursor.distanceTo(end) > 1e-6) path.add(new THREE.LineCurve3(cursor.clone(), end.clone()))
  return path.curves.length > 0 ? path : null
}

/** Straight down into a hole: no horizontal travel at all. */
function isPlunge(a: THREE.Vector3, b: THREE.Vector3): boolean {
  return Math.abs(a.y - b.y) > 1e-6 && Math.hypot(b.x - a.x, b.z - a.z) < 1e-6
}

/**
 * A sphere enclosing everything, for framing the camera. Uses the same
 * `contentBounds` the 2D fit does, so both views open on the same build —
 * grown by the tallest part, since height is the axis 2D cannot see.
 */
export function worldSphere(project: Project): { centre: THREE.Vector3; radius: number } {
  const b = contentBounds(project)
  let tall = BOARD_T
  for (const inst of project.parts) {
    const def = project.defs[inst.defId]
    if (def) tall = Math.max(tall, mmToHoles(partHeightMm(def)))
  }
  const centre = new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minY + b.maxY) / 2)
  const radius = Math.max(2, 0.5 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY, tall * 2))
  return { centre, radius }
}

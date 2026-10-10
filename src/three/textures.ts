/**
 * Canvas textures for the 3D view.
 *
 * Same principle as the 2D canvas's `<pattern>` rule: a 199x199 board is
 * ~40,000 holes, so a hole is never a mesh. It is one tile of a repeating
 * texture on a single plane, exactly as it is one tile of an SVG pattern in
 * 2D. Every texture here is OPAQUE — it paints the substrate colour as its
 * background — so the board needs no transparency and no blend sorting.
 *
 * Textures are cached by their colours and never disposed: there are only a
 * handful of distinct board colour pairs in a project, and a texture that
 * outlives one scene rebuild is reused by the next.
 */

import * as THREE from 'three'
import { HOLE_R, PAD_R } from '../model/geometry'
import { PAD_ACROSS } from '../model/pads'

/** Texture pixels per hole. Enough for a pad ring to stay crisp close up. */
const PX_PER_HOLE = 64

/** The dark of the drill. Not pure black — a hole reads as depth, not a dot. */
const DRILL = '#17191c'

const cache = new Map<string, THREE.Texture>()

function cached(key: string, make: () => HTMLCanvasElement): THREE.Texture {
  const hit = cache.get(key)
  if (hit) return hit
  const tex = new THREE.CanvasTexture(make())
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  cache.set(key, tex)
  return tex
}

function canvas(wCells: number, hCells: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = wCells * PX_PER_HOLE
  c.height = hCells * PX_PER_HOLE
  const ctx = c.getContext('2d')!
  return [c, ctx]
}

/** One lattice hole: substrate, copper ring, drill. Tiled once per hole. */
export function latticeTexture(boardColor: string, padColor: string): THREE.Texture {
  return cached(`lattice:${boardColor}:${padColor}`, () => {
    const [c, ctx] = canvas(1, 1)
    const m = PX_PER_HOLE / 2
    ctx.fillStyle = boardColor
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = padColor
    ctx.beginPath()
    ctx.arc(m, m, PAD_R * PX_PER_HOLE, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = DRILL
    ctx.beginPath()
    ctx.arc(m, m, HOLE_R * PX_PER_HOLE, 0, Math.PI * 2)
    ctx.fill()
    return c
  })
}

/**
 * One edge pad: the two-cell capsule. Tiled once per pad along the strip,
 * which is why the tile is PAD_ACROSS cells long.
 *
 * Solid copper with no drill, exactly as the 2D view draws it — that is how
 * the bus pads read next to the ringed lattice holes, and it is the cue that
 * the whole capsule is ONE node.
 */
export function padTexture(boardColor: string, padColor: string, vertical: boolean): THREE.Texture {
  return cached(`pad:${boardColor}:${padColor}:${vertical}`, () => {
    // A vertical strip (left/right edge) has its capsule lying ACROSS the
    // tile, because the run itself goes down the y axis.
    const [c, ctx] = canvas(vertical ? PAD_ACROSS : 1, vertical ? 1 : PAD_ACROSS)
    ctx.fillStyle = boardColor
    ctx.fillRect(0, 0, c.width, c.height)

    const a = { x: 0.5, y: 0.5 }
    const b = vertical ? { x: PAD_ACROSS - 0.5, y: 0.5 } : { x: 0.5, y: PAD_ACROSS - 0.5 }
    ctx.strokeStyle = padColor
    ctx.lineCap = 'round'
    ctx.lineWidth = PAD_R * 2 * PX_PER_HOLE
    ctx.beginPath()
    ctx.moveTo(a.x * PX_PER_HOLE, a.y * PX_PER_HOLE)
    ctx.lineTo(b.x * PX_PER_HOLE, b.y * PX_PER_HOLE)
    ctx.stroke()

    return c
  })
}

/**
 * The two-tone jumper look, as a stripe running along a tube's length.
 * TubeGeometry puts u along the run, so one repeat is one colour/white pair.
 */
export function bandTexture(color: string): THREE.Texture {
  const tex = cached(`band:${color}`, () => {
    const c = document.createElement('canvas')
    c.width = 16
    c.height = 2
    const ctx = c.getContext('2d')!
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 16, 2)
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(10, 0, 6, 2)
    return c
  })
  // Each wire needs its own repeat count, so hand out a clone sharing the
  // image rather than the cached texture itself.
  const out = tex.clone()
  out.needsUpdate = true
  return out
}

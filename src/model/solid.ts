/**
 * The physical third dimension: how thick everything actually is.
 *
 * Only the 3D view reads this. It lives in `model/` rather than next to the
 * renderer because these are facts about the hardware — a 1.6mm board, a 1mm
 * jumper — not rendering choices, and the 2D view would give the same answers
 * if it ever needed them.
 *
 * EVERY length here is in MILLIMETRES, deliberately: heights are the one
 * quantity you read off a datasheet rather than count in holes. `mmToHoles`
 * is the single conversion into the hole-unit world everything else uses.
 */

import { MM_PER_HOLE } from './geometry'
import type { PartDef } from './types'

/** A part with no height of its own. Tall enough to read as a solid. */
export const DEFAULT_PART_HEIGHT_MM = 5

/** Standard single-sided protoboard. */
export const BOARD_THICKNESS_MM = 1.6

/** Jumper wire outside diameter — the wire hugs the board at this radius. */
export const WIRE_DIAMETER_MM = 1

/** A component lead / header pin, for the stubs poking through the board. */
export const PIN_DIAMETER_MM = 0.64

/** How far a lead pokes out of the far face, before the solder blob. */
export const PIN_PROTRUSION_MM = 1.2

export function mmToHoles(mm: number): number {
  return mm / MM_PER_HOLE
}

export function holesToMm(h: number): number {
  return h * MM_PER_HOLE
}

/** A part's standing height in mm, falling back to the default. */
export function partHeightMm(def: PartDef): number {
  const h = def.height
  return typeof h === 'number' && isFinite(h) && h > 0 ? h : DEFAULT_PART_HEIGHT_MM
}

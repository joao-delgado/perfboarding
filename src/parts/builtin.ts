import { makeOutlineEllipse, makeOutlineLine, makeOutlineRect, polygonShape } from '../model/shapes'
import type { OutlineShape, PartDef, PinDef } from '../model/types'

/**
 * Seed parts. All geometry is in hole units: pins land on whole holes, body
 * outlines on half-hole steps (a real body edge falls between pin rows).
 */

function rect(x0: number, y0: number, x1: number, y1: number): OutlineShape {
  return makeOutlineRect(x0, y0, x1 - x0, y1 - y0)
}

function circle(cx: number, cy: number, r: number): OutlineShape {
  return makeOutlineEllipse(cx, cy, r, r)
}

/** An axial lead: a thin rectangle, unioned into the body like any other shape. */
function lead(x0: number, y0: number, x1: number, y1: number): OutlineShape {
  const s = makeOutlineLine({ x: x0, y: y0 }, { x: x1, y: y1 }, 0.16)
  return { ...s, name: 'Lead' }
}

function pins(...coords: [string, number, number][]): PinDef[] {
  // Names like "+" and "-" strip to an empty slug, so fall back to the index
  // and de-duplicate. Pin ids are referenced by wire anchors and must be stable.
  const seen = new Set<string>()
  return coords.map(([name, x, y], i) => {
    const slug = name.toLowerCase().replace(/\W+/g, '')
    let id = slug || `p${i + 1}`
    while (seen.has(id)) id = `${id}_`
    seen.add(id)
    return { id, name, x, y }
  })
}

function def(
  id: string,
  name: string,
  prefix: string,
  shapes: OutlineShape[],
  p: PinDef[],
  fill: string,
  stroke = '#2b2b2b',
): PartDef {
  return {
    id,
    name,
    prefix,
    outline: { shapes },
    pins: p,
    fill,
    stroke,
    builtin: true,
  }
}

/** 1xN pin header, generated on demand. */
export function pinHeader(n: number): PartDef {
  return def(
    `header-1x${n}`,
    `Pin header 1×${n}`,
    'J',
    [rect(-0.5, -0.5, n - 0.5, 0.5)],
    Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: String(i + 1), x: i, y: 0 })),
    '#1c1c1c',
    '#000000',
  )
}

export const BUILTIN_PARTS: PartDef[] = [
  def(
    'resistor',
    'Resistor',
    'R',
    [rect(1, -0.5, 3, 0.5), lead(0, 0, 1, 0), lead(3, 0, 4, 0)],
    pins(['1', 0, 0], ['2', 4, 0]),
    '#C8AA78',
  ),
  def(
    'cap-ceramic',
    'Ceramic capacitor',
    'C',
    [
      polygonShape([
        { x: 0, y: -1.5 },
        { x: 2, y: -1.5 },
        { x: 2.5, y: -0.5 },
        { x: 2.5, y: 0 },
        { x: -0.5, y: 0 },
        { x: -0.5, y: -0.5 },
      ]),
    ],
    pins(['1', 0, 0], ['2', 2, 0]),
    '#D98F2B',
  ),
  def(
    'cap-electrolytic',
    'Electrolytic capacitor',
    'C',
    [circle(1, 0, 1.5)],
    pins(['+', 0, 0], ['-', 2, 0]),
    '#2C4C8C',
  ),
  def(
    'led-5mm',
    'LED 5mm',
    'LED',
    [circle(0.5, 0, 1)],
    pins(['A', 0, 0], ['K', 1, 0]),
    '#E03030',
  ),
  def(
    'diode',
    'Diode',
    'D',
    [rect(1, -0.5, 3, 0.5), lead(0, 0, 1, 0), lead(3, 0, 4, 0)],
    pins(['A', 0, 0], ['K', 4, 0]),
    '#37312C',
    '#c8c8c8',
  ),
  def(
    'switch-tactile',
    'Tactile switch 6mm',
    'SW',
    [rect(-0.5, -0.5, 2.5, 2.5)],
    pins(['1A', 0, 0], ['2A', 2, 0], ['1B', 0, 2], ['2B', 2, 2]),
    '#4A4A4A',
  ),
  def(
    'switch-slide',
    'Slide switch SPDT',
    'SW',
    [rect(-0.5, -1, 2.5, 1)],
    pins(['1', 0, 0], ['C', 1, 0], ['2', 2, 0]),
    '#B0B0B0',
  ),
  def(
    'screw-terminal-2',
    'Screw terminal 2-pin',
    'J',
    [rect(-0.75, -1.25, 2.75, 1)],
    pins(['1', 0, 0], ['2', 2, 0]),
    '#2E7D32',
  ),
  pinHeader(4),
]

export function builtinMap(): Record<string, PartDef> {
  const out: Record<string, PartDef> = {}
  for (const d of BUILTIN_PARTS) out[d.id] = d
  return out
}

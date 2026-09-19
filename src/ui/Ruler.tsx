/**
 * Millimetre ruler strips along the top and left edges of an SVG viewport.
 * Screen-space only — draw it as a sibling of the world-transformed `<g>`,
 * never inside it, or the tick spacing would zoom with the content.
 */

export interface Tick {
  mm: number
  at: number
  major: boolean
}

/** Ticks along one axis, spaced by whatever round millimetre step keeps them legible. */
export function mmTicks(pxPerMm: number, originPx: number, lengthPx: number): Tick[] {
  const tickStep = pxPerMm >= 7 ? 1 : pxPerMm >= 2.5 ? 5 : 10
  const labelStep = tickStep === 1 ? 10 : tickStep === 5 ? 50 : 100
  const from = Math.floor(-originPx / pxPerMm / tickStep) * tickStep
  const to = Math.ceil((lengthPx - originPx) / pxPerMm / tickStep) * tickStep
  const out: Tick[] = []
  for (let v = from; v <= to && out.length < 600; v += tickStep) {
    out.push({ mm: v, at: originPx + v * pxPerMm, major: Math.abs(v % labelStep) < 1e-6 })
  }
  return out
}

interface RulerProps {
  size: { w: number; h: number }
  /** Thickness of the ruler strip, in screen px. */
  thickness?: number
  pxPerMm: number
  /** Screen position of world (0, 0) mm. */
  originX: number
  originY: number
  /** Cursor position in screen space, for the crosshair readout. */
  cursorScreen: { x: number; y: number } | null
}

export function Ruler({ size, thickness = 22, pxPerMm, originX, originY, cursorScreen }: RulerProps) {
  const xTicks = mmTicks(pxPerMm, originX, size.w).filter((t) => t.at > thickness)
  const yTicks = mmTicks(pxPerMm, originY, size.h).filter((t) => t.at > thickness)

  return (
    <g pointerEvents="none" fontFamily="ui-monospace, monospace">
      <rect x={0} y={0} width={size.w} height={thickness} fill="#fbfaf8" />
      <rect x={0} y={0} width={thickness} height={size.h} fill="#fbfaf8" />
      <line x1={0} y1={thickness} x2={size.w} y2={thickness} stroke="#dcd9d3" />
      <line x1={thickness} y1={0} x2={thickness} y2={size.h} stroke="#dcd9d3" />

      {xTicks.map((t) => (
        <g key={`x${t.mm}`}>
          <line
            x1={t.at}
            y1={t.major ? 8 : 15}
            x2={t.at}
            y2={thickness}
            stroke={t.major ? '#8d877c' : '#c9c5bd'}
          />
          {t.major && (
            <text x={t.at + 2} y={9} fontSize={9} fill="#7a746b">
              {t.mm}
            </text>
          )}
        </g>
      ))}
      {yTicks.map((t) => (
        <g key={`y${t.mm}`}>
          <line
            x1={t.major ? 8 : 15}
            y1={t.at}
            x2={thickness}
            y2={t.at}
            stroke={t.major ? '#8d877c' : '#c9c5bd'}
          />
          {t.major && (
            <text x={2} y={t.at - 2} fontSize={9} fill="#7a746b">
              {t.mm}
            </text>
          )}
        </g>
      ))}

      {cursorScreen && (
        <>
          <line x1={cursorScreen.x} y1={0} x2={cursorScreen.x} y2={thickness} stroke="#1E88E5" />
          <line x1={0} y1={cursorScreen.y} x2={thickness} y2={cursorScreen.y} stroke="#1E88E5" />
        </>
      )}
      <rect x={0} y={0} width={thickness} height={thickness} fill="#fbfaf8" stroke="#dcd9d3" />
      <text x={thickness / 2} y={thickness / 2 + 3} textAnchor="middle" fontSize={8} fill="#7a746b">
        mm
      </text>
    </g>
  )
}

import { anchorPos } from '../model/geometry'
import type { Netlist } from '../model/nets'
import type { Vec, Wire } from '../model/types'

export function wirePoints(w: Wire, pinAt: (partId: string, pinId: string) => Vec | undefined): Vec[] {
  const a = anchorPos(w.from, pinAt)
  const b = anchorPos(w.to, pinAt)
  if (!a || !b) return []
  return [a, ...w.waypoints, b]
}

/**
 * A grab target of roughly constant screen size.
 *
 * It has to hit-test on its FILL: a `stroke="transparent"` ring with
 * `vector-effect="non-scaling-stroke"` draws fine but Chrome will not hit-test
 * it, so the handle would silently do nothing and the segment underneath would
 * take the drag instead.
 */
function HitDot(props: {
  at: Vec
  r: number
  cursor: string
  onPointerDown?: (e: React.PointerEvent) => void
}) {
  return (
    <circle
      cx={props.at.x}
      cy={props.at.y}
      r={props.r}
      fill="transparent"
      style={{ cursor: props.cursor }}
      onPointerDown={(e) => {
        e.stopPropagation()
        props.onPointerDown?.(e)
      }}
    />
  )
}

interface Props {
  wire: Wire
  points: Vec[]
  netlist: Netlist
  selected: boolean
  ghosted: boolean
  highlightNet: string | null
  /** World units per screen pixel, so handles keep a usable grab size. */
  pxScale: number
  /** Pointer went down on segment `index` (the run from point i to point i+1).
   *  Double-clicks are recognised by the caller, because pointer capture
   *  retargets the browser's own dblclick to the element that captured. */
  onSegmentDown?: (index: number, e: React.PointerEvent) => void
  onWaypointDown?: (index: number, e: React.PointerEvent) => void
  onEndpointDown?: (end: 'from' | 'to', e: React.PointerEvent) => void
}

export function WireView({
  wire,
  points,
  netlist,
  selected,
  ghosted,
  highlightNet,
  pxScale,
  onSegmentDown,
  onWaypointDown,
  onEndpointDown,
}: Props) {
  if (points.length < 2) return null
  const d = points.map((p) => `${p.x},${p.y}`).join(' ')
  const netId = netlist.byWire.get(wire.id)
  const lit = highlightNet !== null && netId === highlightNet
  // Hole pitch is 1, so this is the wire's diameter as a fraction of the
  // hole spacing — roughly 22AWG insulated hookup wire at 0.1in pitch.
  const width = 0.3
  const grab = Math.max(0.26, pxScale * 9)

  return (
    <g opacity={ghosted ? 0.22 : 1} pointerEvents={ghosted ? 'none' : 'auto'}>
      {lit && (
        <polyline
          points={d}
          fill="none"
          stroke="#FFE500"
          strokeWidth={width * 2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}

      {/* Body + a thin specular highlight, so the wire reads as round rather
          than flat, with a soft drop shadow for depth. */}
      <g filter={ghosted ? undefined : 'url(#pf-wire-shadow)'} pointerEvents="none">
        <polyline
          points={d}
          fill="none"
          stroke={wire.color}
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points={d}
          fill="none"
          stroke="#000"
          strokeOpacity={0.22}
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ mixBlendMode: 'multiply' }}
        />
        <polyline
          points={d}
          fill="none"
          stroke={wire.color}
          strokeWidth={width * 0.62}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points={d}
          fill="none"
          stroke="#fff"
          strokeOpacity={0.3}
          strokeWidth={width * 0.22}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>

      {wire.banded && (
        <polyline
          points={d}
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={width * 0.55}
          strokeDasharray="0.22 0.22"
          strokeLinecap="butt"
          pointerEvents="none"
        />
      )}

      {selected && (
        <polyline
          points={d}
          fill="none"
          stroke="#1E88E5"
          strokeWidth={width * 1.8}
          strokeOpacity={0.35}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}

      {/* Invisible fat stroke: a constant-size grab target at every zoom. */}
      {points.slice(0, -1).map((p, i) => (
        <line
          key={i}
          x1={p.x}
          y1={p.y}
          x2={points[i + 1].x}
          y2={points[i + 1].y}
          stroke="transparent"
          strokeWidth={12}
          vectorEffect="non-scaling-stroke"
          style={{ cursor: selected ? 'move' : 'pointer' }}
          onPointerDown={(e) => {
            e.stopPropagation()
            onSegmentDown?.(i, e)
          }}
        />
      ))}

      {/* A free endpoint must never look connected — Fritzing issue #4212. */}
      {[
        { a: wire.from, p: points[0], end: 'from' as const },
        { a: wire.to, p: points[points.length - 1], end: 'to' as const },
      ].map(({ a, p, end }) => (
        <g key={end}>
          {a.kind === 'free' ? (
            <circle
              cx={p.x}
              cy={p.y}
              r={0.18}
              fill="none"
              stroke="#E03A3A"
              strokeWidth={0.08}
              strokeDasharray="0.12 0.1"
              pointerEvents="none"
            />
          ) : (
            <circle cx={p.x} cy={p.y} r={0.17} fill={wire.color} pointerEvents="none" />
          )}
          {selected && (
            <>
              <circle
                cx={p.x}
                cy={p.y}
                r={0.2}
                fill="#fff"
                stroke="#1E88E5"
                strokeWidth={0.08}
                pointerEvents="none"
              />
              <HitDot at={p} r={grab} cursor="grab" onPointerDown={(e) => onEndpointDown?.(end, e)} />
            </>
          )}
        </g>
      ))}

      {selected &&
        wire.waypoints.map((p, i) => (
          <g key={`wp${i}`}>
            <circle
              cx={p.x}
              cy={p.y}
              r={0.17}
              fill="#fff"
              stroke="#1E88E5"
              strokeWidth={0.07}
              pointerEvents="none"
            />
            <HitDot at={p} r={grab} cursor="grab" onPointerDown={(e) => onWaypointDown?.(i, e)} />
          </g>
        ))}
    </g>
  )
}

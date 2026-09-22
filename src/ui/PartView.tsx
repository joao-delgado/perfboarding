import { partPinPositions } from '../model/geometry'
import { netIsConnected, type Netlist, pinNode } from '../model/nets'
import { partOutlinePoints } from '../model/shapes'
import type { PartDef, PartInstance, Vec } from '../model/types'
import { contrastColor } from './color'
import { PartGraphics } from './PartGraphics'
import { outlineFillD, partTransform } from './svgPath'
import { textTransform, type View } from './view'

const CONNECTED = '#22B24C'
const UNCONNECTED = '#E03A3A'
/** Marks a hole occupied by a pin mounted on the other side of the board. */
const FAR_SIDE_PIN = '#F5A623'

/**
 * How a part on the side we are NOT looking at is drawn.
 *
 * `outline` is what you get with "ghost far side" off: no body, no artwork,
 * just the silhouette's stroke and a ring on every hole the part occupies.
 * A hole taken from the other face still has to be visible — otherwise the
 * near side looks free and you plan a part straight into it.
 */
export type FarMode = 'none' | 'ghost' | 'outline'

interface Props {
  def: PartDef
  inst: PartInstance
  view: View
  netlist: Netlist
  selected: boolean
  /** How to draw it when it is on the side we are not looking at. */
  far?: FarMode
  showNets: boolean
  highlightNet: string | null
  assetUrls: Record<string, string>
  /** Being dragged right now: tinted, the way Fritzing tints a drop target. */
  dragging?: boolean
  onPointerDown?: (e: React.PointerEvent) => void
}

export function PartView({
  def,
  inst,
  view,
  netlist,
  selected,
  far = 'none',
  showNets,
  highlightNet,
  assetUrls,
  dragging,
  onPointerDown,
}: Props) {
  const ghosted = far !== 'none'
  const outlineOnly = far === 'outline'
  const outline = partOutlinePoints(def, inst)
  const positions = partPinPositions(def, inst)
  const textColor = contrastColor(def.fill)
  const fillD = outlineFillD(def.outline)

  // Pin labels sit on the INTERIOR side of each pin, over the body, rather
  // than hanging off the outer edge — which is where the pin's own hole and
  // any wire leaving it need the room.
  const centroid = outline.length
    ? {
        x: outline.reduce((s, p) => s + p.x, 0) / outline.length,
        y: outline.reduce((s, p) => s + p.y, 0) / outline.length,
      }
    : { x: inst.x, y: inst.y }

  return (
    <g
      data-part-id={inst.id}
      pointerEvents={ghosted ? 'none' : 'auto'}
      onPointerDown={onPointerDown}
      style={{ cursor: ghosted ? 'default' : 'move' }}
    >
      {/* Body, backdrop and artwork all live in the part's own frame, so a
          rotated or bottom-mounted part carries its artwork with it. */}
      <g transform={partTransform(inst)}>
        {outlineOnly ? (
          fillD && (
            <path
              d={fillD}
              fillRule="evenodd"
              fill="none"
              stroke={def.stroke}
              strokeWidth={0.07}
              strokeLinejoin="round"
              opacity={0.55}
            />
          )
        ) : (
          <PartGraphics
            def={def}
            idPrefix={`pv-${inst.id}`}
            assetUrls={assetUrls}
            opacity={ghosted ? 0.22 : 1}
            selected={selected}
            filter={ghosted ? undefined : 'url(#pf-part-shadow)'}
          />
        )}
        {dragging && fillD && (
          <path d={fillD} fillRule="evenodd" fill="#1E88E5" opacity={0.35} pointerEvents="none" />
        )}
      </g>

      {def.pins.map((pin) => {
        const pos = positions.get(pin.id)
        if (!pos) return null
        const nodeId = pinNode(inst.id, pin.id)
        const netId = netlist.byNode.get(nodeId)
        const net = netId ? netlist.nets.find((n) => n.id === netId) : undefined
        const lit = highlightNet !== null && netId === highlightNet
        const color = showNets ? (netIsConnected(net) ? CONNECTED : UNCONNECTED) : '#555'

        // Unit vector from the pin toward the body centre: the side the
        // label goes on.
        let ix = centroid.x - pos.x
        let iy = centroid.y - pos.y
        const len = Math.hypot(ix, iy) || 1
        ix /= len
        iy /= len

        // Anchor the label past the pin dot, inward, and let the text grow
        // further inward (rather than being centred on a point right next to
        // the pin) so it never sits on the dot.
        // `labelAt` is in board space, which the root mirror flips for us
        // like any other point — but text flow direction (start/end) is
        // screen-absolute (textTransform cancels the mirror for glyphs), so
        // the anchor choice itself must un-mirror against `view.mirrored`.
        const GAP = 0.28
        const HORIZONTAL = 0.35
        const screenIx = view.mirrored ? -ix : ix
        let labelAt: Vec
        let textAnchor: 'start' | 'middle' | 'end'
        if (ix > HORIZONTAL) {
          textAnchor = screenIx > 0 ? 'start' : 'end'
          labelAt = { x: pos.x + GAP, y: pos.y }
        } else if (ix < -HORIZONTAL) {
          textAnchor = screenIx > 0 ? 'start' : 'end'
          labelAt = { x: pos.x - GAP, y: pos.y }
        } else {
          textAnchor = 'middle'
          labelAt = { x: pos.x, y: pos.y + Math.sign(iy || -1) * (GAP + 0.15) }
        }

        return (
          <g key={pin.id}>
            {/* Ghosted pins still mark the hole a far-side part occupies, so
                it reads clearly even though the body is faint. */}
            {ghosted && (
              <circle
                cx={pos.x}
                cy={pos.y}
                r={0.3}
                fill="none"
                stroke={FAR_SIDE_PIN}
                strokeWidth={0.09}
                strokeDasharray="0.1 0.08"
                opacity={0.85}
              />
            )}
            {lit && <circle cx={pos.x} cy={pos.y} r={0.46} fill="#FFE500" opacity={0.9} />}
            <circle
              cx={pos.x}
              cy={pos.y}
              r={0.2}
              fill="#D8D8D8"
              stroke={color}
              strokeWidth={0.1}
              opacity={ghosted ? 0.75 : 1}
            />
            {!ghosted && (
              <text
                x={labelAt.x}
                y={labelAt.y}
                transform={textTransform(view, labelAt)}
                textAnchor={textAnchor}
                dominantBaseline="middle"
                fontSize={0.26}
                fill={textColor}
                fontFamily="ui-monospace, monospace"
                pointerEvents="none"
              >
                {pin.name}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

/**
 * Preview of a part that has not been dropped yet: the body, and a ring on
 * every hole its pins would land in. Red means that hole cannot take the pin.
 */
export function PartGhost({
  def,
  inst,
  blocked,
}: {
  def: PartDef
  inst: PartInstance
  blocked: (p: Vec) => boolean
}) {
  const fillD = outlineFillD(def.outline)
  return (
    <g pointerEvents="none">
      <g transform={partTransform(inst)}>
        {fillD && (
          <path
            d={fillD}
            fillRule="evenodd"
            fill={def.fill}
            fillOpacity={0.5}
            stroke="#1E88E5"
            strokeWidth={0.08}
            strokeDasharray="0.3 0.2"
            strokeLinejoin="round"
          />
        )}
      </g>
      {[...partPinPositions(def, inst).values()].map((pos, i) => (
        <PinTarget key={i} at={pos} blocked={blocked(pos)} />
      ))}
    </g>
  )
}

/** The ring drawn on a hole a pin is about to occupy. */
export function PinTarget({ at, blocked }: { at: Vec; blocked: boolean }) {
  const color = blocked ? UNCONNECTED : '#1E88E5'
  return (
    <g pointerEvents="none">
      <circle cx={at.x} cy={at.y} r={0.44} fill={color} opacity={0.18} />
      <circle cx={at.x} cy={at.y} r={0.44} fill="none" stroke={color} strokeWidth={0.08} />
    </g>
  )
}

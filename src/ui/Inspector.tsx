import { MM_PER_HOLE } from '../model/geometry'
import { boardExtent, padCount } from '../model/pads'
import { outlineBounds } from '../model/shapes'
import { netIsConnected, type Netlist } from '../model/nets'
import {
  removeParts,
  removeWires,
  rotateParts,
  setPartSide,
  updatePart,
  updateWire,
} from '../model/project'
import { commit, EMPTY_SELECTION, set, useEditor, WIRE_COLORS } from '../model/store'
import type { PartInstance, Side, Wire } from '../model/types'
import { Section } from './Section'

/** On-board footprint size in mm, accounting for a 90/270 rotation swapping width and height. */
function footprintMm(defBounds: { minX: number; minY: number; maxX: number; maxY: number }, rotation: PartInstance['rotation']) {
  let w = (defBounds.maxX - defBounds.minX) * MM_PER_HOLE
  let h = (defBounds.maxY - defBounds.minY) * MM_PER_HOLE
  if (rotation === 90 || rotation === 270) [w, h] = [h, w]
  return { w, h }
}

function SideButtons({ value, onPick }: { value: Side | 'mixed'; onPick: (s: Side) => void }) {
  return (
    <div className="group">
      {(['top', 'bottom'] as const).map((sd) => (
        <button
          key={sd}
          className={`btn small ${value === sd ? 'active' : ''}`}
          onClick={() => onPick(sd)}
        >
          {sd === 'top' ? 'Top' : 'Bottom'}
        </button>
      ))}
    </div>
  )
}

/** Properties of whatever is selected. Single place to change side, which is
 *  otherwise fixed at drop time. */
export function Inspector({ netlist }: { netlist: Netlist }) {
  const s = useEditor()
  const { project, selection } = s

  const parts = selection.parts
    .map((id) => project.parts.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p)
  const wires = selection.wires
    .map((id) => project.wires.find((w) => w.id === id))
    .filter((w): w is Wire => !!w)
  const board = project.boards.find((b) => selection.boards.includes(b.id))

  const nothing = parts.length === 0 && wires.length === 0 && !board

  const partSide: Side | 'mixed' =
    parts.length === 0 ? 'mixed' : parts.every((p) => p.side === parts[0].side) ? parts[0].side : 'mixed'
  const wireSide: Side | 'mixed' =
    wires.length === 0 ? 'mixed' : wires.every((w) => w.side === wires[0].side) ? wires[0].side : 'mixed'

  const one = parts.length === 1 ? parts[0] : null
  const oneWire = wires.length === 1 ? wires[0] : null
  const net = oneWire ? netlist.nets.find((n) => n.id === netlist.byWire.get(oneWire.id)) : undefined

  return (
    <Section
      id="inspector"
      title="Inspector"
      defaultHeight={260}
      headerExtra={
        !nothing && (
          <button
            className="btn small"
            onClick={() => {
              commit((p) => removeWires(removeParts(p, selection.parts), selection.wires))
              set({ selection: EMPTY_SELECTION })
            }}
            disabled={parts.length === 0 && wires.length === 0}
          >
            Delete
          </button>
        )
      }
    >
      <div className="inspector-body">
        {nothing && <div className="empty">Nothing selected.</div>}

        {parts.length > 0 && (
          <>
            <div className="insp-title">
              {one ? project.defs[one.defId]?.name ?? 'Part' : `${parts.length} parts`}
            </div>

            {one &&
              (() => {
                const def = project.defs[one.defId]
                if (!def) return null
                const { w, h } = footprintMm(outlineBounds(def.outline), one.rotation)
                return (
                  <div className="note">
                    {w.toFixed(1)} × {h.toFixed(1)} mm
                  </div>
                )
              })()}

            {one && (
              <label className="field">
                <span>Designator</span>
                <input
                  key={one.id}
                  defaultValue={one.ref}
                  onBlur={(e) => commit((p) => updatePart(p, one.id, { ref: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
              </label>
            )}

            {one && (
              <div className="field row">
                <label>
                  <span>Hole X</span>
                  <input
                    className="num"
                    type="number"
                    value={one.x}
                    onChange={(e) =>
                      commit((p) => updatePart(p, one.id, { x: Math.round(Number(e.target.value)) }))
                    }
                  />
                </label>
                <label>
                  <span>Hole Y</span>
                  <input
                    className="num"
                    type="number"
                    value={one.y}
                    onChange={(e) =>
                      commit((p) => updatePart(p, one.id, { y: Math.round(Number(e.target.value)) }))
                    }
                  />
                </label>
              </div>
            )}

            <div className="field">
              <span>Rotation{one ? ` — ${one.rotation}°` : ''}</span>
              <div className="group">
                <button
                  className="btn small"
                  title="Rotate 90° CCW ( [ )"
                  onClick={() => commit((p) => rotateParts(p, selection.parts, 270))}
                >
                  ↺
                </button>
                <button
                  className="btn small"
                  title="Rotate 90° CW ( ] )"
                  onClick={() => commit((p) => rotateParts(p, selection.parts, 90))}
                >
                  ↻
                </button>
              </div>
            </div>

            <div className="field">
              <span>Mounted on</span>
              <SideButtons
                value={partSide}
                onPick={(sd) => commit((p) => parts.reduce((acc, i) => setPartSide(acc, i.id, sd), p))}
              />
              <div className="note">
                Flipping mirrors the part — it keeps its footprint, but the pins swap ends.
              </div>
            </div>
          </>
        )}

        {wires.length > 0 && (
          <>
            <div className="insp-title">{oneWire ? 'Wire' : `${wires.length} wires`}</div>

            <div className="field">
              <span>Colour</span>
              <div className="swatches">
                {WIRE_COLORS.map((c) => (
                  <button
                    key={c.name}
                    className={`swatch ${wires.every((w) => w.color === c.hex) ? 'active' : ''}`}
                    style={{ background: c.hex }}
                    title={c.name}
                    onClick={() => {
                      set({ wireColor: c.hex })
                      commit((p) => wires.reduce((acc, w) => updateWire(acc, w.id, { color: c.hex }), p))
                    }}
                  />
                ))}
              </div>
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={wires.every((w) => w.banded)}
                onChange={(e) =>
                  commit((p) =>
                    wires.reduce((acc, w) => updateWire(acc, w.id, { banded: e.target.checked }), p),
                  )
                }
              />
              banded
            </label>

            <div className="field">
              <span>Side</span>
              <SideButtons
                value={wireSide}
                onPick={(sd) =>
                  commit((p) => wires.reduce((acc, w) => updateWire(acc, w.id, { side: sd }), p))
                }
              />
            </div>

            <label className="field">
              <span>Net name</span>
              <input
                key={wires.map((w) => w.id).join(',')}
                defaultValue={oneWire ? net?.name ?? oneWire.net ?? '' : ''}
                placeholder="e.g. GND"
                onBlur={(e) => {
                  const name = e.target.value.trim() || undefined
                  // A name belongs to the net, so it goes on every wire in it.
                  const ids = new Set<string>()
                  for (const w of wires) {
                    const n = netlist.nets.find((x) => x.id === netlist.byWire.get(w.id))
                    for (const id of n?.wireIds ?? [w.id]) ids.add(id)
                  }
                  commit((p) => [...ids].reduce((acc, id) => updateWire(acc, id, { net: name }), p))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
            </label>

            {oneWire && (
              <div className="note">
                {oneWire.waypoints.length} bend{oneWire.waypoints.length === 1 ? '' : 's'} ·{' '}
                {net ? `${net.partIds.length} part${net.partIds.length === 1 ? '' : 's'} on this net` : 'no net'}
                {net && !netIsConnected(net) && ' · not a connection yet'}
              </div>
            )}

            {oneWire && oneWire.waypoints.length > 0 && (
              <button
                className="btn small"
                onClick={() => commit((p) => updateWire(p, oneWire.id, { waypoints: [] }))}
              >
                Straighten
              </button>
            )}
          </>
        )}

        {board && parts.length === 0 && wires.length === 0 && (
          <>
            <div className="insp-title">{board.name}</div>
            <div className="note">
              {/* Matches BoardSurface's substrate rect: the extent span (hole
                  lattice plus any edge pad strips) plus the 0.6-hole margin on
                  each side. */}
              {((boardExtent(board).maxX - boardExtent(board).minX + 1.2) * MM_PER_HOLE).toFixed(1)}{' '}
              ×{' '}
              {((boardExtent(board).maxY - boardExtent(board).minY + 1.2) * MM_PER_HOLE).toFixed(1)}{' '}
              mm
            </div>
            <div className="note">
              {board.cols} × {board.rows} holes at ({board.x}, {board.y})
              {padCount(board) > 0 && ` · ${padCount(board)} edge pads`}. Size, edge pads, colours
              and name live in the Boards panel; drag the board itself to move it.
            </div>
          </>
        )}
      </div>
    </Section>
  )
}

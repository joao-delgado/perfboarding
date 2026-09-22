import { HOLE_R, PAD_R } from '../model/geometry'
import { boardExtent, boardStripGeoms, PAD_ACROSS, stripSpanCells, type StripGeom } from '../model/pads'
import type { Board as BoardModel } from '../model/types'

/**
 * Background grid the boards snap to. One <rect> + <pattern>, like the holes.
 */
export function CanvasGrid({
  minX,
  minY,
  cols,
  rows,
}: {
  minX: number
  minY: number
  cols: number
  rows: number
}) {
  return (
    <g pointerEvents="none">
      <defs>
        <pattern id="pf-grid" patternUnits="userSpaceOnUse" width={1} height={1} x={-0.5} y={-0.5}>
          <circle cx={0.5} cy={0.5} r={0.055} fill="#c9c5bd" />
        </pattern>
      </defs>
      <rect x={minX} y={minY} width={cols} height={rows} fill="url(#pf-grid)" />
    </g>
  )
}

/**
 * One run of edge bus pads.
 *
 * Same trick as the hole lattice: a run is ONE <rect> filled with a <pattern>
 * whose tile is exactly one pad, so a 199-row board's four strips cost four DOM
 * nodes rather than eight hundred. The capsule is the two covered cells grown
 * by PAD_R — literally the lattice's round pads merged — so it lines up with
 * the lattice to the pixel however the pad radius is tuned.
 *
 * Drawn as solid copper, with no drill: that is how the bus pads read on a real
 * board next to the ringed lattice holes, and it is the visual cue that the
 * whole capsule is ONE node rather than two holes that happen to touch. Both
 * cells stay solderable in the model — see `pads.ts`.
 */
function PadStripView({ board, geom }: { board: BoardModel; geom: StripGeom }) {
  const tileW = geom.vertical ? PAD_ACROSS : 1
  const tileH = geom.vertical ? 1 : PAD_ACROSS
  const { w, h } = stripSpanCells(geom)
  const patternId = `pads-${board.id}-${geom.edge}`
  // Cells sit at (0.5 + i, 0.5 + j) inside the tile, matching the hole pattern.
  const x0 = geom.originX - 0.5
  const y0 = geom.originY - 0.5

  return (
    <>
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width={tileW}
          height={tileH}
          x={x0}
          y={y0}
        >
          <rect
            x={0.5 - PAD_R}
            y={0.5 - PAD_R}
            width={tileW - 1 + 2 * PAD_R}
            height={tileH - 1 + 2 * PAD_R}
            rx={PAD_R}
            ry={PAD_R}
            fill={board.padColor}
          />
        </pattern>
      </defs>
      <rect x={x0} y={y0} width={w} height={h} fill={`url(#${patternId})`} pointerEvents="none" />
    </>
  )
}

/**
 * One perfboard.
 *
 * The hole lattice is ONE <rect> filled with a <pattern> — a 199x199 board is
 * nearly 40,000 holes, and putting those in the DOM would be fatal. The tile
 * carries a 2x2 block because very small tiles rasterise slowly at high zoom,
 * with its origin at (-0.5,-0.5) so the holes land on integer coordinates.
 *
 * The substrate is sized from the board's EXTENT, not cols/rows, so switching
 * on an edge pad strip grows the FR4 under it instead of letting it hang off.
 */
export function BoardSurface({
  board,
  selected,
  onPointerDown,
}: {
  board: BoardModel
  selected?: boolean
  onPointerDown?: (e: React.PointerEvent) => void
}) {
  const { cols, rows, x: bx, y: by, color, padColor, id } = board
  const e = boardExtent(board)
  const x0 = e.minX - 0.6
  const y0 = e.minY - 0.6
  const w = e.maxX - e.minX + 1.2
  const h = e.maxY - e.minY + 1.2
  const patternId = `holes-${id}`
  const strips = boardStripGeoms(board)

  return (
    <g onPointerDown={onPointerDown}>
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width={2}
          height={2}
          x={bx - 0.5}
          y={by - 0.5}
        >
          {[0.5, 1.5].flatMap((i) =>
            [0.5, 1.5].map((j) => (
              <g key={`${i}-${j}`}>
                <circle cx={i} cy={j} r={PAD_R} fill={padColor} />
                <circle cx={i} cy={j} r={HOLE_R} fill="#17120b" />
              </g>
            )),
          )}
        </pattern>
      </defs>

      <rect
        x={x0}
        y={y0}
        width={w}
        height={h}
        rx={0.3}
        fill={color}
        filter="url(#pf-board-shadow)"
      />
      <rect
        x={x0}
        y={y0}
        width={w}
        height={h}
        rx={0.3}
        fill="none"
        stroke={selected ? '#1E88E5' : 'rgba(0,0,0,0.35)'}
        strokeWidth={selected ? 0.12 : 0.05}
      />
      {/* One node for every hole on the board. */}
      <rect x={bx - 0.5} y={by - 0.5} width={cols} height={rows} fill={`url(#${patternId})`} pointerEvents="none" />
      {strips.map((g) => (
        <PadStripView key={g.edge} board={board} geom={g} />
      ))}
    </g>
  )
}

/** Shadow / depth filters, defined once per canvas. */
export function CanvasDefs() {
  return (
    <defs>
      <filter id="pf-board-shadow" x="-10%" y="-10%" width="130%" height="130%">
        <feDropShadow dx="0" dy="0.12" stdDeviation="0.14" floodColor="#000" floodOpacity="0.35" />
      </filter>
      <filter id="pf-part-shadow" x="-30%" y="-30%" width="180%" height="180%">
        <feDropShadow dx="0" dy="0.08" stdDeviation="0.09" floodColor="#000" floodOpacity="0.42" />
      </filter>
    </defs>
  )
}

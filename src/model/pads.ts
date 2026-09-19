import type { Bounds } from './geometry'
import type { Board, BoardEdge, Vec } from './types'

/**
 * Edge pad strips.
 *
 * A strip is the run of oblong bus pads along one edge of a board — the ones
 * down the sides of a cheap protoboard. There is exactly one shape: a pad
 * covers two grid cells running OUTWARD from the edge, one pad per lattice row
 * (left/right edges) or column (top/bottom), butted straight up against the
 * lattice. No size options: this is what the boards look like.
 *
 * The strip lives outside the hole lattice — switching it on grows the board
 * rather than eating a column you already built on — but still on the integer
 * grid, so every cell a pad covers is an ordinary hole coordinate. Snapping,
 * wire anchors and part pins all keep working untouched. The one thing a pad
 * adds is that its two cells are electrically ONE node (see `nets.ts`), the
 * only place in this model where two holes are not isolated.
 *
 * Nothing is stored per pad; it is all derived from the edge, so resizing a
 * board re-lays its strips for free.
 */

export const BOARD_EDGES: readonly BoardEdge[] = ['left', 'top', 'bottom', 'right']

/** Cells one pad covers, measured across the edge. The pad is one cell wide
 *  the other way, which is what makes it a two-hole capsule. */
export const PAD_ACROSS = 2

/** A strip resolved against its board: where it starts and how far it runs. */
export interface StripGeom {
  edge: BoardEdge
  /** Lowest-x, lowest-y cell of the whole run, in canvas hole units. */
  originX: number
  originY: number
  /** Pads in the run — one per lattice row or column. */
  count: number
  /** True for the left/right edges, where the run goes down the y axis. */
  vertical: boolean
}

export function stripGeom(board: Board, edge: BoardEdge): StripGeom {
  const vertical = edge === 'left' || edge === 'right'
  const count = vertical ? board.rows : board.cols
  let originX = board.x
  let originY = board.y
  switch (edge) {
    case 'left':
      originX = board.x - PAD_ACROSS
      break
    case 'right':
      originX = board.x + board.cols
      break
    case 'top':
      originY = board.y - PAD_ACROSS
      break
    case 'bottom':
      originY = board.y + board.rows
      break
  }
  return { edge, originX, originY, count, vertical }
}

/** Size of the whole run in cells. */
export function stripSpanCells(g: StripGeom): { w: number; h: number } {
  return g.vertical ? { w: PAD_ACROSS, h: g.count } : { w: g.count, h: PAD_ACROSS }
}

/** The two cells covered by pad number `i` of a run. */
export function padCells(g: StripGeom, i: number): Vec[] {
  const cells: Vec[] = []
  for (let a = 0; a < PAD_ACROSS; a++) {
    cells.push(
      g.vertical
        ? { x: g.originX + a, y: g.originY + i }
        : { x: g.originX + i, y: g.originY + a },
    )
  }
  return cells
}

/**
 * Which pad of a run covers a cell, or null. Pure arithmetic on a uniform run,
 * exactly like hole snapping — never a scan over the pads.
 */
export function padIndexAt(g: StripGeom, x: number, y: number): number | null {
  const across = g.vertical ? x - g.originX : y - g.originY
  const along = g.vertical ? y - g.originY : x - g.originX
  if (across < 0 || across >= PAD_ACROSS) return null
  if (along < 0 || along >= g.count) return null
  return along
}

export function boardStripGeoms(board: Board): StripGeom[] {
  return (board.padEdges ?? []).map((edge) => stripGeom(board, edge))
}

/** Every pad on a board, as the cells it bonds together. */
export function boardPads(board: Board): Vec[][] {
  const out: Vec[][] = []
  for (const g of boardStripGeoms(board)) {
    for (let i = 0; i < g.count; i++) out.push(padCells(g, i))
  }
  return out
}

/** Is this cell part of one of the board's pads? At most four strips to test. */
export function isPadCell(board: Board, x: number, y: number): boolean {
  for (const g of boardStripGeoms(board)) {
    if (padIndexAt(g, x, y) !== null) return true
  }
  return false
}

/** Is this cell one of the board's plain lattice holes? */
export function isGridHole(board: Board, x: number, y: number): boolean {
  return x >= board.x && y >= board.y && x < board.x + board.cols && y < board.y + board.rows
}

/**
 * Inclusive cell bounds of everything the board physically occupies — the hole
 * lattice plus any pad strips. This, not `cols × rows`, is the board's
 * footprint: it decides what the substrate rect covers, what a board drag
 * carries with it, and what `boardAt` answers for.
 */
export function boardExtent(board: Board): Bounds {
  let minX = board.x
  let minY = board.y
  let maxX = board.x + board.cols - 1
  let maxY = board.y + board.rows - 1
  for (const g of boardStripGeoms(board)) {
    const { w, h } = stripSpanCells(g)
    minX = Math.min(minX, g.originX)
    minY = Math.min(minY, g.originY)
    maxX = Math.max(maxX, g.originX + w - 1)
    maxY = Math.max(maxY, g.originY + h - 1)
  }
  return { minX, minY, maxX, maxY }
}

export function hasPadEdge(edges: BoardEdge[] | undefined, edge: BoardEdge): boolean {
  return (edges ?? []).includes(edge)
}

export function togglePadEdge(edges: BoardEdge[] | undefined, edge: BoardEdge): BoardEdge[] {
  const cur = edges ?? []
  if (cur.includes(edge)) return cur.filter((e) => e !== edge)
  // Keep a stable order so the rendered <pattern> ids do not churn.
  return [...cur, edge].sort((a, b) => BOARD_EDGES.indexOf(a) - BOARD_EDGES.indexOf(b))
}

export function padCount(board: Board): number {
  return boardStripGeoms(board).reduce((n, g) => n + g.count, 0)
}

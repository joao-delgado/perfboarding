import { boundsOf, partToBoard, rotatePoint, snapToHole } from './geometry'
import { uid } from './ids'
import { boardExtent, isGridHole, isPadCell } from './pads'
import { sampleOutline } from './shapes'
import type { Anchor, Board, PartDef, PartInstance, Project, Rotation, Side, Vec, Wire } from './types'
import { DEFAULT_BOARD_COLOR, DEFAULT_PAD_COLOR } from './types'

export { uid }

export function makeBoard(patch: Partial<Board> = {}): Board {
  return {
    id: uid('board'),
    name: 'Board',
    x: 0,
    y: 0,
    cols: 24,
    rows: 18,
    color: DEFAULT_BOARD_COLOR,
    padColor: DEFAULT_PAD_COLOR,
    ...patch,
  }
}

export function createProject(name = 'Untitled', defs: Record<string, PartDef> = {}): Project {
  return {
    version: 1,
    name,
    boards: [makeBoard()],
    defs: { ...defs },
    parts: [],
    wires: [],
    assets: {},
  }
}

export function addBoard(project: Project, patch: Partial<Board> = {}): Project {
  // Place a new board clear of the existing ones — clear of their pad strips
  // too, which is why this measures the extent rather than cols.
  const right = project.boards.reduce((m, b) => Math.max(m, boardExtent(b).maxX + 3), 0)
  return { ...project, boards: [...project.boards, makeBoard({ x: right, y: 0, ...patch })] }
}

export function updateBoard(project: Project, id: string, patch: Partial<Board>): Project {
  return { ...project, boards: project.boards.map((b) => (b.id === id ? { ...b, ...patch } : b)) }
}

/**
 * Move a board by (dx, dy), carrying with it everything currently sitting on
 * it: parts whose origin is within its bounds, hole/free wire anchors within
 * its bounds, and waypoints within its bounds. Pin anchors need no separate
 * handling — they have no stored coordinates and follow their part.
 *
 * Membership is decided against the board's PRE-move extent, since parts and
 * wires carry no boardId — position overlap is the only signal there is.
 */
export function moveBoard(project: Project, id: string, dx: number, dy: number): Project {
  const board = project.boards.find((b) => b.id === id)
  if (!board || (dx === 0 && dy === 0)) return project
  // Extent, not cols/rows: anything sitting on an edge pad has to travel too.
  const e = boardExtent(board)
  const onBoard = (x: number, y: number) =>
    x >= e.minX && y >= e.minY && x <= e.maxX && y <= e.maxY

  const shiftAnchor = (a: Anchor): Anchor =>
    a.kind !== 'pin' && onBoard(a.x, a.y) ? { ...a, x: a.x + dx, y: a.y + dy } : a

  return {
    ...project,
    boards: project.boards.map((b) => (b.id === id ? { ...b, x: b.x + dx, y: b.y + dy } : b)),
    parts: project.parts.map((p) => (onBoard(p.x, p.y) ? { ...p, x: p.x + dx, y: p.y + dy } : p)),
    wires: project.wires.map((w) => ({
      ...w,
      from: shiftAnchor(w.from),
      to: shiftAnchor(w.to),
      waypoints: w.waypoints.map((pt) => (onBoard(pt.x, pt.y) ? { x: pt.x + dx, y: pt.y + dy } : pt)),
    })),
  }
}

export function removeBoard(project: Project, id: string): Project {
  if (project.boards.length <= 1) return project
  return { ...project, boards: project.boards.filter((b) => b.id !== id) }
}

/**
 * Which board's substrate covers this canvas cell, if any — the whole physical
 * footprint, so an edge pad (and the gap between it and the lattice) counts.
 * This is the board you grab when you drag, not a guarantee of a hole.
 */
export function boardAt(project: Project, x: number, y: number): Board | undefined {
  return project.boards.find((b) => {
    const e = boardExtent(b)
    return x >= e.minX && y >= e.minY && x <= e.maxX && y <= e.maxY
  })
}

/** Is there something solderable at this canvas cell — a lattice hole or an
 *  edge pad? The gap between the lattice and a pad strip is bare substrate. */
export function isHole(project: Project, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false
  const b = boardAt(project, x, y)
  return !!b && (isGridHole(b, x, y) || isPadCell(b, x, y))
}

/** Next free designator for a definition's prefix: R1, R2, U1... */
export function nextRef(project: Project, prefix: string): string {
  let max = 0
  for (const p of project.parts) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(p.ref)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}${max + 1}`
}

export function addPart(
  project: Project,
  defId: string,
  at: Vec,
  side: Side,
  rotation: Rotation = 0,
): Project {
  const def = project.defs[defId]
  if (!def) return project
  const inst: PartInstance = {
    id: uid('part'),
    defId,
    x: at.x,
    y: at.y,
    rotation,
    side,
    ref: nextRef(project, def.prefix),
  }
  return { ...project, parts: [...project.parts, inst] }
}

export function updatePart(project: Project, id: string, patch: Partial<PartInstance>): Project {
  return {
    ...project,
    parts: project.parts.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  }
}

/**
 * Rotate a set of parts as one block, about the snapped centre of their
 * origins. Exact integer maths: the centre is a whole hole and the step is a
 * multiple of 90, so nothing can drift off the lattice.
 */
export function rotateParts(project: Project, ids: string[], delta: 90 | 270): Project {
  const insts = ids
    .map((id) => project.parts.find((p) => p.id === id))
    .filter((p): p is PartInstance => !!p)
  if (insts.length === 0) return project
  const centre = snapToHole({
    x: insts.reduce((a, i) => a + i.x, 0) / insts.length,
    y: insts.reduce((a, i) => a + i.y, 0) / insts.length,
  })
  return insts.reduce((acc, inst) => {
    const d = rotatePoint({ x: inst.x - centre.x, y: inst.y - centre.y }, delta)
    return updatePart(acc, inst.id, {
      x: centre.x + d.x,
      y: centre.y + d.y,
      rotation: ((inst.rotation + delta) % 360) as Rotation,
    })
  }, project)
}

/** The points that define where a part physically sits: its pins, or its
 *  body if it somehow has none. */
function footprint(def: PartDef, inst: PartInstance): Vec[] {
  const src = def.pins.length > 0 ? (def.pins as Vec[]) : sampleOutline(def.outline)
  return src.map((p) => partToBoard(p, inst))
}

/**
 * Move a part to the other face of the board.
 *
 * Mounting a part from below mirrors it (see `partToBoard`), so its pins cannot
 * land in the same holes unless the part is symmetric — that is physics, not a
 * bug. What we can preserve is the footprint: we translate the origin so the
 * part still occupies the same block of holes, which is what happens when you
 * pull a resistor out and push it back in from the other side. The shift is
 * always an integer because pins are integers and rotation is a multiple of 90.
 */
export function setPartSide(project: Project, id: string, side: Side): Project {
  const inst = project.parts.find((p) => p.id === id)
  if (!inst || inst.side === side) return project
  const def = project.defs[inst.defId]
  if (!def) return updatePart(project, id, { side })
  const before = boundsOf(footprint(def, inst))
  const flipped = { ...inst, side }
  const after = boundsOf(footprint(def, flipped))
  return updatePart(project, id, {
    side,
    x: inst.x + (before.minX - after.minX),
    y: inst.y + (before.minY - after.minY),
  })
}

/** Removing a part also drops any wire bound to one of its pins. */
export function removeParts(project: Project, ids: string[]): Project {
  const set = new Set(ids)
  const bound = (a: Anchor) => a.kind === 'pin' && set.has(a.partId)
  return {
    ...project,
    parts: project.parts.filter((p) => !set.has(p.id)),
    wires: project.wires.filter((w) => !bound(w.from) && !bound(w.to)),
  }
}

export function addWire(project: Project, wire: Omit<Wire, 'id'>): Project {
  return { ...project, wires: [...project.wires, { ...wire, id: uid('wire') }] }
}

export function updateWire(project: Project, id: string, patch: Partial<Wire>): Project {
  return {
    ...project,
    wires: project.wires.map((w) => (w.id === id ? { ...w, ...patch } : w)),
  }
}

export function removeWires(project: Project, ids: string[]): Project {
  const set = new Set(ids)
  return { ...project, wires: project.wires.filter((w) => !set.has(w.id)) }
}

export type Stacking = 'front' | 'forward' | 'backward' | 'back'

/**
 * Reorders a same-side-stacked list in place: `front`/`back` move the whole
 * selection to the ends; `forward`/`backward` swap each selected item with
 * its nearest same-side neighbour, so a one-item step actually changes
 * what's visibly on top instead of being absorbed by an other-side item
 * sitting in between in the raw array. Shared by `reorderParts` and
 * `reorderWires`, whose array order IS paint order — Canvas.tsx renders
 * each side's parts, then that side's wires, each in a filtered pass over
 * its own array.
 */
function reorderBySide<T extends { id: string; side: Side }>(list: T[], ids: string[], stacking: Stacking): T[] {
  const selected = new Set(ids)
  if (selected.size === 0) return list

  if (stacking === 'front' || stacking === 'back') {
    const picked = list.filter((x) => selected.has(x.id))
    const rest = list.filter((x) => !selected.has(x.id))
    return stacking === 'front' ? [...rest, ...picked] : [...picked, ...rest]
  }

  // One step per selected item. Process the topmost first when raising and
  // the bottommost first when lowering, so movers step past each other
  // instead of the array shuffling out from under a later swap.
  let items = list
  const order = [...ids].sort((a, b) => {
    const ia = items.findIndex((x) => x.id === a)
    const ib = items.findIndex((x) => x.id === b)
    return stacking === 'forward' ? ib - ia : ia - ib
  })

  for (const id of order) {
    const item = items.find((x) => x.id === id)
    if (!item) continue
    const sameSide = items.filter((x) => x.side === item.side)
    const si = sameSide.findIndex((x) => x.id === id)
    const ni = stacking === 'forward' ? si + 1 : si - 1
    if (ni < 0 || ni >= sameSide.length) continue
    const neighbor = sameSide[ni]
    const ai = items.findIndex((x) => x.id === id)
    const bi = items.findIndex((x) => x.id === neighbor.id)
    const next = items.slice()
    ;[next[ai], next[bi]] = [next[bi], next[ai]]
    items = next
  }

  return items
}

export function reorderWires(project: Project, ids: string[], stacking: Stacking): Project {
  return { ...project, wires: reorderBySide(project.wires, ids, stacking) }
}

export function reorderParts(project: Project, ids: string[], stacking: Stacking): Project {
  return { ...project, parts: reorderBySide(project.parts, ids, stacking) }
}

/**
 * Reorders parts, and carries their connected wires along with them: any
 * wire with a pin anchor bound to one of these parts gets the same stacking
 * command applied within `project.wires`. Otherwise a wire's position in the
 * stack (chosen relative to other WIRES) would drift out of sync with the
 * part it's soldered to (chosen relative to other PARTS) the moment either
 * one is reordered on its own.
 */
export function reorderPartsAndWires(project: Project, partIds: string[], stacking: Stacking): Project {
  const ids = new Set(partIds)
  const bound = (a: Anchor) => a.kind === 'pin' && ids.has(a.partId)
  const wireIds = project.wires.filter((w) => bound(w.from) || bound(w.to)).map((w) => w.id)
  return reorderWires(reorderParts(project, partIds, stacking), wireIds, stacking)
}

export function putDef(project: Project, def: PartDef): Project {
  return { ...project, defs: { ...project.defs, [def.id]: def } }
}

/** Deleting a definition also removes every placed instance of it (and any
 *  wire bound to one of their pins), so the board never references a missing def. */
export function removeDef(project: Project, defId: string): Project {
  const instanceIds = project.parts.filter((p) => p.defId === defId).map((p) => p.id)
  const withoutInstances = removeParts(project, instanceIds)
  const defs = Object.fromEntries(Object.entries(withoutInstances.defs).filter(([id]) => id !== defId))
  return { ...withoutInstances, defs }
}



/** Assets referenced by no definition can be dropped when saving. */
export function usedAssetIds(project: Project): Set<string> {
  const used = new Set<string>()
  for (const def of Object.values(project.defs)) {
    if (def.texture) used.add(def.texture.assetId)
  }
  return used
}

/**
 * Which objects the canvas should not draw.
 *
 * Hiding is purely a view concern: `computeNets` never consults this, so a
 * hidden part still occupies its holes and still belongs to its nets. The only
 * thing that changes is what is painted and what can be clicked.
 *
 * Hiding a component also hides the wiring attached to it, which is the point
 * of the feature — a component you have visually removed should not leave its
 * cables floating in mid-air. "Attached" means either endpoint is a pin anchor
 * bound to the part, or a hole anchor sitting in one of that part's pin holes
 * (the same physical join, drawn before the part was placed).
 */

import { partPinPositions } from './geometry'
import type { Anchor, Project } from './types'

export interface Hidden {
  parts: Set<string>
  wires: Set<string>
}

export const NOTHING_HIDDEN: Hidden = { parts: new Set(), wires: new Set() }

export function hiddenIds(project: Project): Hidden {
  const parts = new Set<string>()
  for (const inst of project.parts) if (inst.hidden) parts.add(inst.id)
  if (parts.size === 0) return NOTHING_HIDDEN

  // Holes that ONLY hidden parts occupy. A hole shared with a visible part is
  // still a visible join, so a wire ending there must keep showing.
  const holes = new Set<string>()
  for (const inst of project.parts) {
    const def = project.defs[inst.defId]
    if (!def) continue
    for (const pos of partPinPositions(def, inst).values()) {
      const key = `${pos.x},${pos.y}`
      if (inst.hidden) holes.add(key)
    }
  }
  for (const inst of project.parts) {
    if (inst.hidden) continue
    const def = project.defs[inst.defId]
    if (!def) continue
    for (const pos of partPinPositions(def, inst).values()) holes.delete(`${pos.x},${pos.y}`)
  }

  const touchesHidden = (a: Anchor): boolean =>
    (a.kind === 'pin' && parts.has(a.partId)) || (a.kind === 'hole' && holes.has(`${a.x},${a.y}`))

  const wires = new Set<string>()
  for (const w of project.wires) if (touchesHidden(w.from) || touchesHidden(w.to)) wires.add(w.id)
  return { parts, wires }
}

/** Drop anything newly hidden from a selection, so it cannot be nudged or deleted unseen. */
export function pruneSelection<T extends { parts: string[]; wires: string[] }>(
  sel: T,
  hidden: Hidden,
): T {
  return {
    ...sel,
    parts: sel.parts.filter((id) => !hidden.parts.has(id)),
    wires: sel.wires.filter((id) => !hidden.wires.has(id)),
  }
}

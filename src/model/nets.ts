import { anchorPos, distToSegment, partPinPositions } from './geometry'
import { boardPads } from './pads'
import { isHole } from './project'
import type { Anchor, Project, Vec } from './types'

/**
 * Connectivity.
 *
 * Fritzing has no net objects at all — it re-walks pairwise connections on
 * demand. We derive real nets with union-find instead, which is what makes
 * branching free: a hole is a shared node, so three wires landing in one hole
 * are one net without any special "tap into a wire" machinery.
 */

export type NodeId = string

export const holeNode = (x: number, y: number): NodeId => `h:${x},${y}`
export const pinNode = (partId: string, pinId: string): NodeId => `p:${partId}:${pinId}`
export const freeNode = (wireId: string, end: 'a' | 'b'): NodeId => `f:${wireId}:${end}`

export function anchorNode(a: Anchor, wireId: string, end: 'a' | 'b'): NodeId {
  switch (a.kind) {
    case 'hole':
      return holeNode(a.x, a.y)
    case 'pin':
      return pinNode(a.partId, a.pinId)
    case 'free':
      return freeNode(wireId, end)
  }
}

class UnionFind {
  private parent = new Map<NodeId, NodeId>()

  find(a: NodeId): NodeId {
    let root = this.parent.get(a)
    if (root === undefined) {
      this.parent.set(a, a)
      return a
    }
    while (root !== this.parent.get(root)) root = this.parent.get(root) as NodeId
    // Path compression.
    let cur = a
    while (cur !== root) {
      const next = this.parent.get(cur) as NodeId
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: NodeId, b: NodeId): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }

  has(a: NodeId): boolean {
    return this.parent.has(a)
  }

  nodes(): NodeId[] {
    return [...this.parent.keys()]
  }
}

export interface Net {
  id: string
  name?: string
  nodes: NodeId[]
  wireIds: string[]
  pinNodes: NodeId[]
  holeNodes: NodeId[]
  /** Distinct parts this net reaches. See netIsConnected for the "connected" rule. */
  partIds: string[]
}

export interface Netlist {
  nets: Net[]
  /** node -> net id */
  byNode: Map<NodeId, string>
  /** wire id -> net id */
  byWire: Map<string, string>
  /** "x,y" -> pin nodes occupying that hole */
  pinsByHole: Map<string, { partId: string; pinId: string; node: NodeId }[]>
  pinPos: Map<string, Vec>
}

const key = (p: Vec) => `${p.x},${p.y}`

export function computeNets(project: Project): Netlist {
  const uf = new UnionFind()
  const pinPos = new Map<string, Vec>()
  const pinsByHole = new Map<string, { partId: string; pinId: string; node: NodeId }[]>()

  // A pin passes through the board, so it bonds to its hole regardless of
  // which side the part is mounted on.
  for (const inst of project.parts) {
    const def = project.defs[inst.defId]
    if (!def) continue
    const positions = partPinPositions(def, inst)
    for (const [pinId, pos] of positions) {
      const pn = pinNode(inst.id, pinId)
      pinPos.set(`${inst.id}:${pinId}`, pos)
      uf.find(pn)
      if (isHole(project, pos.x, pos.y)) {
        uf.union(pn, holeNode(pos.x, pos.y))
        const k = key(pos)
        const list = pinsByHole.get(k) ?? []
        list.push({ partId: inst.id, pinId, node: pn })
        pinsByHole.set(k, list)
      }
    }
  }

  const wireNodes = new Map<string, [NodeId, NodeId]>()
  for (const w of project.wires) {
    const a = anchorNode(w.from, w.id, 'a')
    const b = anchorNode(w.to, w.id, 'b')
    wireNodes.set(w.id, [a, b])
    uf.union(a, b)
  }

  // A wire that ends on a bare hole is a real physical join wherever it
  // touches another wire's run, not only when both wires declare the exact
  // same hole as their own endpoint — a bend, or any point along a straight
  // run, is just as electrically real. This checks each wire's own HOLE
  // endpoints (a deliberate landing spot) against every other wire's path;
  // it does not check part pins, because a wire merely passing over an
  // unrelated pin's hole (insulated, routed across the board) is not a
  // connection — only where a wire was actually terminated is.
  const holeEndpoints: { pos: Vec; wireId: string }[] = []
  for (const w of project.wires) {
    if (w.from.kind === 'hole') holeEndpoints.push({ pos: { x: w.from.x, y: w.from.y }, wireId: w.id })
    if (w.to.kind === 'hole') holeEndpoints.push({ pos: { x: w.to.x, y: w.to.y }, wireId: w.id })
  }
  const pinLookup = (partId: string, pinId: string) => pinPos.get(`${partId}:${pinId}`)
  const TAP_EPS = 1e-6
  for (const w of project.wires) {
    const from = anchorPos(w.from, pinLookup)
    const to = anchorPos(w.to, pinLookup)
    if (!from || !to) continue
    const path = [from, ...w.waypoints, to]
    const wireNode = wireNodes.get(w.id)?.[0]
    if (!wireNode) continue
    for (const ep of holeEndpoints) {
      if (ep.wireId === w.id) continue
      for (let i = 0; i < path.length - 1; i++) {
        if (distToSegment(ep.pos, path[i], path[i + 1]) < TAP_EPS) {
          uf.union(holeNode(ep.pos.x, ep.pos.y), wireNode)
          break
        }
      }
    }
  }

  // An edge pad is one piece of copper over two holes, so its cells are
  // one node. This runs AFTER parts and wires and only bonds cells something
  // already references: a board can carry hundreds of pads, and materialising
  // a node for every one of them would litter the netlist with empty nets.
  for (const board of project.boards) {
    if (!board.padEdges?.length) continue
    for (const cells of boardPads(board)) {
      const present = cells.map((c) => holeNode(c.x, c.y)).filter((n) => uf.has(n))
      for (let i = 1; i < present.length; i++) uf.union(present[0], present[i])
    }
  }

  const groups = new Map<NodeId, NodeId[]>()
  for (const n of uf.nodes()) {
    const root = uf.find(n)
    const list = groups.get(root) ?? []
    list.push(n)
    groups.set(root, list)
  }

  const nets: Net[] = []
  const byNode = new Map<NodeId, string>()
  const byWire = new Map<string, string>()
  const rootToNet = new Map<NodeId, Net>()

  let i = 0
  for (const [root, nodes] of groups) {
    const net: Net = {
      id: `net${i++}`,
      nodes,
      wireIds: [],
      pinNodes: nodes.filter((n) => n.startsWith('p:')),
      holeNodes: nodes.filter((n) => n.startsWith('h:')),
      partIds: [],
    }
    const parts = new Set<string>()
    for (const n of net.pinNodes) parts.add(n.split(':')[1])
    net.partIds = [...parts]
    for (const n of nodes) byNode.set(n, net.id)
    rootToNet.set(root, net)
    nets.push(net)
  }

  for (const w of project.wires) {
    const pair = wireNodes.get(w.id)
    if (!pair) continue
    const net = rootToNet.get(uf.find(pair[0]))
    if (!net) continue
    net.wireIds.push(w.id)
    byWire.set(w.id, net.id)
    // A net's name is whichever of its wires carries one.
    if (w.net && !net.name) net.name = w.net
  }

  return { nets, byNode, byWire, pinsByHole, pinPos }
}

export function netOfNode(list: Netlist, node: NodeId): Net | undefined {
  const id = list.byNode.get(node)
  if (!id) return undefined
  return list.nets.find((n) => n.id === id)
}

/**
 * A connector is "connected" when its net reaches >= 2 parts (Fritzing's
 * rule), OR when >= 2 wires meet in it. The latter covers a wire spliced
 * onto another wire at a shared hole with no part there — a real physical
 * join, not a dangling stub, even before the run reaches a second component.
 */
export function netIsConnected(net: Net | undefined): boolean {
  if (!net) return false
  return net.partIds.length >= 2 || net.wireIds.length >= 2
}

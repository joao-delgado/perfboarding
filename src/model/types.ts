/**
 * Core document model.
 *
 * Coordinates: everything on the board is in HOLE UNITS. A hole at column 3,
 * row 5 is literally {x: 3, y: 5}. Pixels are derived at render time only.
 * The canonical frame is always TOP VIEW; looking at the board from below is a
 * render-time mirror, not a second coordinate system.
 */

export type Side = 'top' | 'bottom'
export type Rotation = 0 | 90 | 180 | 270

export interface Vec {
  x: number
  y: number
}

/** A pin sits on exactly one hole, in part-local hole units. */
export interface PinDef {
  id: string
  name: string
  x: number
  y: number
}

/**
 * A node on an editable path.
 *
 * Handles are ABSOLUTE coordinates in the same frame as the node, not deltas.
 * That makes every transform — translate, scale, mirror — a plain point
 * transform with no special-casing, which is the whole reason for the choice.
 * A node with neither handle joins its neighbours with a straight line.
 */
export interface PathNode {
  x: number
  y: number
  /** Control point towards the previous node. */
  hIn?: Vec
  /** Control point towards the next node. */
  hOut?: Vec
}

interface OutlineShapeBase {
  id: string
  name?: string
  hidden?: boolean
  /**
   * Cut this shape out of the body instead of adding to it. Implemented by
   * emitting the subpath with reversed winding under fill-rule: nonzero, which
   * is exact and costs nothing — no boolean geometry, no mask.
   * Meaningless on an open path, which is stroked rather than filled.
   */
  subtract?: boolean
}

/**
 * One sub-shape of a part body, in part-local hole units on half-hole steps.
 * Every shape is filled area — a "line" (drawn with the Line tool) is just a
 * thin rectangle, not a special stroked case. `closed` exists only to let the
 * editor represent a pen run that is still being drawn; anything actually
 * saved in a project is always closed.
 */
export type OutlineShape =
  | (OutlineShapeBase & { kind: 'path'; nodes: PathNode[]; closed: boolean })
  | (OutlineShapeBase & { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number })
  | (OutlineShapeBase & { kind: 'rect'; x: number; y: number; w: number; h: number })

/**
 * The part body: any number of sub-shapes. By default every shape ADDS to the
 * body — they are combined with a real geometric union, so overlapping shapes
 * never show a seam where their edges used to coincide. A `subtract` shape is
 * instead cut out of that union. See `model/shapes.ts#outlineUnion`.
 */
export interface Outline {
  shapes: OutlineShape[]
  /**
   * Fillet applied to the corners of the FINISHED silhouette, in hole units.
   * It is a property of the whole body rather than of any one sub-shape,
   * because the corners you see belong to the union, not to the rectangles
   * that produced it. Clamped per corner to half the shorter adjacent edge,
   * so a large radius degrades gracefully instead of self-intersecting.
   */
  cornerRadius?: number
}

/** An uploaded image placed over the body, under the vector artwork. */
export interface Texture {
  assetId: string
  x: number
  y: number
  w: number
  h: number
  opacity: number
  clipToOutline: boolean
}

export type ArtAlign = 'start' | 'middle' | 'end'

interface ArtBase {
  id: string
  name: string
  /**
   * Where the shape's local origin sits, in part-local hole units.
   * Deliberately NOT grid-snapped: artwork is decoration, not geometry.
   */
  x: number
  y: number
  /** Degrees clockwise about the LOCAL ORIGIN, which is (0,0) for every kind. */
  rotation: number
  opacity: number
  hidden?: boolean
  locked?: boolean
  /** CSS colour, or the literal 'none'. */
  fill: string
  stroke: string
  strokeWidth: number
}

/**
 * A shape in a part's decorative artwork.
 *
 * Every kind is authored so its local origin is the natural rotation centre:
 * rect and ellipse are centred on (0,0), a path is re-centred on its bounding
 * box after each edit, and text rotates about its anchor. That uniformity is
 * what lets `artTransform` be `translate(x,y) rotate(r)` with no bounds lookup,
 * so the editor and the board render a shape identically.
 */
export type ArtShape =
  | (ArtBase & { kind: 'rect'; w: number; h: number; radius: number })
  | (ArtBase & { kind: 'ellipse'; rx: number; ry: number })
  | (ArtBase & { kind: 'path'; nodes: PathNode[]; closed: boolean })
  | (ArtBase & {
      kind: 'text'
      text: string
      fontSize: number
      fontFamily: string
      bold: boolean
      italic: boolean
      align: ArtAlign
    })

export interface Artwork {
  /** Bottom-most first, exactly like SVG paint order. */
  shapes: ArtShape[]
  /** Mask the whole stack to the part body. */
  clipToOutline: boolean
}

export interface PartDef {
  id: string
  name: string
  /** Designator prefix: R, C, U, SW... */
  prefix: string
  outline: Outline
  pins: PinDef[]
  /** Optional bitmap/SVG backdrop, painted under the vector artwork. */
  texture?: Texture
  /** Vector artwork painted over the body. */
  artwork?: Artwork
  fill: string
  stroke: string
  builtin?: boolean
}

export interface PartInstance {
  id: string
  defId: string
  /** Board position of the part's local origin, in hole units. */
  x: number
  y: number
  rotation: Rotation
  side: Side
  ref: string
  locked?: boolean
  /**
   * Hidden from the canvas (the Components panel's eye toggle). Purely a view
   * property: a hidden part still occupies its holes and still takes part in
   * `computeNets`, so hiding can never change what the project means
   * electrically. See `model/visibility.ts`.
   */
  hidden?: boolean
}

/**
 * A wire endpoint. Holes and pins are electrical; 'free' is a deliberate
 * dangling end (a lead going off-board) and never counts as connected.
 */
export type Anchor =
  | { kind: 'hole'; x: number; y: number }
  | { kind: 'pin'; partId: string; pinId: string }
  | { kind: 'free'; x: number; y: number }

export interface Wire {
  id: string
  side: Side
  color: string
  /** Two-tone jumper rendering, as in Fritzing's banded wires. */
  banded?: boolean
  from: Anchor
  to: Anchor
  /** Intermediate bends. One wire owns its whole polyline. */
  waypoints: Vec[]
  /** User-assigned net name; shared across every wire in the same net. */
  net?: string
}

/** Which edge of a board a pad strip runs along. */
export type BoardEdge = 'left' | 'right' | 'top' | 'bottom'

export interface Board {
  id: string
  name: string
  /** Canvas position of the board's hole (0,0), in canvas hole units. */
  x: number
  y: number
  cols: number
  rows: number
  /** Substrate colour. Default is PCB green. */
  color: string
  /** Copper pad ring colour. */
  padColor: string
  /**
   * Edges carrying a run of oblong bus pads, outside the hole lattice.
   * Absent or empty means a plain board. See `model/pads.ts` — the pad shape
   * is fixed (two cells reaching outward), so an edge is all there is to store.
   */
  padEdges?: BoardEdge[]
}

export interface AssetMeta {
  mime: string
  name: string
}

export interface Project {
  version: 1
  name: string
  boards: Board[]
  defs: Record<string, PartDef>
  parts: PartInstance[]
  wires: Wire[]
  assets: Record<string, AssetMeta>
}

export const MIN_DIM = 3
export const MAX_DIM = 199

export const DEFAULT_BOARD_COLOR = '#15703F'
export const DEFAULT_PAD_COLOR = '#D9B23C'


import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  anchorPos,
  boundsFromCorners,
  boundsOf,
  boundsOverlap,
  constrain8,
  distToSegment,
  orthoAssist,
  partPinPositions,
  pointInPolygon,
  segmentIntersectsBounds,
  MM_PER_HOLE,
  PITCH_PX,
  snapToHole,
  type Bounds,
} from '../model/geometry'
import { computeNets } from '../model/nets'
import { hiddenIds } from '../model/visibility'
import { boardExtent } from '../model/pads'
import { partOutlinePoints } from '../model/shapes'
import { boardAt, contentBounds, isHole, moveBoard } from '../model/project'
import {
  addPart,
  addWire,
  removeParts,
  removeWires,
  rotateParts,
  updatePart,
  updateWire,
} from '../model/project'
import { commit, EMPTY_SELECTION, getState, selectOne, set, useEditor } from '../model/store'
import type { Anchor, PartInstance, Vec, Wire } from '../model/types'
import { BoardSurface, CanvasDefs, CanvasGrid } from './Board'
import { PartGhost, PartView, PinTarget } from './PartView'
import { Ruler } from './Ruler'
import { fitBox, rootTransform, screenToWorld, worldToScreen, type View, zoomAt } from './view'
import { WireView, wirePoints } from './WireView'

/** Width of the millimetre ruler strips along the canvas's top and left edges. */
const RULER_PX = 22

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; lastScreen: Vec }
  | { kind: 'part'; ids: string[]; grabOffset: Map<string, Vec>; moved: boolean }
  | { kind: 'waypoint'; wireId: string; index: number; moved: boolean }
  | { kind: 'endpoint'; wireId: string; end: 'from' | 'to'; moved: boolean }
  | {
      kind: 'segment'
      wireId: string
      index: number
      /** The wire as it was when the drag started, so every frame recomputes
       *  from the same base instead of accumulating. */
      base: Wire
      start: Vec
      startScreen: Vec
      armed: boolean
    }
  | { kind: 'board'; id: string; grabOffset: Vec; moved: boolean }
  | { kind: 'marquee'; start: Vec; current: Vec; additive: boolean; boardId?: string }

interface PendingWire {
  from: Anchor
  waypoints: Vec[]
  cursor: Vec
  /** Screen position of the last click, for the minimum-drag test. */
  downScreen: Vec
}

const HOLE_SNAP = 0.45
const PIN_SNAP = 0.38
/** Fritzing's WireMinLength: below this a drag is a click, not a wire. */
const MIN_DRAG_PX = 6
/** A wire shorter than this is a twitch, not a connection. */
const MIN_WIRE_LEN = 0.4

/* ---- mobile touch gestures --------------------------------------------- */
/** A touch stays a tap, rather than becoming a pan, inside this radius. */
const TAP_SLOP_PX = 10
/** ...and only if it lifts this soon. A long press is not a tap. */
const TAP_MS = 500
/** Finger-sized pick radius for tapping a wire, in screen px. */
const TAP_PICK_PX = 14

/**
 * Translate one segment of a wire, keeping both bound endpoints where they are.
 *
 * A segment that ends at a terminal cannot drag that terminal along — the wire
 * is anchored there — so the terminal grows a new bend instead. Indices are
 * touched high-end first so the low end's insert cannot shift them.
 */
function moveSegment(wire: Wire, index: number, delta: Vec, fromPos: Vec, toPos: Vec): Vec[] {
  const wps = wire.waypoints.map((p) => ({ ...p }))
  const lastIdx = wps.length + 1
  const shift = (p: Vec) => ({ x: p.x + delta.x, y: p.y + delta.y })

  if (index + 1 === lastIdx) wps.push(shift(toPos))
  else wps[index] = shift(wps[index])

  if (index === 0) wps.unshift(shift(fromPos))
  else wps[index - 1] = shift(wps[index - 1])

  return wps
}

function polylineLength(pts: Vec[]): number {
  let n = 0
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return n
}

/**
 * `mobile` puts the canvas in VIEW-ONLY mode: every editing gesture stands
 * down and a touch gesture layer (one finger pans, two pinch-zoom, a tap
 * selects for the Properties panel) takes the pointer stream instead.
 */
export function Canvas({
  assetUrls,
  mobile = false,
}: {
  assetUrls: Record<string, string>
  mobile?: boolean
}) {
  const s = useEditor()
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [drag, setDrag] = useState<Drag>({ kind: 'none' })
  const [pending, setPending] = useState<PendingWire | null>(null)
  const [cursorWorld, setCursorWorld] = useState<Vec | null>(null)
  const [dropAt, setDropAt] = useState<Vec | null>(null)
  const [hoverPin, setHoverPin] = useState<{ label: string; screen: Vec } | null>(null)
  const shiftRef = useRef(false)
  /** Space held = temporary hand tool, Figma-style. The ref is what the
   *  pointer handlers read; the state only exists to repaint the cursor. */
  const spaceRef = useRef(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const lastDown = useRef<{ key: string; t: number } | null>(null)

  const { project, camera, side, tool, selection, showFarSide, showNets, hoverNet, dragDefId } = s
  const loadSeq = s.loadSeq
  /** World-space box covering every board, used for the mirror axis and the
   *  background grid. Measured on the padded extent, so edge pads are inside
   *  it. The axis deliberately tracks the BOARDS and not the whole build:
   *  mirroring about a moving axis would make the view jump every time you
   *  added an off-board part while looking from below. */
  const worldBox = useMemo(() => {
    if (project.boards.length === 0) return { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    const extents = project.boards.map(boardExtent)
    return {
      minX: Math.min(...extents.map((e) => e.minX)) - 1,
      minY: Math.min(...extents.map((e) => e.minY)) - 1,
      maxX: Math.max(...extents.map((e) => e.maxX)) + 1,
      maxY: Math.max(...extents.map((e) => e.maxY)) + 1,
    }
  }, [project.boards])

  /** Components switched off in the Components panel, plus the wiring attached
   *  to them. Hidden objects are neither drawn nor hit-tested — but they stay
   *  in the netlist and keep occupying their holes, because hiding is a view
   *  state, not a deletion. */
  const hidden = useMemo(() => hiddenIds(project), [project])

  const view: View = useMemo(
    () => ({
      camera,
      mirrored: side === 'bottom',
      mirrorAxis: (worldBox.minX + worldBox.maxX) / 2,
    }),
    [camera, side, worldBox],
  )

  /** World rect the dot grid covers: whatever the viewport currently sees,
   *  padded a little. Sizing it from the artwork instead left bare canvas
   *  wherever the window was wider than the build — the grid has to read as
   *  infinite paper, so it follows the camera, not the document. */
  const gridBox = useMemo(() => {
    const a = screenToWorld(view, { x: 0, y: 0 })
    const b = screenToWorld(view, { x: size.w, y: size.h })
    return {
      minX: Math.floor(Math.min(a.x, b.x)) - 2,
      minY: Math.floor(Math.min(a.y, b.y)) - 2,
      maxX: Math.ceil(Math.max(a.x, b.x)) + 2,
      maxY: Math.ceil(Math.max(a.y, b.y)) + 2,
    }
  }, [view, size])

  const netlist = useMemo(() => computeNets(project), [project])

  const pinAt = useCallback(
    (partId: string, pinId: string) => netlist.pinPos.get(`${partId}:${pinId}`),
    [netlist],
  )

  // Track viewport size so we can fit the board.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * Frame the WHOLE build — boards, off-board parts and every wire.
   *
   * Two separate bugs used to leave a freshly opened project off-centre:
   * fitting the BOARD extents alone pushed anything hanging off the boards (a
   * battery, a panel switch and their wiring) out of frame, and the single
   * fit ran on the first viewport measurement, which is taken before the
   * layout has settled — so the camera was framed for a canvas much smaller
   * than the one you end up looking at.
   *
   * So: re-fit on `loadSeq` (session restore, file open, New) and on every
   * later viewport change until the user moves the camera themselves. Once
   * they have panned or zoomed, the framing is theirs and resizing the window
   * must not throw it away. Content changes never re-fit — the camera may not
   * jump while you are drawing.
   */
  const fittedSeq = useRef(-1)
  const cameraMoved = useRef(false)

  /**
   * Frame the whole build right now.
   *
   * Project and side are read LIVE through `getState()` rather than closed
   * over, which is what keeps an edit from ever re-framing the canvas: this
   * callback's identity only changes with the viewport and the board extents.
   */
  const applyFit = useCallback(() => {
    if (size.w < 50) return
    const st = getState()
    const box = contentBounds(st.project)
    const axis = (worldBox.minX + worldBox.maxX) / 2
    // fitBox works in unmirrored screen space, so from below we fit the
    // reflected box — otherwise the frame is off by twice the distance
    // between the build's centre and the mirror axis.
    const framed =
      st.side === 'bottom'
        ? { ...box, minX: 2 * axis - box.maxX, maxX: 2 * axis - box.minX }
        : box
    // fitBox's default margin is a fixed 70px, which is a sane frame on a
    // desktop window and a third of the width of a phone in portrait. A
    // narrow viewport has none to spare, and FIT_FILL already keeps the
    // build off the edges proportionally.
    set({ camera: fitBox(framed, size.w, size.h, mobile ? 14 : undefined) })
  }, [size, worldBox, mobile])

  useEffect(() => {
    if (size.w < 50) return
    const reload = fittedSeq.current !== loadSeq
    if (!reload && cameraMoved.current) return
    fittedSeq.current = loadSeq
    cameraMoved.current = false
    applyFit()
  }, [size, loadSeq, worldBox, applyFit])

  /**
   * An explicit "fit" from the UI (`requestFit()`), which is the only way back
   * on a touch device once you have panned off into empty paper. It hands the
   * framing back to the app until the user moves the camera again.
   */
  const fittedFitSeq = useRef(s.fitSeq)
  useEffect(() => {
    if (fittedFitSeq.current === s.fitSeq) return
    fittedFitSeq.current = s.fitSeq
    cameraMoved.current = false
    applyFit()
  }, [s.fitSeq, applyFit])

  // Wheel must be non-passive or the browser page-zooms on trackpad pinch.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cameraMoved.current = true
      const rect = el.getBoundingClientRect()
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const cam = getState().camera
      if (e.ctrlKey) {
        // Trackpad pinch arrives as a wheel event with ctrlKey set.
        set({ camera: zoomAt(cam, p, Math.exp(-e.deltaY / 100)) })
      } else if (e.metaKey) {
        set({ camera: zoomAt(cam, p, Math.exp(-e.deltaY / 200)) })
      } else {
        set({ camera: { ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY } })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }): Vec => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      return screenToWorld(view, { x: e.clientX - rect.left, y: e.clientY - rect.top })
    },
    [view],
  )

  /**
   * Recognise our own double-clicks on wire handles.
   *
   * We cannot use the browser's: a pointerdown that calls setPointerCapture
   * makes the compatibility mouse events — click and dblclick included — fire
   * at the capturing element, so a dblclick on a bend arrives at the <svg>.
   */
  const doubleClicked = useCallback((key: string): boolean => {
    const now = performance.now()
    const prev = lastDown.current
    lastDown.current = { key, t: now }
    return !!prev && prev.key === key && now - prev.t < 400
  }, [])

  /** Every drag captures on the root svg, so one pointerup releases it. */
  const capture = useCallback((e: React.PointerEvent) => {
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      // Some pointer types refuse capture; the drag still works via bubbling.
    }
  }, [])

  /** Resolve a world point to a wire anchor: pin, else hole, else free. */
  const resolveAnchor = useCallback(
    (w: Vec): Anchor => {
      let best: { d: number; a: Anchor } | null = null
      for (const inst of project.parts) {
        if (hidden.parts.has(inst.id)) continue
        const def = project.defs[inst.defId]
        if (!def) continue
        for (const [pinId, pos] of partPinPositions(def, inst)) {
          const d = Math.hypot(pos.x - w.x, pos.y - w.y)
          if (d <= PIN_SNAP && (!best || d < best.d)) {
            best = { d, a: { kind: 'pin', partId: inst.id, pinId } }
          }
        }
      }
      if (best) return best.a
      const h = snapToHole(w)
      if (isHole(project, h.x, h.y) && Math.hypot(h.x - w.x, h.y - w.y) <= HOLE_SNAP) {
        return { kind: 'hole', x: h.x, y: h.y }
      }
      return { kind: 'free', x: Math.round(w.x * 4) / 4, y: Math.round(w.y * 4) / 4 }
    },
    [project, hidden],
  )

  /**
   * Nearest pin under a world point, near-side parts winning ties, so hovering
   * a hole shared by both sides favours the one you are actually looking at.
   * Far-side pins still qualify — that is the point, so a part on the other
   * face still identifies itself when you hover its hole.
   */
  const findHoverPin = useCallback(
    (w: Vec): { label: string; pos: Vec } | null => {
      let best: { d: number; label: string; pos: Vec } | null = null
      const consider = (inst: PartInstance) => {
        if (hidden.parts.has(inst.id)) return
        const def = project.defs[inst.defId]
        if (!def) return
        for (const [pinId, pos] of partPinPositions(def, inst)) {
          const d = Math.hypot(pos.x - w.x, pos.y - w.y)
          if (d <= PIN_SNAP && (!best || d < best.d)) {
            const pin = def.pins.find((p) => p.id === pinId)
            best = { d, label: `${inst.ref} · ${pin?.name ?? pinId}`, pos }
          }
        }
      }
      for (const inst of project.parts) if (inst.side === side) consider(inst)
      for (const inst of project.parts) if (inst.side !== side) consider(inst)
      return best
    },
    [project, side, hidden],
  )

  /** Bends want the lattice when they are over it, and quarter steps when not. */
  const snapPoint = useCallback(
    (w: Vec): Vec => {
      const h = snapToHole(w)
      if (isHole(project, h.x, h.y) && Math.hypot(h.x - w.x, h.y - w.y) <= HOLE_SNAP) return h
      return { x: Math.round(w.x * 4) / 4, y: Math.round(w.y * 4) / 4 }
    },
    [project],
  )

  const partUnder = useCallback(
    (w: Vec): string | null => {
      // Topmost first, and only on the side we are working on.
      for (let i = project.parts.length - 1; i >= 0; i--) {
        const inst = project.parts[i]
        if (inst.side !== side || hidden.parts.has(inst.id)) continue
        const def = project.defs[inst.defId]
        if (!def) continue
        if (pointInPolygon(w, partOutlinePoints(def, inst))) return inst.id
      }
      return null
    },
    [project, side, hidden],
  )

  /** A hole that already holds someone else's pin cannot take another. */
  const blockedFor = useCallback(
    (ignore: Set<string>) =>
      (pos: Vec): boolean => {
        if (!isHole(project, pos.x, pos.y)) return true
        const list = netlist.pinsByHole.get(`${pos.x},${pos.y}`) ?? []
        return list.some((p) => !ignore.has(p.partId))
      },
    [project, netlist],
  )

  // ---- mobile: view-only touch gestures -----------------------------------

  /**
   * What a tap selects. Parts win, then wires (with a finger-sized pick
   * radius), then the board under the finger — the same precedence a desktop
   * click has, minus the drag that would follow it.
   */
  const tapAt = useCallback(
    (screen: Vec) => {
      const w = screenToWorld(view, screen)
      const pid = partUnder(w)
      if (pid) {
        set({ selection: { parts: [pid], wires: [], boards: [] }, hoverNet: null })
        return
      }
      // Measured in screen px so the target stays finger-sized at every zoom.
      const tol = TAP_PICK_PX / (camera.zoom * PITCH_PX)
      let best: { d: number; id: string } | null = null
      for (const wire of project.wires) {
        if (wire.side !== side || hidden.wires.has(wire.id)) continue
        const pts = wirePoints(wire, pinAt)
        for (let i = 0; i < pts.length - 1; i++) {
          const d = distToSegment(w, pts[i], pts[i + 1])
          if (d <= tol && (!best || d < best.d)) best = { d, id: wire.id }
        }
      }
      if (best) {
        set({
          selection: { parts: [], wires: [best.id], boards: [] },
          hoverNet: netlist.byWire.get(best.id) ?? null,
        })
        return
      }
      const board = boardAt(project, Math.round(w.x), Math.round(w.y))
      if (board) selectOne('boards', board.id, false)
      else set({ selection: EMPTY_SELECTION, hoverNet: null })
    },
    [view, camera.zoom, project, side, hidden, partUnder, pinAt, netlist],
  )
  const tapRef = useRef(tapAt)
  useEffect(() => {
    tapRef.current = tapAt
  }, [tapAt])

  /**
   * One finger pans, two pinch-zoom, a tap selects. Nothing here edits the
   * document — on a touch device this is a viewer.
   *
   * The listeners are native and registered in the CAPTURE phase on purpose:
   * parts and wires call `stopPropagation` on pointerdown, so a bubbling
   * listener would lose the second finger of a pinch that happened to start on
   * a component. The React handlers all stand down while `mobile` is set, so
   * this is the only thing reading the pointer stream.
   */
  useEffect(() => {
    if (!mobile) return
    const el = svgRef.current
    if (!el) return

    const pts = new Map<number, Vec>()
    let mode: 'none' | 'pan' | 'pinch' = 'none'
    /** Screen position the pan last saw, so each frame applies a delta. */
    let last: Vec = { x: 0, y: 0 }
    let pinchDist = 0
    let pinchMid: Vec = { x: 0, y: 0 }
    let downAt: Vec | null = null
    let downTime = 0
    let moved = false

    const local = (p: Vec): Vec => {
      const r = el.getBoundingClientRect()
      return { x: p.x - r.left, y: p.y - r.top }
    }
    const two = (): [Vec, Vec] => {
      const [a, b] = [...pts.values()]
      return [a, b]
    }

    const onDown = (e: PointerEvent) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // Some pointer types refuse capture; bubbling still delivers the moves.
      }
      if (pts.size === 1) {
        mode = 'pan'
        last = { x: e.clientX, y: e.clientY }
        downAt = { ...last }
        downTime = performance.now()
        moved = false
      } else if (pts.size === 2) {
        mode = 'pinch'
        const [a, b] = two()
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
        pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        // A second finger is never part of a tap.
        moved = true
      }
    }

    const onMove = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (mode === 'pinch' && pts.size >= 2) {
        const [a, b] = two()
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        if (pinchDist > 0) {
          cameraMoved.current = true
          // Zoom about the midpoint, then follow the midpoint's own travel, so
          // a pinch that also slides pans at the same time.
          const zoomed = zoomAt(getState().camera, local(pinchMid), dist / pinchDist)
          set({
            camera: {
              ...zoomed,
              x: zoomed.x + (mid.x - pinchMid.x),
              y: zoomed.y + (mid.y - pinchMid.y),
            },
          })
        }
        pinchDist = dist
        pinchMid = mid
        return
      }

      if (mode === 'pan') {
        if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > TAP_SLOP_PX) {
          moved = true
        }
        const dx = e.clientX - last.x
        const dy = e.clientY - last.y
        last = { x: e.clientX, y: e.clientY }
        if (!moved) return
        cameraMoved.current = true
        const cam = getState().camera
        set({ camera: { ...cam, x: cam.x + dx, y: cam.y + dy } })
      }
    }

    const onUp = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // already released
      }
      if (pts.size === 1) {
        // A pinch that lost a finger keeps panning with the one still down.
        mode = 'pan'
        const [p] = [...pts.values()]
        last = { ...p }
        return
      }
      if (pts.size > 1) return
      if (mode === 'pan' && !moved && downAt && performance.now() - downTime < TAP_MS) {
        tapRef.current(local(downAt))
      }
      mode = 'none'
      downAt = null
    }

    const opts = { capture: true }
    el.addEventListener('pointerdown', onDown, opts)
    el.addEventListener('pointermove', onMove, opts)
    el.addEventListener('pointerup', onUp, opts)
    el.addEventListener('pointercancel', onUp, opts)
    return () => {
      el.removeEventListener('pointerdown', onDown, opts)
      el.removeEventListener('pointermove', onMove, opts)
      el.removeEventListener('pointerup', onUp, opts)
      el.removeEventListener('pointercancel', onUp, opts)
    }
  }, [mobile])

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftRef.current = true
      const target = e.target as HTMLElement
      if (target && /input|textarea/i.test(target.tagName)) return
      // The part editor is a modal over this canvas but does not unmount it,
      // so the board's shortcuts have to stand down while it is open.
      if (document.querySelector('.modal-backdrop')) return

      if (e.code === 'Space') {
        // preventDefault or the page scrolls and, worse, a focused toolbar
        // button re-fires on every key repeat while you pan.
        e.preventDefault()
        if (!spaceRef.current) {
          spaceRef.current = true
          setSpaceHeld(true)
        }
        return
      }

      if (e.key === 'Escape') {
        setPending(null)
        set({ selection: EMPTY_SELECTION, hoverNet: null })
      }
      if (e.key === 'Enter' && pending && pending.waypoints.length > 0)
        finishWire(pending.waypoints[pending.waypoints.length - 1])
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'v') {
          set({ tool: 'select' })
          return
        }
        if (k === 'w') {
          set({ tool: 'wire' })
          return
        }
        if (k === 'q') {
          set({ side: 'top' })
          return
        }
        if (k === 'e') {
          set({ side: 'bottom' })
          return
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        set({
          selection: {
            parts: project.parts
              .filter((p) => p.side === side && !hidden.parts.has(p.id))
              .map((p) => p.id),
            wires: project.wires
              .filter((w) => w.side === side && !hidden.wires.has(w.id))
              .map((w) => w.id),
            boards: [],
          },
        })
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const sel = getState().selection
        if (sel.parts.length || sel.wires.length) {
          e.preventDefault()
          commit((p) => removeWires(removeParts(p, sel.parts), sel.wires))
          set({ selection: EMPTY_SELECTION })
        }
      }
      if (e.key === ']' || e.key === '[') {
        if (getState().selection.parts.length) {
          e.preventDefault()
          const delta = e.key === ']' ? 90 : 270
          commit((p) => rotateParts(p, getState().selection.parts, delta))
        }
      }
      if (e.key.startsWith('Arrow')) {
        const sel = getState().selection
        if (!sel.parts.length) return
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        commit((p) =>
          sel.parts.reduce((acc, id) => {
            const inst = acc.parts.find((q) => q.id === id)
            if (!inst) return acc
            return updatePart(acc, id, { x: inst.x + dx, y: inst.y + dy })
          }, p),
        )
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftRef.current = false
      if (e.code === 'Space') {
        spaceRef.current = false
        setSpaceHeld(false)
      }
    }
    // A keyup that lands on another window never arrives, so the hand tool
    // would stick on. Clear it whenever focus leaves.
    const blur = () => {
      shiftRef.current = false
      spaceRef.current = false
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  })

  // ---- wire drawing -------------------------------------------------------
  function finishWire(at?: Vec) {
    if (!pending) return
    const endPoint = at ?? pending.cursor
    const to = resolveAnchor(endPoint)
    // A double-click delivers a single click first, so the endpoint can be
    // queued as a bend once or twice. Drop every trailing point that coincides
    // with the endpoint, then collapse any remaining consecutive duplicates.
    const pts = [...pending.waypoints]
    while (pts.length > 0) {
      const last = pts[pts.length - 1]
      if (Math.hypot(last.x - endPoint.x, last.y - endPoint.y) >= 0.3) break
      pts.pop()
    }
    const deduped = pts.filter(
      (p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) >= 0.3,
    )
    // A wire that goes nowhere is a twitch. Drop it rather than leaving a stub
    // the user has to hunt for later.
    const start = anchorPos(pending.from, pinAt) ?? endPoint
    if (polylineLength([start, ...deduped, endPoint]) < MIN_WIRE_LEN) {
      setPending(null)
      return
    }
    commit((p) =>
      addWire(p, {
        side,
        color: getState().wireColor,
        banded: getState().banded,
        from: pending.from,
        to,
        waypoints: deduped,
      }),
    )
    setPending(null)
  }

  /**
   * Middle button, right button, Alt, or Space-held: this drag pans, whatever
   * is underneath.
   *
   * Right button is excluded while a wire is pending so right-click can still
   * finish it (`onContextMenu` below) instead of racing a pan.
   *
   * Every handler that would otherwise take the drag calls this first —
   * parts and wires stop propagation before the background handler ever sees
   * the event, so the hand tool has to be checked at each of them rather than
   * once on the <svg>.
   */
  function tryPan(e: React.PointerEvent): boolean {
    if (!(e.button === 1 || (e.button === 2 && !pending) || e.altKey || spaceRef.current)) return false
    capture(e)
    setDrag({ kind: 'pan', lastScreen: { x: e.clientX, y: e.clientY } })
    return true
  }

  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (mobile) return
    const w = toWorld(e)
    if (tryPan(e)) return
    if (tool === 'wire' && e.button === 0) {
      const a = resolveAnchor(w)
      const downScreen = { x: e.clientX, y: e.clientY }
      capture(e)
      if (!pending) {
        setPending({ from: a, waypoints: [], cursor: w, downScreen })
      } else {
        const p = anchorPos(a, pinAt) ?? w
        setPending({ ...pending, waypoints: [...pending.waypoints, p], cursor: p, downScreen })
      }
      return
    }
    if (e.button === 0 && tool === 'select') {
      const hit = partUnder(w)
      if (hit) {
        startPartDrag(hit, w, e)
        return
      }
      capture(e)
      const board = boardAt(project, Math.round(w.x), Math.round(w.y))
      // A board you have already selected drags; otherwise the board surface is
      // rubber-band territory, because that is where the parts are.
      if (board && selection.boards.includes(board.id) && !e.shiftKey) {
        setDrag({
          kind: 'board',
          id: board.id,
          grabOffset: { x: w.x - board.x, y: w.y - board.y },
          moved: false,
        })
        return
      }
      setDrag({ kind: 'marquee', start: w, current: w, additive: e.shiftKey, boardId: board?.id })
    }
  }

  function startPartDrag(id: string, w: Vec, e: React.PointerEvent) {
    const sel = getState().selection
    if (e.shiftKey) {
      selectOne('parts', id, true)
      // Shift-clicking a part out of the selection must not then drag it.
      if (!getState().selection.parts.includes(id)) return
    } else if (!sel.parts.includes(id)) {
      set({ selection: { parts: [id], wires: [], boards: [] } })
    }
    capture(e)
    const ids = getState().selection.parts
    const offsets = new Map<string, Vec>()
    for (const pid of ids) {
      const inst = project.parts.find((p) => p.id === pid)
      if (inst) offsets.set(pid, { x: w.x - inst.x, y: w.y - inst.y })
    }
    setDrag({ kind: 'part', ids, grabOffset: offsets, moved: false })
  }

  function onPointerMove(e: React.PointerEvent) {
    if (mobile) return
    const w = toWorld(e)
    setCursorWorld(w)

    if (drag.kind === 'none') {
      const hit = findHoverPin(w)
      setHoverPin(hit ? { label: hit.label, screen: worldToScreen(view, hit.pos) } : null)
    } else if (hoverPin) {
      setHoverPin(null)
    }

    if (pending) {
      const from = pending.waypoints[pending.waypoints.length - 1] ?? anchorPos(pending.from, pinAt) ?? w
      const guided = shiftRef.current ? constrain8(from, w) : orthoAssist(from, w)
      setPending({ ...pending, cursor: guided })
      return
    }

    if (drag.kind === 'pan') {
      const dx = e.clientX - drag.lastScreen.x
      const dy = e.clientY - drag.lastScreen.y
      cameraMoved.current = true
      set({ camera: { ...getState().camera, x: getState().camera.x + dx, y: getState().camera.y + dy } })
      setDrag({ ...drag, lastScreen: { x: e.clientX, y: e.clientY } })
      return
    }

    if (drag.kind === 'marquee') {
      setDrag({ ...drag, current: w })
      return
    }

    if (drag.kind === 'part') {
      // Snapping the ORIGIN to a whole hole snaps every pin, because pins are
      // at integer local coords and rotation is a multiple of 90. This is the
      // Fritzing single-anchor bug, fixed by construction.
      commit((p) => {
        let next = p
        for (const id of drag.ids) {
          const off = drag.grabOffset.get(id)
          if (!off) continue
          const target = snapToHole({ x: w.x - off.x, y: w.y - off.y })
          next = updatePart(next, id, { x: target.x, y: target.y })
        }
        return next
      }, drag.moved)
      if (!drag.moved) setDrag({ ...drag, moved: true })
      return
    }

    if (drag.kind === 'board') {
      const target = snapToHole({ x: w.x - drag.grabOffset.x, y: w.y - drag.grabOffset.y })
      commit((p) => {
        const board = p.boards.find((b) => b.id === drag.id)
        if (!board) return p
        return moveBoard(p, drag.id, target.x - board.x, target.y - board.y)
      }, drag.moved)
      if (!drag.moved) setDrag({ ...drag, moved: true })
      return
    }

    if (drag.kind === 'waypoint') {
      const wire = project.wires.find((x) => x.id === drag.wireId)
      if (!wire) return
      lastDown.current = null
      const snapped = snapPoint(w)
      commit(
        (p) =>
          updateWire(p, drag.wireId, {
            waypoints: wire.waypoints.map((pt, i) => (i === drag.index ? snapped : pt)),
          }),
        drag.moved,
      )
      if (!drag.moved) setDrag({ ...drag, moved: true })
      return
    }

    if (drag.kind === 'endpoint') {
      const a = resolveAnchor(w)
      commit(
        (p) => updateWire(p, drag.wireId, drag.end === 'from' ? { from: a } : { to: a }),
        drag.moved,
      )
      if (!drag.moved) setDrag({ ...drag, moved: true })
      return
    }

    if (drag.kind === 'segment') {
      const far = Math.hypot(e.clientX - drag.startScreen.x, e.clientY - drag.startScreen.y)
      if (!drag.armed && far < MIN_DRAG_PX) return
      const delta = snapToHole({ x: w.x - drag.start.x, y: w.y - drag.start.y })
      // Below half a hole the move rounds to nothing, and committing it would
      // only litter the wire with duplicate bends.
      if (!drag.armed && delta.x === 0 && delta.y === 0) return
      const fromPos = anchorPos(drag.base.from, pinAt)
      const toPos = anchorPos(drag.base.to, pinAt)
      if (!fromPos || !toPos) return
      const wps = moveSegment(drag.base, drag.index, delta, fromPos, toPos)
      // A segment that has actually moved is not half of a double-click.
      lastDown.current = null
      commit((p) => updateWire(p, drag.wireId, { waypoints: wps }), drag.armed)
      if (!drag.armed) setDrag({ ...drag, armed: true })
    }
  }

  function applyMarquee(box: Bounds, additive: boolean) {
    const parts: string[] = []
    for (const inst of project.parts) {
      if (inst.side !== side || hidden.parts.has(inst.id)) continue
      const def = project.defs[inst.defId]
      if (!def) continue
      if (boundsOverlap(boundsOf(partOutlinePoints(def, inst)), box)) parts.push(inst.id)
    }
    const wires: string[] = []
    for (const wire of project.wires) {
      if (wire.side !== side || hidden.wires.has(wire.id)) continue
      const pts = wirePoints(wire, pinAt)
      for (let i = 0; i < pts.length - 1; i++) {
        if (segmentIntersectsBounds(pts[i], pts[i + 1], box)) {
          wires.push(wire.id)
          break
        }
      }
    }
    const cur = getState().selection
    set({
      selection: additive
        ? {
            parts: [...new Set([...cur.parts, ...parts])],
            wires: [...new Set([...cur.wires, ...wires])],
            boards: cur.boards,
          }
        : { parts, wires, boards: [] },
    })
  }

  function onPointerUp(e: React.PointerEvent) {
    if (mobile) return
    if (e.type === 'pointerleave') {
      setHoverPin(null)
      setCursorWorld(null)
    }
    if (drag.kind === 'marquee') {
      const box = boundsFromCorners(drag.start, drag.current)
      const clicked = box.maxX - box.minX < 0.15 && box.maxY - box.minY < 0.15
      if (clicked) {
        // A click, not a band: select the board under it, or clear.
        if (drag.boardId) selectOne('boards', drag.boardId, drag.additive)
        else if (!drag.additive) set({ selection: EMPTY_SELECTION, hoverNet: null })
      } else {
        applyMarquee(box, drag.additive)
      }
    }
    // In wire mode a real drag finishes the wire; a click only places a bend.
    if (pending && tool === 'wire') {
      const far = Math.hypot(e.clientX - pending.downScreen.x, e.clientY - pending.downScreen.y)
      if (far >= MIN_DRAG_PX) finishWire(toWorld(e))
    }
    if (drag.kind !== 'none') {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // capture may already be gone
      }
    }
    setDrag({ kind: 'none' })
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (pending) {
      finishWire(toWorld(e))
    }
  }

  // ---- drop from the parts panel -----------------------------------------
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const defId = e.dataTransfer.getData('application/x-perf-part') || dragDefId
    setDropAt(null)
    set({ dragDefId: null })
    if (!defId || !project.defs[defId]) return
    const w = snapToHole(toWorld(e))
    commit((p) => addPart(p, defId, w, side))
  }

  const pendingPoints: Vec[] = pending
    ? [anchorPos(pending.from, pinAt) ?? pending.cursor, ...pending.waypoints, pending.cursor]
    : []

  const snapCandidate = cursorWorld ? snapToHole(cursorWorld) : null
  const snapPreview =
    tool === 'wire' && snapCandidate && isHole(project, snapCandidate.x, snapCandidate.y)
      ? snapCandidate
      : null

  // Live drop feedback: the holes the pins of a dragged part will land in.
  const draggedIds = drag.kind === 'part' ? new Set(drag.ids) : null
  const isBlocked = blockedFor(draggedIds ?? new Set())
  const dragTargets: { pos: Vec; blocked: boolean }[] = []
  if (draggedIds) {
    for (const id of draggedIds) {
      const inst = project.parts.find((p) => p.id === id)
      const def = inst && project.defs[inst.defId]
      if (!inst || !def) continue
      for (const pos of partPinPositions(def, inst).values()) {
        dragTargets.push({ pos, blocked: isBlocked(pos) })
      }
    }
  }

  const dropDef = dragDefId ? project.defs[dragDefId] : undefined
  const dropInst: PartInstance | null =
    dropDef && dropAt
      ? { id: '__drop', defId: dropDef.id, x: dropAt.x, y: dropAt.y, rotation: 0, side, ref: '' }
      : null

  const marqueeBox = drag.kind === 'marquee' ? boundsFromCorners(drag.start, drag.current) : null

  // Millimetre ruler: ticks are measured from the canvas's global hole (0,0),
  // the same frame every board's position is already expressed in.
  const pxPerMm = (camera.zoom * PITCH_PX) / MM_PER_HOLE
  const rulerOrigin = worldToScreen(view, { x: 0, y: 0 })
  const cursorScreen = cursorWorld ? worldToScreen(view, cursorWorld) : null

  return (
    <>
    <svg
      ref={svgRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        background: '#F2F0EC',
        touchAction: 'none',
        cursor:
          drag.kind === 'pan'
            ? 'grabbing'
            : spaceHeld
              ? 'grab'
              : tool === 'wire'
                ? 'crosshair'
                : 'default',
      }}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => {
        e.preventDefault()
        if (getState().dragDefId) setDropAt(snapToHole(toWorld(e)))
      }}
      onDragLeave={() => setDropAt(null)}
      onDrop={onDrop}
      onContextMenu={(e) => {
        // Right button now drives panning/finishing a wire, not the native menu.
        e.preventDefault()
        if (pending) finishWire(toWorld(e))
      }}
    >
      <CanvasDefs />
      <g transform={rootTransform(view)}>
        <CanvasGrid
          minX={gridBox.minX}
          minY={gridBox.minY}
          cols={gridBox.maxX - gridBox.minX}
          rows={gridBox.maxY - gridBox.minY}
        />
        {project.boards.map((b) => (
          <BoardSurface key={b.id} board={b} selected={selection.boards.includes(b.id)} />
        ))}

        {/* Far side first, so near-side content paints over it. */}
        {showFarSide &&
          project.wires
            .filter((w) => w.side !== side && !hidden.wires.has(w.id))
            .map((w) => (
              <WireView
                key={w.id}
                wire={w}
                points={wirePoints(w, pinAt)}
                netlist={netlist}
                selected={false}
                ghosted
                highlightNet={hoverNet}
                pxScale={1 / (camera.zoom * PITCH_PX)}
              />
            ))}

        {/* Far-side parts are drawn whether or not ghosting is on: with it
            off they collapse to a silhouette stroke plus a ring on every
            hole they occupy, because a hole taken from the other face still
            has to be visible from this one. */}
        {project.parts
          .filter((p) => p.side !== side && !hidden.parts.has(p.id))
          .map((inst) => {
            const def = project.defs[inst.defId]
            if (!def) return null
            return (
              <PartView
                key={inst.id}
                def={def}
                inst={inst}
                view={view}
                netlist={netlist}
                selected={false}
                far={showFarSide ? 'ghost' : 'outline'}
                showNets={showNets}
                highlightNet={hoverNet}
                assetUrls={assetUrls}
              />
            )
          })}

        {project.parts
          .filter((p) => p.side === side && !hidden.parts.has(p.id))
          .map((inst) => {
            const def = project.defs[inst.defId]
            if (!def) return null
            return (
              <PartView
                key={inst.id}
                def={def}
                inst={inst}
                view={view}
                netlist={netlist}
                selected={selection.parts.includes(inst.id)}
                showNets={showNets}
                highlightNet={hoverNet}
                assetUrls={assetUrls}
                dragging={draggedIds?.has(inst.id)}
                onPointerDown={(e) => {
                  if (mobile) return
                  if (tryPan(e)) {
                    e.stopPropagation()
                    return
                  }
                  if (tool !== 'select' || e.button !== 0) return
                  e.stopPropagation()
                  startPartDrag(inst.id, toWorld(e), e)
                }}
              />
            )
          })}

        {/* Holes a dragged part is about to occupy, over the body so the
            feedback is not hidden underneath it. */}
        {dragTargets.map((t, i) => (
          <PinTarget key={i} at={t.pos} blocked={t.blocked} />
        ))}

        {project.wires
          .filter((w) => w.side === side && !hidden.wires.has(w.id))
          .map((w) => (
            <WireView
              key={w.id}
              wire={w}
              points={wirePoints(w, pinAt)}
              netlist={netlist}
              selected={selection.wires.includes(w.id)}
              ghosted={false}
              highlightNet={hoverNet}
              pxScale={1 / (camera.zoom * PITCH_PX)}
              onSegmentDown={(index, e) => {
                if (mobile) return
                if (tryPan(e)) return
                if (tool !== 'select' || e.button !== 0) return
                const at = toWorld(e)
                if (doubleClicked(`seg:${w.id}:${index}`)) {
                  // Second click on the same segment: put a bend where we are.
                  commit((p) =>
                    updateWire(p, w.id, {
                      waypoints: [
                        ...w.waypoints.slice(0, index),
                        snapPoint(at),
                        ...w.waypoints.slice(index),
                      ],
                    }),
                  )
                  return
                }
                capture(e)
                selectOne('wires', w.id, e.shiftKey)
                set({ hoverNet: netlist.byWire.get(w.id) ?? null })
                setDrag({
                  kind: 'segment',
                  wireId: w.id,
                  index,
                  base: w,
                  start: at,
                  startScreen: { x: e.clientX, y: e.clientY },
                  armed: false,
                })
              }}
              onWaypointDown={(index, e) => {
                if (mobile) return
                if (tryPan(e)) return
                if (doubleClicked(`wp:${w.id}:${index}`)) {
                  commit((p) =>
                    updateWire(p, w.id, { waypoints: w.waypoints.filter((_, i) => i !== index) }),
                  )
                  setDrag({ kind: 'none' })
                  return
                }
                capture(e)
                setDrag({ kind: 'waypoint', wireId: w.id, index, moved: false })
              }}
              onEndpointDown={(end, e) => {
                if (mobile) return
                if (tryPan(e)) return
                capture(e)
                setDrag({ kind: 'endpoint', wireId: w.id, end, moved: false })
              }}
            />
          ))}

        {/* Part being dragged in from the palette. */}
        {dropDef && dropInst && (
          <PartGhost def={dropDef} inst={dropInst} blocked={blockedFor(new Set())} />
        )}

        {/* Wire being drawn. */}
        {pending && pendingPoints.length >= 2 && (
          <g pointerEvents="none">
            <polyline
              points={pendingPoints.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={s.wireColor}
              strokeWidth={0.3}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.8}
            />
            {pending.waypoints.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={0.16} fill={s.wireColor} />
            ))}
          </g>
        )}

        {/* Rubber band. */}
        {marqueeBox && (
          <rect
            x={marqueeBox.minX}
            y={marqueeBox.minY}
            width={marqueeBox.maxX - marqueeBox.minX}
            height={marqueeBox.maxY - marqueeBox.minY}
            fill="#1E88E5"
            fillOpacity={0.08}
            stroke="#1E88E5"
            strokeWidth={1}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        )}

        {/* Snap indicator. */}
        {snapPreview && (
          <circle
            cx={snapPreview.x}
            cy={snapPreview.y}
            r={0.42}
            fill="none"
            stroke="#1E88E5"
            strokeWidth={0.08}
            pointerEvents="none"
          />
        )}
      </g>
      {!mobile && (
        <Ruler
          size={size}
          thickness={RULER_PX}
          pxPerMm={pxPerMm}
          originX={rulerOrigin.x}
          originY={rulerOrigin.y}
          cursorScreen={cursorScreen}
        />
      )}
    </svg>
    {hoverPin && (
      <div
        className="pin-tooltip"
        style={{ left: hoverPin.screen.x, top: hoverPin.screen.y }}
      >
        {hoverPin.label}
      </div>
    )}
    </>
  )
}

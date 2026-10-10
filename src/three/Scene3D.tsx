/**
 * The 3D view.
 *
 * A CAD-style orbit camera over the whole build, with both faces of the board
 * visible at once — which is the thing the 2D view structurally cannot do,
 * since there "the other side" is a render-time mirror of one plane.
 *
 * It is VIEW + SELECT, deliberately: you can orbit, pan, zoom and click an
 * object to select it (the Properties panel then edits it as always), but no
 * geometry is dragged here. Every tool in `Canvas.tsx` resolves a pointer to a
 * hole by inverting one 2D transform; in a perspective scene the same gesture
 * has to pick a plane first, and with the camera edge-on to the board there is
 * no honest answer to which side you meant.
 *
 * React owns the container and the hidden texture-bake SVGs; everything
 * inside the canvas is imperative three.js, rebuilt wholesale by `buildWorld`
 * whenever the document changes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { outlineBounds, outlineIsEmpty } from '../model/shapes'
import { EMPTY_SELECTION, getState, type Selection, set, useEditor } from '../model/store'
import type { PartDef } from '../model/types'
import { hiddenIds } from '../model/visibility'
import { PartGraphics } from '../ui/PartGraphics'
import { buildWorld, type Pick, type World, worldSphere } from './build'

/** Texture pixels per hole when baking a part's artwork. */
const BAKE_PX = 72
const BAKE_MAX = 1024

/** A click that moved less than this many px is a pick, not an orbit. */
const PICK_SLOP = 5

const BACKGROUND = 0xeceae5

/**
 * The camera survives leaving and re-entering 3D within a session, so the
 * toggle is a glance rather than a loss of your viewpoint. Cleared whenever a
 * different document is loaded — see the `loadSeq` effect.
 */
let saved: { position: THREE.Vector3; target: THREE.Vector3 } | null = null

interface Props {
  /** Assets as `data:` URIs — a blob URL will not load inside a baked SVG. */
  assetDataUrls: Record<string, string>
}

/** Defs that actually have something to bake onto their top face. */
function texturedDefs(defs: Record<string, PartDef>, used: Set<string>): PartDef[] {
  return Object.values(defs).filter(
    (d) =>
      used.has(d.id) &&
      !outlineIsEmpty(d.outline) &&
      (!!d.texture || (d.artwork?.shapes.length ?? 0) > 0),
  )
}

export function Scene3D({ assetDataUrls }: Props) {
  const s = useEditor()
  const host = useRef<HTMLDivElement>(null)
  const bakeHost = useRef<HTMLDivElement>(null)

  const three = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
  } | null>(null)
  const world = useRef<World | null>(null)
  const textures = useRef(new Map<string, THREE.Texture>())
  /** Bumped when a bake finishes, to rebuild the world with the new texture. */
  const [bakeSeq, setBakeSeq] = useState(0)

  const hidden = useMemo(() => hiddenIds(s.project), [s.project])
  const usedDefIds = useMemo(
    () => new Set(s.project.parts.map((p) => p.defId)),
    [s.project.parts],
  )
  const toBake = useMemo(
    () => texturedDefs(s.project.defs, usedDefIds),
    [s.project.defs, usedDefIds],
  )

  // ---- renderer ----------------------------------------------------------

  useEffect(() => {
    const el = host.current
    if (!el) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    // Neutral rather than ACES: ACES desaturates, and a PCB green that comes
    // out grey-olive next to the 2D canvas reads as a bug.
    renderer.toneMapping = THREE.NeutralToneMapping
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(BACKGROUND)

    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.85

    const key = new THREE.DirectionalLight(0xffffff, 1.5)
    key.position.set(6, 12, 8)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.7)
    // Underneath, so the solder side is lit when you orbit below the board.
    fill.position.set(-6, -10, -5)
    scene.add(fill)

    // near/far are tightened to the build in `applyFit`. The defaults only
    // have to survive the first frame: a 0.05-to-20000 range is a ratio of
    // 400,000, and at that spread the depth buffer cannot keep a board's
    // copper and its substrate apart.
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.12
    // No polar clamp on purpose: going under the board is the whole feature.
    controls.minDistance = 0.5
    // Re-set from the content in `applyFit`; this is only a sane first value.
    controls.maxDistance = 2000
    controls.screenSpacePanning = true

    three.current = { renderer, scene, camera, controls }
    // Same purpose as `window.__perf`: the scene has to be inspectable from
    // headless Chrome, because nothing inside a WebGL canvas is reachable
    // from the DOM. Dev builds only.
    if (import.meta.env.DEV) {
      ;(window as unknown as { __perf3d?: unknown }).__perf3d = {
        scene,
        camera,
        controls,
        world: () => world.current,
      }
    }

    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      controls.update()
      renderer.render(scene, camera)
    }
    tick()

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      saved = { position: camera.position.clone(), target: controls.target.clone() }
      controls.dispose()
      pmrem.dispose()
      scene.environment?.dispose()
      world.current?.dispose()
      world.current = null
      renderer.dispose()
      el.removeChild(renderer.domElement)
      three.current = null
    }
  }, [])

  // ---- bake part artwork into textures -----------------------------------

  useEffect(() => {
    const el = bakeHost.current
    if (!el) return
    let cancelled = false
    const serializer = new XMLSerializer()

    void (async () => {
      let changed = false
      for (const def of toBake) {
        const svg = el.querySelector<SVGSVGElement>(`svg[data-def="${CSS.escape(def.id)}"]`)
        if (!svg) continue
        const markup = serializer.serializeToString(svg)
        const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
        try {
          const img = await loadImage(url)
          if (cancelled) return
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, svg.width.baseVal.value)
          canvas.height = Math.max(1, svg.height.baseVal.value)
          canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
          const tex = new THREE.CanvasTexture(canvas)
          tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = 8
          textures.current.get(def.id)?.dispose()
          textures.current.set(def.id, tex)
          changed = true
        } catch {
          // A part whose artwork will not rasterise is not a reason to lose
          // the whole view — it just falls back to a plain coloured body.
          textures.current.delete(def.id)
        }
      }
      // Drop textures for defs that no longer have artwork, or are no longer
      // placed, so an edit that removes a label does not leave it baked on.
      const live = new Set(toBake.map((d) => d.id))
      for (const id of [...textures.current.keys()]) {
        if (!live.has(id)) {
          textures.current.get(id)?.dispose()
          textures.current.delete(id)
          changed = true
        }
      }
      if (changed && !cancelled) setBakeSeq((n) => n + 1)
    })()

    return () => {
      cancelled = true
    }
  }, [toBake, assetDataUrls])

  // ---- (re)build the world ------------------------------------------------

  useEffect(() => {
    const t = three.current
    if (!t) return
    world.current?.dispose()
    if (world.current) t.scene.remove(world.current.root)
    const w = buildWorld(s.project, hidden, textures.current)
    t.scene.add(w.root)
    // Read the selection live rather than from this effect's closure: a
    // rebuild is driven by the document, and depending on the selection here
    // would re-extrude every part each time you clicked something.
    const sel = getState().selection
    w.highlight(sel.parts, sel.wires, sel.boards)
    world.current = w
  }, [s.project, hidden, bakeSeq])

  // Selection is a view change: light the materials, never rebuild geometry.
  useEffect(() => {
    world.current?.highlight(s.selection.parts, s.selection.wires, s.selection.boards)
  }, [s.selection.parts, s.selection.wires, s.selection.boards])

  // ---- framing ------------------------------------------------------------

  const frame = useMemo(() => worldSphere(s.project), [s.project])
  const frameRef = useRef(frame)
  useEffect(() => {
    frameRef.current = frame
  }, [frame])

  /** Put the camera on an iso three-quarter view of the whole build. */
  const applyFit = useRef((animate: boolean) => {
    const t = three.current
    if (!t) return
    const { centre, radius } = frameRef.current
    // Fit against whichever field of view is TIGHTER. A build is wide and
    // flat, so on a phone in portrait the horizontal one binds and fitting
    // the vertical fov alone would run the board off both edges.
    const vFov = (t.camera.fov * Math.PI) / 180
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * t.camera.aspect)
    const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.05
    const dir = new THREE.Vector3(0.55, 0.72, 0.85).normalize()
    const pos = centre.clone().addScaledVector(dir, dist)

    // Clamp the depth range to the build. Depth precision is spent on the
    // near/far RATIO, so a far plane kilometres past the work is what makes
    // a board's copper flicker against its substrate while you orbit.
    t.controls.maxDistance = dist * 8
    t.camera.near = Math.max(0.1, dist / 2000)
    t.camera.far = dist * 12
    t.camera.updateProjectionMatrix()
    if (animate) tweenCamera(t.camera, t.controls, pos, centre)
    else {
      t.camera.position.copy(pos)
      t.controls.target.copy(centre)
      t.controls.update()
    }
  })

  // A new document means a new build: drop the remembered viewpoint and
  // re-frame, exactly as the 2D canvas re-fits on `loadSeq`.
  useEffect(() => {
    saved = null
    applyFit.current(false)
  }, [s.loadSeq])

  // Entering 3D: restore the viewpoint if there is one, otherwise frame it.
  useEffect(() => {
    const t = three.current
    if (!t) return
    if (saved) {
      t.camera.position.copy(saved.position)
      t.controls.target.copy(saved.target)
      t.controls.update()
    } else {
      applyFit.current(false)
    }
  }, [])

  useEffect(() => {
    if (s.fitSeq > 0) applyFit.current(true)
  }, [s.fitSeq])

  /**
   * Top/Bottom still mean something here, just not a mirror: they swing the
   * camera under the board and back. Reflecting the position through the
   * board plane keeps your azimuth and your distance, so flipping feels like
   * turning the board over in your hand rather than being teleported.
   */
  const firstSide = useRef(true)
  useEffect(() => {
    const t = three.current
    if (!t) return
    if (firstSide.current) {
      firstSide.current = false
      return
    }
    const above = t.camera.position.y >= t.controls.target.y
    const wantAbove = s.side === 'top'
    if (above === wantAbove) return
    const pos = t.camera.position.clone()
    pos.y = 2 * t.controls.target.y - pos.y
    tweenCamera(t.camera, t.controls, pos, t.controls.target.clone())
  }, [s.side])

  // ---- picking ------------------------------------------------------------

  useEffect(() => {
    const t = three.current
    const el = host.current
    if (!t || !el) return
    let downAt: { x: number; y: number; id: number } | null = null

    const onDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY, id: e.pointerId }
    }
    const onUp = (e: PointerEvent) => {
      const start = downAt
      downAt = null
      if (!start || start.id !== e.pointerId) return
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > PICK_SLOP) return
      const w = world.current
      if (!w) return

      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      const ray = new THREE.Raycaster()
      ray.setFromCamera(ndc, t.camera)
      const hits = ray.intersectObjects(w.pickables, false)
      const pick = hits.length > 0 ? (hits[0].object.userData.pick as Pick | undefined) : undefined

      if (!pick) {
        set({ selection: EMPTY_SELECTION })
        return
      }
      // Shift toggles, matching the 2D canvas. The live selection comes from
      // the store rather than this effect's closure, which was captured once.
      const live = getState().selection
      const sel: Selection = e.shiftKey
        ? { parts: [...live.parts], wires: [...live.wires], boards: [...live.boards] }
        : { parts: [], wires: [], boards: [] }
      const bucket = pick.kind === 'part' ? sel.parts : pick.kind === 'wire' ? sel.wires : sel.boards
      const at = bucket.indexOf(pick.id)
      if (at >= 0) bucket.splice(at, 1)
      else bucket.push(pick.id)
      set({ selection: sel })
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
    }
  }, [])

  return (
    <div className="scene3d" ref={host}>
      {/* The texture source. These are the SAME components the 2D canvas
          draws with — baking a hand-written copy of the artwork renderer
          would drift from it the first time either changed. */}
      <div className="bake-host" ref={bakeHost} aria-hidden>
        {toBake.map((def) => {
          const b = outlineBounds(def.outline)
          const w = Math.max(1e-6, b.maxX - b.minX)
          const h = Math.max(1e-6, b.maxY - b.minY)
          const scale = Math.min(BAKE_PX, BAKE_MAX / Math.max(w, h))
          return (
            <svg
              key={def.id}
              data-def={def.id}
              xmlns="http://www.w3.org/2000/svg"
              width={Math.max(1, Math.round(w * scale))}
              height={Math.max(1, Math.round(h * scale))}
              viewBox={`${b.minX} ${b.minY} ${w} ${h}`}
            >
              <PartGraphics def={def} idPrefix={`bake-${def.id}`} assetUrls={assetDataUrls} />
            </svg>
          )
        })}
      </div>
    </div>
  )
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('bake failed'))
    img.src = url
  })
}

/** Short ease into a new viewpoint. Teleporting the camera loses the viewer. */
function tweenCamera(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  position: THREE.Vector3,
  target: THREE.Vector3,
  ms = 420,
) {
  const from = camera.position.clone()
  const fromTarget = controls.target.clone()
  const t0 = performance.now()
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / ms)
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    camera.position.lerpVectors(from, position, e)
    controls.target.lerpVectors(fromTarget, target, e)
    controls.update()
    if (k < 1) requestAnimationFrame(step)
  }
  step()
}

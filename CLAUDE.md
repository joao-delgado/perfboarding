# perf-wiring

A browser-based tool for planning **perfboard wiring** — essentially Fritzing's
breadboard view, rebuilt for the web and narrowed to one job: laying out parts
on a perfboard and planning the wires between them, on both sides of the board.

Not a schematic capture tool, not a PCB autorouter. The user is someone holding
a piece of perfboard and a soldering iron who wants to plan before they solder.

---

## ⚠️ Maintenance rule — read this first

**The "Implementation plan" section below is the single source of truth for
project state. Keep it current.**

Every session that changes code must, before finishing:

1. Tick the `[x]` boxes for anything completed.
2. Move the `👉 YOU ARE HERE` marker to the next unstarted item.
3. Add any new decision to "Locked decisions" with a one-line rationale.
4. Note any newly discovered constraint under "Gotchas".

If you finish a phase, say so explicitly in the plan rather than leaving the
reader to infer it from the code. A stale plan is worse than no plan — a future
agent will trust it and redo work or skip work.

Do **not** re-run the Fritzing research. It is summarised below in the detail
that actually affects implementation decisions; the source citations are there
if you need to go deeper on one specific point.

---

## Git & publishing

- **Remote**: `git@github-joao:joao-delgado/perfboarding.git` — the
  `github-joao` host alias in `~/.ssh/config` forces `~/.ssh/id_ed25519_joao-delgado`
  for both auth and commit signing, so this always goes through the personal
  account, never a work account, regardless of which repo this machine last
  touched.
- **Identity and signing are set locally in this repo's `.git/config`**, not
  globally: `user.name`/`user.email` (`joao-delgado` /
  `joao.p.delgado1999@gmail.com`), `gpg.format=ssh`,
  `user.signingkey=~/.ssh/id_ed25519_joao-delgado.pub`, `commit.gpgsign=true`,
  `tag.gpgsign=true`. Local config wins over global, so even if the global
  git identity or signing key ever changes for other (work) repos, this repo's
  commits keep signing as the personal account. Do not move this to global
  config.
- **Every commit and tag here must be signed by the personal
  `id_ed25519_joao-delgado` key. Never a work account's key, and never left
  unsigned.** If a commit here ever shows as unsigned or signed by a different
  key, that means something (a global config change, `--no-gpg-sign`, a
  different `.git/config`) overrode the local settings above — fix the config,
  don't just re-commit.
- **Never add Claude/Anthropic co-authorship or attribution to commits or PRs
  in this repo** — no `Co-Authored-By: Claude`, no "Generated with Claude
  Code" footer, nothing. The user's instruction here overrides any default
  attribution behavior.
- **GitHub Pages serves `dist/` only, via CI — `dist/` itself is never
  committed** (it's gitignored, same as before). `.github/workflows/deploy.yml`
  builds on every push to `main` (`npm ci && npm run build`) and publishes
  `dist/` with `actions/upload-pages-artifact` + `actions/deploy-pages`. This
  needs the repo's Settings → Pages → "Build and deployment" source set to
  **GitHub Actions** once, by hand — that one setting can't be flipped from
  here without a GitHub API token.
- `vite.config.ts` sets `base: '/perfboarding/'` because this is a GitHub
  *project* page (`joao-delgado.github.io/perfboarding/`), not a user/org page
  or a custom domain. If that ever changes (custom domain, renamed repo, org
  page), `base` has to change with it or every asset URL 404s.

---

## Current status

**Phases 1, 2, 3, 4 and 6 are done. The app runs.**

- Toolchain: Vite 8 + React 19 + TypeScript 6, oxlint. `npm run build` is green.
- Model layer complete: `types`, `geometry`, `nets`, `project`, `store`.
- Canvas renders the perfboard, parts and wires; pan/zoom, top/bottom flip,
  part drag with hole snapping, rotate, delete, undo/redo all work.
- **Edge pads**: a board can carry oblong two-hole bus pads along any of its
  four edges, the ones down the sides of a real protoboard. Model in
  `model/pads.ts`, four L/T/B/R toggles in the Boards panel.
- Wiring is complete as a tool: draw by clicking or dragging, add and remove
  bends, drag a segment, re-bind an endpoint, per-wire colour and banding.
- Selection: single click, shift-click to toggle, marquee on the board.
- `Inspector.tsx` gives the selected object its properties — including the
  side a placed part is mounted on, which used to be fixed at drop time.
- **Design-rule checking has been removed.** No `drc.ts`, no Issues panel.
  This is a drawing tool, and the user asked for the whole feature gone.
- Save/open `.perfproj` (zip) and IndexedDB session restore work; Save
  overwrites the current file, Save as… writes a new one. Session restore
  carries the **texture bytes** too, in their own IndexedDB object store.
- Part editor modal works: pen tool on the half-hole grid, pin placement and
  naming, image upload with SVG sanitising, clip-to-outline texturing.

Verified by driving headless Chrome over CDP — 22 checks covering wire drawing,
the minimum-drag guard, bend add/remove, segment drag, endpoint re-binding, the
drop preview, marquee, shift-click, the side flip and undo, with a clean
console. `src/main.tsx` exposes the store as `window.__perf` **in dev builds
only**, which is what makes the app inspectable from CDP; the driver itself
lives in the session tmp dir (`scratchpad/drive.mjs`) — rewrite it if you need it.

## Locked decisions

These were answered directly by the user. Do not reopen them without being asked.

| Area | Decision | Why |
|---|---|---|
| Stack | Vite + React + TypeScript | UI panels and the part-editor modal get easier as it grows; canvas stays imperative-ish |
| Board type | **Plain perfboard only** — every lattice hole an isolated pad | No stripboard, no power rails, no breadboard strips. Keeps connectivity purely explicit. Edge pads (below) are the single, deliberate exception |
| Edge pads | Optional **pad strips** along any of a board's four edges. **One fixed shape, no options**: a pad covers 2 grid cells reaching OUTWARD from the edge, one pad per lattice row/column, butted against the lattice. Its two cells are ONE electrical node | These are the oblong bus pads on real protoboards, and the user supplied a reference image of exactly the shape wanted — size/orientation options were offered and explicitly declined. The strip lives OUTSIDE the hole lattice so switching one on **grows the board** instead of eating a column you already built on, but still on the integer grid, so a pad cell is just a hole coordinate and wires, pins and snapping need no new machinery. Drawn as solid copper with no drill, unlike the ringed lattice holes |
| Multiple boards | A project holds **many boards**, each with its own size and colours | Everything stays in **canvas hole units**: a board carries a position `(x,y)` and parts/wires never need board-relative coordinates. `boardAt(project,x,y)` decides whether a canvas hole exists |
| Board colours | Default PCB green `#15703F` with gold pad rings `#D9B23C`, editable per board | |
| Rotation | **90° steps only** (0/90/180/270) | With integer hole coordinates this makes rotation exact integer math, so pins can never drift off-grid. The user explicitly chose this over 45° |
| Sides | Wires **belong to a side** (top/bottom). Parts too. Viewing the other side ghosts the far-side content | Matches how you actually build: components on top, solder-side links underneath |
| Wire endpoints | Hole, pin, **or free point** | Free points are for leads going off-board (battery, external switch). They never count as electrically connected |
| Wire angles | **Free angles with ortho assist** — soft-snap to 0/45/90 within ~7°, Shift hard-locks to 8 directions | Diagonal runs are normal on real perfboard and save wire |
| File format | `.perfproj` = **zip container** (fflate): `project.json` + `assets/` | Textures keep their original bytes; inspectable with `unzip` |
| Parts library | **Project-embedded only** — parts live in the `.perfproj` | Fully portable. Built-ins ship with the app |
| Electrical | Net computation + highlight, named nets. **No DRC** | This is a drawing and wiring planner, not a verification tool — the user removed design-rule checking outright. Netlist/BOM export was never requested either |
| Part outline | Pen tool snaps to **half-hole steps** | A real body edge falls between pin rows, not on them |
| Rubber band vs board drag | Dragging the board surface **rubber-bands**; a board only moves once it is selected (click it first) | The board covers the canvas, so marquee has to win the ambiguous gesture — selecting parts on a board is the common act, moving the board is the rare one. Alt or middle-drag still pans |
| Flipping a part's side | Keeps the **footprint**, not the pin identities: the origin shifts so the part occupies the same holes | Mounting from below mirrors the part, so identical pin positions are impossible unless it is symmetric. Same holes, pins swapped ends, is what physically happens when you re-insert it from the other face |
| Double-click detection | Recognised **by hand** in `Canvas.tsx` (`doubleClicked`), not with `onDoubleClick` | `setPointerCapture` retargets the browser's compatibility mouse events, so the native dblclick lands on the `<svg>` instead of the bend you aimed at. See Gotchas |
| Seed parts | **Passives & basics**: resistor, capacitor (radial + ceramic), LED, diode, tactile switch, slide switch, 2-pin screw terminal, pin header (configurable length) | The user declined the ESP32/TP4056 module set and the parametric DIP/SIP set |

---

## Research findings that shaped the design

Condensed from a deep read of `github.com/fritzing/fritzing-app` (branch
`develop`) plus its docs and issue tracker. Kept only where it changes what we build.

### How Fritzing works, and the three things that go wrong

**There is no net model.** A Fritzing wire is a *single straight segment* with
exactly two connectors. A polyline with three bends is **four separate wire
objects** chained end to end. Nets are recomputed on demand by graph traversal
(`ConnectorItem::collectEqualPotential`, `src/connectors/connectoritem.cpp:1356`)
over pairwise connections plus part-internal buses. Almost every long-standing
usability complaint traces back to this one decision.

**Snapping has no magnetism.** Two unrelated mechanisms: round-to-nearest-grid
on position (`SketchWidget::alignLoc` → `GraphicsUtils::getNearestOrdinate`),
and a bare point-in-rect hit test for connection (`ConnectorItem::findConnectorUnder`).
If a pin's terminal point isn't literally inside a hole's rect, there is no
connection — hence the perennial "it looks connected but isn't" (issues #4212,
#641, #4243). Worse, `findAlignmentAnchor` returns on the **first** connector it
iterates, so a multi-pin part's snap offset is decided by pin #1 alone; the
other pins land correctly only because the SVG happened to be authored on a
0.1in pitch.

**Rotation never re-snaps.** `rotateX` rotates about the union bounding-box
centre of the selection (never a connector) and contains no `alignOneToGrid`
call — open issue #3077, labelled Usability/Breadboard.

### What we fix by construction

| Fritzing problem | Our design |
|---|---|
| Cold connections (#4212, #641, #4243) | Wires anchor to holes. An endpoint is either *in* a hole or visibly floating; there is no ambiguous middle state |
| Cannot branch/tap a wire — open since 2011 (#1386); hard-coded in `Wire::connectionIsAllowed` | A hole is a shared node, so N wires in one hole simply *are* one net. Branching needs no special machinery |
| Rotation knocks pins off grid (#3077) | 90° only + integer hole coords ⇒ rotation is `(c,r) → (−r,c)`. Exact, always legal |
| Modifier soup — five gestures on overlapping pixels, and a preference that *inverts* Ctrl's meaning (#4002, forum) | Explicit tools: Select / Wire / (later) Cut. Modifiers only *refine* the active tool |
| Bendpoints are separate objects, so box-select shreds wiring (#3609, #4272, #817) | One wire owns a `waypoints[]` array |

### What is worth stealing

- **Mouse-down on a connector highlights the whole net in yellow**
  (`showEqualPotential`). Cheap, and it is instant "is this really one node?"
  verification. High value per line of code.
- **Blue 40% tint of the entire drop-target part** when hovering one of its
  connectors (`ItemBase::ConnectorHoverColor` `#0000FF` @ 0.40) — an unmissable
  drop cue.
- **Minimum drag length before a wire is created** (`WireMinLength = 6` scene px)
  so a twitch doesn't spawn a stub wire.
- **Cursor-as-affordance** (`Wire::updateCursor`): the pointer tells you whether
  the next drag makes a bend, moves a segment, or starts a wire.
- **Colour-by-length** mapping to real jumper-kit colours (100mil→silver,
  200→red, 300→orange, 400→yellow, 500→green, 600→blue, 700→purple…). Nice-to-have.
- **Fritzing's canonical wire colours** (from its published graphic standards):
  blue `#418DD9`, red `#CC1414`, black `#404040`, yellow `#FFE24D`,
  green `#47CC79`, grey `#999999`, white `#FFFFFF`, orange `#FF7033`. The full
  menu adds ochre, cyan, brown, purple, pink (13 total). Default is blue, and
  the view remembers the last colour picked.
- **Banded wires**: a `banded` boolean overdraws white for the two-tone jumper
  look. Cheap visual win, already in our `Wire` type.

### Perfboard specifics (confirms our model)

Fritzing generates the perfboard part at runtime (`src/items/perfboard.cpp`) —
there is no `.fzp` on disk. Every hole is a `type="female"` connector and
**`<buses>` is empty**: all pads isolated, exactly our model. Size is the string
`"<cols>.<rows>"`, range 3–199 each, and changing size is implemented as a *part
swap*, not a resize. Pad geometry: 0.035in hole, 0.075in pad OD, 0.1in pitch.
A performance warning fires above 2000 holes.

**Breadboard view has no bottom side at all.** `ViewLayer::layersForViewFromBelow()`
returns the same layer list as `layersForView()` for `BreadboardView`; only PCB
view has a real view-from-below. So the both-sides feature has **no prior art to
copy** — we are designing it, and the conventions below are ours.

### Units — the mess we are deliberately not inheriting

Fritzing juggles three coordinate systems simultaneously: SVG authoring at
1000 units/inch (0.1in pitch = 100 units), a scene/document unit of 1/90 inch
for every `x`/`y` in the `.fz` file, and legacy Illustrator SVGs at 72dpi
detected by grepping the file for the literal string `"Generator: Adobe Illustrator"`.
We store integer hole coordinates and derive pixels at render time. That's it.

### Tech research conclusions

- **SVG DOM is the right renderer at our scale** (~500–2000 nodes), *provided
  the perfboard holes are never DOM elements*. SVG degrades around ~10k elements
  (measured: Horak/Kister/Dachselt, TU Dresden 2018). Comparable tools: wokwi
  (closest analog) is SVG; tldraw is HTML DOM per shape; Excalidraw is canvas;
  EasyEDA Pro and Flux went WebGL because they are PCB-scale (10k+ pads).
- **The hole grid must be one `<rect>` filled with an SVG `<pattern>`** — 1 DOM
  node instead of 2000. If tiny pattern tiles rasterise slowly at high zoom, use
  a tile containing a 4×4 block of holes. A `<canvas>` layer underneath is the
  fallback.
- **No spatial index.** A perfboard is a uniform lattice with known origin and
  pitch, so snapping is `Math.round((x - originX) / pitch)`. A quadtree or rbush
  here is strictly slower and strictly more code. Revisit only for *viewport
  culling* above ~5000 objects, and then use `rbush`.
- **Camera**: keep our own `{x, y, zoom}` and apply it as a single `transform`
  on one root `<g>`. Do **not** animate `viewBox` (forces full re-render).
- **Wire hit-testing**: render each wire twice — the visible stroke plus an
  invisible `stroke="transparent" stroke-width="12" vector-effect="non-scaling-stroke"`
  copy that catches pointer events. Constant grab target at every zoom.
- **`showSaveFilePicker` will never exist in Safari or Firefox.** Mozilla's
  standards position on the local-disk pickers is "harmful"; Apple shipped OPFS
  instead. Global support ~31%, Chromium-desktop only. So save-in-place is a
  progressive enhancement and the universal path is a blob download.
  Session restore therefore comes from **IndexedDB autosave, not from the file**.
- Use a **private MIME type** (`application/x-perfproj`) in `showSaveFilePicker`
  `types`, or Chrome offers every extension registered for the standard type and
  the user ends up with `project.perfproj.zip`. Also pass `suggestedName` and
  `id` (Chrome remembers the last directory per `id`).
- Chromium can stash the `FileSystemFileHandle` in IndexedDB (they are
  structured-cloneable) and re-grant on reload — but `requestPermission()` must
  be called **inside a user gesture**, so the UI is a "Reopen last project"
  button, not an automatic restore.
- `fflate` (~10KB) over JSZip (~95KB). Base64-in-JSON costs +33% minimum and
  forces every image through `JSON.parse`.
- **SVG uploads are an XSS vector**, not an inert image. Sanitize with DOMPurify
  `USE_PROFILES: { svg: true, svgFilters: true }`, additionally strip
  `<foreignObject>`/`<script>`/`<style>` and any `href` not starting with `#`,
  and namespace internal IDs to avoid collisions when several uploads are
  inlined into one document.

---

## Architecture

### Coordinate model — the one thing to internalise

**Everything on the board is in integer hole units, in a canonical TOP VIEW frame.**

- A hole at column 3, row 5 is literally `{x: 3, y: 5}`.
- Pixels are derived only at render time: `px = hole * PITCH_PX * zoom`.
- **Looking at the board from below is a render-time mirror** (`col → cols-1-col`
  applied on the root `<g>`), *not* a second coordinate space. Text must be
  counter-mirrored with a local `scale(-1,1)`.
- A part mounted on the **bottom** is mirrored in its own local X *before*
  rotation (`partToBoard` in `src/model/geometry.ts`), because you are looking
  at its underside. Its pins still pass through the same holes — which is what
  makes both-sides assembly work at all.

### Data model (`src/model/types.ts`)

`Project` = `{ version, name, board: {cols, rows}, defs, parts, wires, assets }`.

- `PartDef` — a component *definition*: outline (half-hole-step polygon), pins
  (integer hole coords, part-local), optional texture, colours. Embedded in the project.
- `PartInstance` — a placement: `defId`, board `x`/`y`, `rotation`, `side`, `ref`.
- `Wire` — `side`, `color`, `banded`, `from`/`to` anchors, `waypoints[]`, optional `net` name.
- `Anchor` — `{kind:'hole'|'pin'|'free'}`. A pin anchor is a *binding*
  (`partId`+`pinId`), so wires follow parts when they move.
- `padEdges?: BoardEdge[]` on a `Board` — which edges carry a pad strip. The
  pad shape is fixed, so the edge is genuinely all there is to store; every pad
  is *derived* (`model/pads.ts`), which is why resizing a board re-lays its
  strips for free.

Net names are stored on wires; a net's name is whichever of its wires carries
one. This keeps naming stable under editing without needing a stable net identity.

### Connectivity (`src/model/nets.ts`)

Union-find over three node kinds: `h:x,y` (hole), `p:partId:pinId` (pin),
`f:wireId:end` (free). A pin unions with its hole when it lands on integer
coordinates. Each wire unions its two endpoint anchors. An **edge pad** unions
the hole nodes of its two cells — the only place two holes are not isolated —
and it does so *after* parts and wires, bonding only cells something already
references, so hundreds of untouched pads never materialise as nets. `netIsConnected()`
extends Fritzing's rule: a net counts as connected when it reaches **≥ 2 distinct
parts** (so a jumper between two holes of the same part shows as unconnected),
**or when ≥ 2 wires meet in it** — a wire spliced onto another wire at a shared
hole with no part there is a real physical join, not a dangling stub, even
before the run reaches a second component.

### File format

`.perfproj` is a zip (fflate):

```
project.json      # the whole document, hole-unit coordinates
assets/<sha256>   # texture images, content-addressed so duplicates dedupe
meta.json         # { formatVersion, appVersion } — version from day one
thumbnail.png     # optional
```

### Module layout

```
src/
  model/
    types.ts       ✅ document model, no rendering concerns
    geometry.ts    ✅ rotation, part↔board transforms, snapping, ortho assist, hit-test math
    nets.ts        ✅ union-find connectivity
    pads.ts        ✅ edge pad strips: layout, cell lookup, board extent
    project.ts     ✅ create/mutate helpers
    store.ts       ✅ editor state, undo/redo, useSyncExternalStore
  parts/
    builtin.ts     ✅ the seed part definitions
  ui/
    App.tsx        ✅ layout, save/open/new, session restore
    Canvas.tsx     ✅ SVG canvas, camera, tools, drag, wire drawing
    view.ts        ✅ screen<->board transform, mirror, zoom-to-cursor, fit
    Board.tsx      ✅ board surface + one-node hole pattern
    PartView.tsx   ✅ outline, pins, texture clip, ref label
    WireView.tsx   ✅ polyline, banded overdraw, hit-stroke, handles
    Toolbar.tsx    ✅ tools, side toggle, colours, board size, undo/redo
    PartsPanel.tsx ✅ right-hand palette with thumbnails, drag to canvas
    Inspector.tsx  ✅ selected-object properties, including part side and net name
    PartEditor.tsx ✅ full-screen modal: pen tool, pins, texture
  io/
    assets.ts      ✅ content-addressed in-memory asset store
    perfproj.ts    ✅ zip read/write
    autosave.ts    ✅ IndexedDB session restore
    sanitize.ts    ✅ SVG upload sanitisation (DOMPurify + href/on* stripping)
```

Keep `model/` completely free of rendering concerns so an SVG→canvas swap later
stays contained.

---

## Implementation plan

Legend: `[x]` done · `[ ]` not started · `[~]` partial

### Phase 1 — Model layer
- [x] `types.ts` — Project, PartDef, PartInstance, Wire, Anchor, Side, Rotation
- [x] `geometry.ts` — `rotatePoint`, `partToBoard`/`boardToPart`, `snapToHole`,
      `snapToStep`, `constrain8`, `orthoAssist`, `pointInPolygon`, `distToSegment`
- [x] `nets.ts` — union-find, `computeNets`, `netIsConnected`
- [x] `project.ts` — `createProject`, immutable mutators
- [x] `store.ts` — `useSyncExternalStore` store with undo/redo (`commit` takes a
      `coalesce` flag so a 200-frame drag is one undo step)
- ~~`drc.ts` — design-rule checks~~ — **deleted.** See Locked decisions

### Phase 2 — Canvas and board  ✅ COMPLETE
- [x] `Canvas.tsx` with own camera `{x, y, zoom}` → single `transform` on root `<g>`
- [x] Pan/zoom: Pointer Events + `setPointerCapture`; non-passive `wheel` with
      `preventDefault`; `ctrlKey` on wheel = trackpad pinch; zoom-to-cursor;
      clamp 0.1×–16×
- [x] Hold **Space** for a temporary hand tool (Figma-style), alongside
      middle-drag and Alt-drag (`tryPan` in `Canvas.tsx`)
- [x] Perfboard render: board rect + **one `<rect>` with `fill="url(#holes)"`**
      pattern. Never 2000 hole elements
- [x] Top/bottom view toggle as a render-time mirror on the root `<g>`, with
      text counter-mirrored
- [x] Board size UI (cols/rows, 3–199) — per board, in the Boards panel
- [x] Multiple boards: add, remove, rename, recolour, drag to reposition
- [x] Background canvas grid that boards snap to
- [x] Warn above ~2000 holes (shown per board in the Boards panel)
- [x] **Edge pads**: per board, a pad strip on any of the four edges. One pad
      per lattice row/column, each covering two cells reaching outward and
      bonding them into one node. One `<pattern>` per strip, never one node per
      pad. Four L/T/B/R toggles in the Boards panel, no other options

### Phase 3 — Parts on the board  ✅ COMPLETE
- [x] `builtin.ts` seed parts (see Locked decisions for the exact list)
- [x] `PartsPanel.tsx` — right-hand palette, drag onto canvas
- [x] Part render: outline polygon + pins + optional clipped texture
- [x] Drag with **pin-lattice snapping** — snapping the part ORIGIN to a whole
      hole snaps every pin, because pins are integer part-local coords and
      rotation is a multiple of 90. The Fritzing single-anchor bug cannot recur
- [x] Rotate 90° CW/CCW (`]` / `[`), always re-snapped
- [x] Ghost far-side parts at low opacity — and with "ghost far side" OFF they
      still draw as a silhouette stroke plus a ring on every hole they occupy
      (`far="outline"` in `PartView.tsx`), because a hole taken from the other
      face must stay visible from this one
- [x] Select / delete / arrow-key nudge
- [x] **Live drop feedback**: a dragged part is tinted blue and every hole its
      pins will land in is ringed — red when the hole is off-board or already
      taken. Dragging from the parts panel previews the body the same way
- [x] **Multi-select / marquee**: rubber-band on the board, shift-click to
      toggle, Cmd/Ctrl+A for everything on this side. A multi-selection rotates
      as one block about the snapped centre of its origins (`rotateParts`)
- [x] **Move a placed part between top and bottom side** — Inspector, and
      `setPartSide` keeps the footprint (see Locked decisions)
- [x] No ref-designator label floating above a part on the canvas (removed —
      it read as clutter; the ref is still in the Inspector and in the pin tooltip)
- [x] Pin name labels drawn next to each pin, on the INTERIOR side (toward the
      body centroid) so the outer edge stays clear for the hole and the wire
      leaving it. Text colour switches white/black by WCAG relative-luminance
      contrast against the part's `fill` (`src/ui/color.ts`)
- [x] Hover tooltip (`<ref> · <pin name>`) on any pin — including a pin whose
      part is mounted on the far side, since it reads from `netlist.pinPos`
      (side-agnostic) rather than DOM hit-testing, which the ghost group's
      `pointer-events:none` would otherwise block
- [x] Ghosted far-side pins get a dashed highlight ring distinct from the body's
      low opacity, so a hole occupied from the other side still reads clearly
      when "ghost far side" is on
- [x] Each `PartsPanel` card has a **⋮ menu** (`Edit` / `Delete`) instead of only
      double-click-to-edit. Delete asks for confirmation and calls
      `removeDef`, which also strips every placed instance of that def and any
      wire bound to one of their pins — a board can never reference a missing def
- [x] **Stacking order** for overlapping parts — Inspector "Order" group,
      same feature as wires below (`reorderPartsAndWires` in `model/project.ts`)

### Phase 4 — Wiring  (complete but for the net highlight)
- [x] Wire tool as an explicit mode (toolbar button, `W`)
- [x] Draw hole→hole, with pin and free-point endpoints
- [x] Waypoints: click to place while drawing; double-click a segment to add a bend
- [x] Ortho assist (soft-snap within ~7°) + Shift hard-lock to 8 directions
- [x] Per-wire colour (13-colour palette, default blue) + banded toggle
- [x] Wires belong to the active side; far-side wires render ghosted
- [x] Fat transparent hit-stroke with `vector-effect="non-scaling-stroke"`
- [x] Dragging an existing waypoint
- [x] Recolour / re-band a wire after drawing it (select it, click a swatch)
- [x] **Stacking order**: Inspector "Order" group (to back / backward / forward
      / to front) on a wire OR part selection, Illustrator-style. Shared
      `reorderBySide` helper in `model/project.ts` — `project.wires` and
      `project.parts` array order IS paint order for each (`Canvas.tsx`
      renders each side's parts, then that side's wires, each in a filtered
      pass over its own array), so front/back move the selection to the
      array ends and forward/backward swap an item with its nearest
      *same-side* neighbour rather than the adjacent array element, so a step
      is never silently absorbed by an other-side item sitting between them
      in the raw array. Reordering a part goes through `reorderPartsAndWires`
      instead of bare `reorderParts`, which also applies the same stacking
      command to any wire with a pin anchor bound to that part — otherwise a
      part's cables would visually detach from it (drift to a different
      position in the independent wire stack) every time the part moves
- [x] Depth: drop shadows on boards and parts, specular highlight on wires
- [x] **Double-click a bend to remove it**
- [x] **Drag a whole segment**: it translates by whole holes and both bound
      endpoints stay put — a terminal grows a bend rather than being dragged
      off its hole (`moveSegment` in `Canvas.tsx`)
- [x] **Re-bind an existing wire endpoint** by dragging its handle to another
      hole or pin (select the wire first; handles only show when selected)
- [x] Minimum drag length: a drag under 6px is a click, not a wire, and a
      finished wire shorter than 0.4 holes is discarded
- [ ] Net highlight on hover/mouse-down (the yellow equipotential trick).
      The rendering supports it via `highlightNet`, but only clicking a wire
      sets `hoverNet`; clicking a pin or hole does not. Same item as the
      first one in Phase 7

### Phase 5 — Part editor modal  (mostly done)
- [x] Full-screen modal with its own grid canvas (extent is **grow-only** —
      recomputing it from the artwork shifts the canvas under the cursor
      mid-stroke and makes the pen tool unusable)
- [x] Pen tool: click to place vertices snapped to **half-hole** steps,
      rubber-band preview, Enter/click-first-vertex closes, Backspace removes
      last, Esc cancels
- [x] Edit after closing: drag vertices, midpoint ghost handles to insert, Delete to remove
- [x] Pin placement on whole holes, with names and auto-numbering
- [x] Image upload (png/jpeg/svg) → DOMPurify for SVG → place/scale/clip to outline
- [x] Show dimensions in hole units ("6 × 3 holes")
- [x] Corner-radius slider in the Shape section — filleting the FINISHED
      silhouette, not any one sub-shape (`Outline.cornerRadius` →
      `roundRing` in `model/shapes.ts`, applied in `outlineFillD`)
- [x] Save into the project's `defs`; edit an existing part (double-click a card)
- [ ] Validate non-self-intersecting and normalise winding (only the ≥3-vertex
      and ≥1-pin checks exist)
- [ ] Shift to constrain a pen segment to 0/45/90
- [ ] Pin name labels are drawn under the body fill, so they are hidden on dark
      parts — draw pin labels above the body

### Phase 6 — Persistence  (mostly done)
- [x] `perfproj.ts` — write/read the zip with fflate
- [x] Save via `browser-fs-access` (`fileSave`), private MIME
      `application/x-perfproj`, `suggestedName`, `id` for directory memory
- [x] **Save as…** (toolbar button, Cmd/Ctrl+Shift+S) — `saveProject(reuseHandle)`
      in `App.tsx`; passing `null` instead of `fileHandle.current` always shows
      the picker, and the returned handle becomes the target of later plain saves
- [x] Open via `fileOpen`
- [x] `autosave.ts` — debounced (1.2s idle) + on `visibilitychange`, into
      IndexedDB via `idb`; calls `navigator.storage.persist()` on first save
- [x] Autosave persists **asset bytes**, not just the project — an `assets`
      object store keyed by the same content hash, rehydrated into the
      in-memory store before the restored project reaches the app
- [x] Restore last session on load, with a 1.5s timeout so blocked storage
      cannot stall first paint
- [ ] Drag-a-file-onto-the-window to open
- [ ] Chromium only: stash `FileSystemFileHandle` in IndexedDB, offer a
      "Reopen «name».perfproj" button (permission needs a user gesture)
- [ ] Distinguish "saved to file" from "saved locally" in the UI — on
      Firefox/Safari the label must read "Download", since it cannot overwrite in place

### Phase 7 — Electrical feedback
- [x] Connected/unconnected pin colouring (green ≥2 parts, red otherwise)
- [ ] 👉 YOU ARE HERE — Net highlight: click a pin/hole, everything on that
      net glows
- [~] Named nets: the Inspector names a net (it writes the name onto every wire
      in it, since a net has no stable identity). Still missing: showing the
      label on the canvas and optionally colouring the net's wires

### Phase 8 — Polish
- [x] Undo/redo UI + keyboard (toolbar buttons, Cmd/Ctrl+Z, shift for redo)
- [x] Sidebar sections (Inspector/Boards/Parts) collapse and resize —
      `ui/Section.tsx` wraps each; layout (`collapsed`, `height`) is remembered
      per section id in `localStorage` under `perf-wiring:panel-layout`
- [x] Millimetre ruler along the main canvas's top and left edges, shared with
      the Part Editor via `ui/Ruler.tsx` (`mmTicks` + `<Ruler>`); both measure
      from their own frame's (0, 0) — the canvas's global hole origin for the
      board, the part's local origin for the editor
- [x] Inspector shows a selected part's on-board footprint in mm (rotation-aware:
      a 90°/270° part swaps width and height, since that is the footprint you'd
      actually measure with calipers)
- [x] Inspector shows a selected board's physical size in mm too — computed
      the same way `BoardSurface` sizes the substrate rect (hole span + the
      0.6-hole edge margin per side), so it matches what's actually drawn,
      not just `cols × rows` holes
- [ ] Copy/paste/duplicate
- [ ] Cursor-as-affordance
- [ ] Colour-wires-by-length toggle
- [ ] Export PNG/SVG of the current side
- [ ] Keyboard shortcut reference

---

## Commands

```
npm run dev       # Vite dev server, http://localhost:5173
npm run build     # tsc -b && vite build -> dist/
npm run preview   # serve the built dist/
npm run lint      # oxlint (this scaffold uses oxlint, not ESLint)
```

Dependencies already installed: `fflate`, `idb`, `browser-fs-access`, `dompurify`.
DOMPurify 3 ships its own types — do not add `@types/dompurify`.

---

## Gotchas

- **Never put holes in the DOM.** One `<rect>` + `<pattern>`. A 20×14 board is
  280 holes but the user can go to 199×199 ≈ 40,000.
- **Snap the whole pin lattice, not one pin.** Fritzing's single-anchor bug is
  the #1 thing we are fixing; do not reintroduce it by snapping the part origin
  and hoping.
- **Free endpoints must never render as connected.** That is Fritzing issue
  #4212 and it is a correctness matter, not cosmetics.
- **Bottom-side geometry**: mirror local X *before* rotating. Mirror-then-rotate
  and rotate-then-mirror give different results; `partToBoard` is the only place
  this should be decided.
- **`viewBox` animation is a trap** — transform the root `<g>` instead.
- **Non-passive wheel listener** or the browser page-zooms on trackpad pinch.
- **Vite 8 scaffold uses oxlint**, and `src/main.tsx` imports from `./ui/App.tsx`
  (moved out of the default scaffold location).
- **Pin ids must be unique within a part.** The `pins()` helper in
  `builtin.ts` derives an id by stripping non-word characters, so names like
  `+` and `-` both collapse to `""`. It now falls back to an index and
  de-duplicates — do not undo that. Wire anchors reference pin ids.
- **Autosaving the project alone loses every texture.** `project.assets`
  records only each asset's mime and name; the bytes live in a module-scoped
  `Map` in `io/assets.ts` that a reload wipes. `io/autosave.ts` therefore
  keeps a second IndexedDB object store, `assets`, keyed by the same content
  hash, and `loadSession` calls `setAsset` for everything the restored
  project references **before** returning — `App.tsx` memoises `assetUrls` on
  `s.project.assets`, so bytes arriving after `load()` would never produce a
  URL. `assetUrl` returns `''` for a missing id rather than throwing, which is
  why this failed silently: parts just rendered as bare fills. The DB is at
  version 2 for this store; anything else that adds a store must bump it
  again. Note that a session autosaved before this fix has no bytes anywhere
  — those textures are only recoverable from a `.perfproj` file.
- **A stale autosave can carry old bugs forward.** When a model-level fix
  lands, remember the IndexedDB session still holds the pre-fix document.
  `indexedDB.deleteDatabase('perf-wiring')` in the console clears it.
- **First paint must never await storage.** `openDB` can hang rather than
  reject when site data is blocked; `App.tsx` races the session load against a
  1.5s timeout for this reason.
- **An SVG hit target must hit-test on its FILL.** A `stroke="transparent"`
  ring with `vector-effect="non-scaling-stroke"` renders but Chrome will not
  hit-test it, so a handle built that way silently does nothing and whatever is
  underneath takes the drag. `HitDot` in `WireView.tsx` uses `fill="transparent"`
  with a radius scaled by `pxScale` instead. (The fat *line* hit-strokes are
  fine — a line has real geometry to inflate.)
- **`setPointerCapture` steals click and dblclick.** The compatibility mouse
  events fire at the capturing element, so once a drag captures on the `<svg>`
  a double-click on a bend arrives at the `<svg>`, not the bend. Double-clicks
  on wire handles are therefore recognised by hand (`doubleClicked` in
  `Canvas.tsx`, 400ms, same target key). Capturing on the root is still worth
  it: a drag no longer dies when the pointer leaves the canvas.
- **Handles only exist on a selected wire.** Endpoint re-binding and bend
  removal are invisible until you click the wire — that is deliberate (an
  always-on handle on every wire would be a minefield), but it means "drag the
  end of a wire" is a two-step gesture.
- **`window.__perf` is dev-only.** `src/main.tsx` parks the store there behind
  `import.meta.env.DEV` so the app can be driven and inspected over CDP. Do not
  reach for it from application code.
- **Pin hover tooltip searches `netlist.pinPos`, not DOM hit-testing.** A
  ghosted (far-side) part's `<g>` is `pointer-events:none`, so its pins cannot
  receive their own pointer events. `Canvas.tsx`'s `findHoverPin` instead does
  a nearest-pin search over every part regardless of side on every
  `pointermove`, with near-side parts checked first so a hole shared by both
  sides favours the one you are looking at. If tooltip misses ever show up,
  that search — not the SVG pointer events — is where to look.
- **`contrastColor` (`src/ui/color.ts`) judges a whole part by one colour.**
  It picks black/white for pin labels from `def.fill` using WCAG relative
  luminance, gamma-corrected — not a naive RGB average, so a colour like the
  resistor's tan (`#C8AA78`) can still come out white-on-tan. It does not
  account for a texture image drawn over the fill. The Part Editor's own pin
  labels (Phase 5's outstanding item) do not use this yet.
- **Sidebar section layout lives in `localStorage['perf-wiring:panel-layout']`**,
  a `{ [sectionId]: { collapsed?, height? } }` map read/written by
  `ui/Section.tsx`. Section ids (`inspector`, `boards`, `parts`) are
  the storage keys — renaming one in `App.tsx`/the panel components resets
  that section's remembered layout.
- **`Ruler`/`mmTicks` (`ui/Ruler.tsx`) are pure screen-space.** They take an
  already-computed `pxPerMm` and the screen position of world (0, 0) — no
  camera or view type — specifically so the same component serves both the
  main `Canvas` (hole-unit world, possibly mirrored) and the Part Editor
  (its own local-origin world). Render it as a sibling of the
  world-transformed `<g>`, never inside it.
- **`removeDef` cascades.** Deleting a part definition from the Parts panel
  removes every placed instance of it and any wire bound to one of their pins
  (same cascade `removeParts` already does for a canvas delete) — it is not a
  library-only removal.
- **Any dropdown/popover opened from inside a `Section` must be portaled.**
  `.section-body` is `overflow: auto` (that's how a resized section scrolls
  its own content), so a normal `position: absolute` child clips the instant
  it's near that section's bottom edge — that was the part-card ⋮ menu bug.
  `PartMenu` (`PartsPanel.tsx`) fixes this by rendering its dropdown via
  `createPortal(..., document.body)` with `position: fixed` computed from the
  button's own `getBoundingClientRect()`, and closes on scroll/resize rather
  than trying to track a moving anchor. Reuse that pattern for the next one
  of these instead of a plain absolute-positioned child.
- **Edge pads have exactly one shape, on purpose.** Two cells reaching outward,
  one pad per row/column, no gap, solid copper. A first pass offered `2 along` /
  `2 across` / `single` as a per-board setting and the user removed it against a
  reference image — do not reintroduce pad-size options.
- **A board's footprint is `boardExtent` (`src/model/pads.ts`), not `cols`/`rows`.**
  Edge pads sit outside the hole lattice, so the moment a board has a strip the
  two disagree. Everything that asks "how big is this board / what does it
  cover" must use the extent: the substrate rect in `BoardSurface`, `boardAt`,
  `moveBoard`'s membership test, `addBoard`'s placement, `Canvas.tsx`'s
  `worldBox` (which also sets the bottom-view mirror axis) and the Inspector's
  mm readout. `cols`/`rows` still mean exactly the lattice, and nothing else.
- **`boardAt` answering yes does NOT mean there is a hole there.** It tests the
  extent, which is a bounding box — so with strips on two adjacent edges the
  corner block between them is substrate with no copper on it. That is still the
  right answer for "which board did I just grab". `isHole` is the separate
  solderability test: lattice hole OR pad cell. Never substitute one for the
  other.
- **An edge pad is one node over two holes.** That is the single exception
  to "every hole is isolated", and it lives entirely in `computeNets` — pads
  have no `Anchor` kind of their own, because their cells *are* hole
  coordinates. The pad unions run after parts and wires and only bond cells that
  are already nodes; union them eagerly instead and a 199-row board litters the
  netlist with ~400 empty single-cell nets.
- **A pad strip is one `<pattern>`, like the hole lattice.** The tile is exactly
  one pad and the capsule is its two cells grown by `PAD_R` — literally the
  lattice pads merged, so it stays aligned however `PAD_R` is tuned. Four strips
  cost sixteen DOM nodes total (measured); drawing pads individually would cost
  ~800 on a big board and reintroduce the thing the hole pattern exists to
  avoid.
- **Moving a board must go through `moveBoard` (`src/model/project.ts`), never
  `updateBoard` with a bare `x`/`y` patch.** Parts and wires carry no `boardId`
  — membership is inferred purely by comparing absolute hole coordinates
  against the board's bounds (`boardAt`'s test, inlined as `onBoard` in
  `moveBoard`) — so `updateBoard` alone slides the board out from under
  everything on it. `moveBoard(project, id, dx, dy)` recomputes that
  membership against the board's PRE-move bounds and translates, by the same
  delta: part origins, hole/free wire anchors, and waypoints found within
  those bounds. Pin anchors need no special-casing — they have no stored
  coordinates and simply follow their part. `Canvas.tsx`'s `kind: 'board'`
  drag handler is the only call site today; it derives `dx`/`dy` from the
  live (already-partly-moved) project each pointermove frame, so the
  incremental deltas compose correctly frame to frame. This was a real bug:
  dragging a populated board left its parts and wires behind.
- **The body's corner radius is a render-time fillet only.** `outlineFillD`
  rounds the rings `outlineUnion` produces; `sampleOutline` (and therefore
  `partOutlinePoints`, bounds and hit-testing) still sees the sharp corners.
  That is deliberate — a fillet only ever removes area, so every consumer of
  the sampled outline stays conservative — but do not assume the two agree to
  the pixel. Any new code path that writes an `Outline` must spread the old
  one (`{ ...o, shapes }`), or it silently drops `cornerRadius`.
- **Space-to-pan has to be checked at every pointerdown handler, not just the
  canvas background.** Parts and wires call `stopPropagation` before the
  `<svg>` handler ever runs, so `tryPan(e)` is the first line of each of them.
  The held state lives in `spaceRef` (what the handlers read) plus a
  `spaceHeld` state used only to repaint the cursor, and a `window` `blur`
  listener clears both — a keyup delivered to another window never arrives and
  the hand tool would stick on.
- **`Canvas.tsx`'s window key handler stands down while `.modal-backdrop`
  exists.** The part editor is a modal that does NOT unmount the canvas, so
  without that check the board's Delete/arrow/Space bindings fire underneath
  it.
- The user's reference screenshot (a Fritzing sketch with an ESP32-S3 devkit,
  TP4056, buck converter and vibration motor on two perfboards) shows the kind
  of project this needs to handle comfortably — but those specific module parts
  were **declined** as built-ins; the user will draw them in the part editor.
- **Tool/side keyboard shortcuts**: `V` select, `W` wire, `Q` top, `E` bottom
  — bound in `Canvas.tsx`'s window keydown handler (same guard as the rest:
  stands down over an input/textarea or the part-editor modal). The toolbar
  had `(V)`/`(W)` in its button titles for a while before these were actually
  wired up; if new tools are added, extend this block rather than adding a
  second key handler.
- **Wire colour swatches in the toolbar are conditionally rendered**, not
  just hidden — `Toolbar.tsx` shows the swatch group when `tool === 'wire'`
  (picking the colour for the next wire you draw) **or** a wire is selected
  (recolouring it in Select mode, per Phase 4's "recolour after drawing"
  feature). Plain Select mode with nothing selected shows neither, since the
  swatches read as "pick a colour to do something" and there's nothing to
  apply it to.

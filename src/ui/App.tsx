import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fileOpen, fileSave, supported as fsSupported } from 'browser-fs-access'
import { assetUrlMap } from '../io/assets'
import { deserializeProject, PERFPROJ_MIME, projectBlob, suggestedFilename } from '../io/perfproj'
import type { Project } from '../model/types'
import { computeNets } from '../model/nets'
import { createProject, makeBoard, putDef, removeDef } from '../model/project'
import { normalizeProject } from '../model/shapes'
import { commit, getState, load, markClean, redo, set, undo, useEditor } from '../model/store'
import { builtinMap } from '../parts/builtin'
import { Canvas } from './Canvas'
import { PartEditor } from './PartEditor'
import { PartsPanel } from './PartsPanel'
import { ComponentsPanel } from './ComponentsPanel'
import { BoardsPanel } from './BoardsPanel'
import { Inspector } from './Inspector'
import { Toolbar } from './Toolbar'
import { useIsMobile } from './useMobile'

/**
 * Bring an older document up to date: a single `board` before multi-board
 * support, and a single-polygon `outline` before multi-shape part bodies.
 * Every load path — the default project AND file open — must go through this.
 */
function migrate(p: Project): Project {
  const legacy = p as Project & { board?: { cols: number; rows: number } }
  const boards = !p.boards && legacy.board
    ? [makeBoard({ cols: legacy.board.cols, rows: legacy.board.rows })]
    : (p.boards ?? [makeBoard()])
  return normalizeProject({ ...p, boards })
}

/**
 * The demo project, loaded fresh on every launch. There is no autosaved
 * session to fall back to on purpose: a visitor who wants to keep work
 * across reloads saves a `.perfproj` and reopens it, rather than the app
 * silently pinning them to whatever this file looked like on their first visit.
 */
async function loadDefaultProject(): Promise<Project | undefined> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}tiny-cam.perfproj`)
    if (!res.ok) return undefined
    const bytes = new Uint8Array(await res.arrayBuffer())
    return migrate(deserializeProject(bytes).project)
  } catch {
    return undefined
  }
}

export default function App() {
  const s = useEditor()
  const mobile = useIsMobile()
  /** The mobile side drawer. Closed on purpose: the canvas is the point, and
   *  the panel is an overlay you pull out to inspect something. */
  const [panelOpen, setPanelOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [editing, setEditing] = useState<{ defId?: string } | null>(null)
  const fileHandle = useRef<FileSystemFileHandle | null>(null)

  // Always open the demo project fresh — see loadDefaultProject.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const seeded = await loadDefaultProject()
      if (cancelled) return
      load(seeded ?? createProject('Untitled', builtinMap()), false)
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const netlist = useMemo(() => computeNets(s.project), [s.project])
  const assetUrls = useMemo(() => assetUrlMap(s.project.assets), [s.project.assets])

  /**
   * Write the project out. `reuseHandle` false always shows the picker, so
   * "Save as" writes a NEW file and then retargets later plain saves at it.
   * On Firefox/Safari there is no handle at all and both paths download.
   */
  const saveProject = useCallback(async (reuseHandle: boolean) => {
    const project = getState().project
    try {
      const handle = await fileSave(
        projectBlob(project),
        {
          fileName: suggestedFilename(project),
          extensions: ['.perfproj'],
          mimeTypes: [PERFPROJ_MIME],
          id: 'perf-wiring-projects',
        },
        reuseHandle ? fileHandle.current : null,
      )
      fileHandle.current = (handle as FileSystemFileHandle | null) ?? null
      markClean()
      const name = fileHandle.current?.name
      setStatus(fsSupported ? (name ? `Saved to ${name}` : 'Saved') : 'Downloaded')
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        setStatus(`Save failed: ${(err as Error).message}`)
      }
    }
  }, [])

  const onSave = useCallback(() => saveProject(true), [saveProject])
  const onSaveAs = useCallback(() => saveProject(false), [saveProject])

  const onOpen = useCallback(async () => {
    try {
      const file = await fileOpen({
        extensions: ['.perfproj'],
        mimeTypes: [PERFPROJ_MIME],
        id: 'perf-wiring-projects',
      })
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { project, warnings } = deserializeProject(bytes)
      load(migrate(project), false)
      fileHandle.current = (file.handle as FileSystemFileHandle | undefined) ?? null
      setStatus(warnings.length ? warnings.join(' ') : `Opened ${file.name}`)
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        setStatus(`Open failed: ${(err as Error).message}`)
      }
    }
  }, [])

  const onNew = useCallback(() => {
    if (getState().dirty && !confirm('Discard unsaved changes?')) return
    load(createProject('Untitled', builtinMap()), false)
    fileHandle.current = null
    setStatus('New project')
  }, [])

  // Tool shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && /input|textarea/i.test(t.tagName)) return
      const mod = e.metaKey || e.ctrlKey
      if (!mod) {
        if (e.key === 'v') set({ tool: 'select' })
        if (e.key === 'w') set({ tool: 'wire' })
        if (e.key === 'f') set({ side: getState().side === 'top' ? 'bottom' : 'top' })
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void (e.shiftKey ? onSaveAs() : onSave())
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
        e.preventDefault()
        void onOpen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSave, onSaveAs, onOpen])

  const defs = useMemo(() => Object.values(s.project.defs), [s.project.defs])

  if (!ready) return <div className="boot">Loading…</div>

  return (
    <div className={`app${mobile ? ' is-mobile' : ''}`}>
      <Toolbar
        onSave={() => void onSave()}
        onSaveAs={() => void onSaveAs()}
        onOpen={() => void onOpen()}
        onNew={onNew}
        mobile={mobile}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((v) => !v)}
      />
      <div className="body">
        <div className="canvas-host">
          <Canvas assetUrls={assetUrls} mobile={mobile} />
        </div>
        {mobile && panelOpen && (
          <div className="side-scrim" onClick={() => setPanelOpen(false)} />
        )}
        <aside className={`side${mobile ? ' drawer' : ''}${mobile && !panelOpen ? ' closed' : ''}`}>
          <Inspector netlist={netlist} />
          <ComponentsPanel assetUrls={assetUrls} />
          {/* The library and the board settings only exist to CHANGE the
              document, so they have no place in the view-only layout. */}
          {!mobile && (
          <PartsPanel
            defs={defs}
            assetUrls={assetUrls}
            onNewPart={() => setEditing({})}
            onEditPart={(id) => setEditing({ defId: id })}
            onDeletePart={(id) => {
              const def = s.project.defs[id]
              const placed = s.project.parts.filter((p) => p.defId === id).length
              const warning = placed > 0 ? ` This also removes ${placed} placed on the board.` : ''
              if (!confirm(`Delete part "${def?.name ?? 'part'}"?${warning}`)) return
              commit((p) => removeDef(p, id))
              setStatus(`Deleted part "${def?.name ?? id}"`)
            }}
          />
          )}
          {!mobile && <BoardsPanel />}
        </aside>
      </div>
      {editing && (
        <PartEditor
          initial={editing.defId ? s.project.defs[editing.defId] : undefined}
          assets={s.project.assets}
          onCancel={() => setEditing(null)}
          onSave={(d, assets) => {
            commit((p) => ({
              ...putDef(p, d),
              assets: { ...p.assets, ...assets },
            }))
            setEditing(null)
            setStatus(`Saved part "${d.name}"`)
          }}
        />
      )}
      {!mobile && (
      <div className="status">
        <span>
          {s.tool === 'wire'
            ? 'Wire: click or drag to start · click to add a bend · double-click or Enter to finish · double-click a bend to remove it · Shift constrains'
            : 'Select: drag a part to move · drag empty board for a marquee · shift-click adds · drag a wire segment or its handles to reshape · ] / [ rotate'}
        </span>
        <span className="spacer" />
        <span>{netlist.nets.length} nets</span>
        <span>
          {s.project.boards.length} board{s.project.boards.length === 1 ? '' : 's'} · {s.side}
        </span>
        <span className="msg">{status}</span>
      </div>
      )}
    </div>
  )
}

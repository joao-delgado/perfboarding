import { useSyncExternalStore } from 'react'
import { createProject } from './project'
import type { Project, Side } from './types'

export type Tool = 'select' | 'wire'

export interface Camera {
  /** Screen position, in px, of board origin (hole 0,0). */
  x: number
  y: number
  zoom: number
}

/** Fritzing's published cable colours, plus the rest of its 13-colour menu. */
export const WIRE_COLORS = [
  { name: 'blue', hex: '#418DD9' },
  { name: 'red', hex: '#CC1414' },
  { name: 'black', hex: '#404040' },
  { name: 'yellow', hex: '#FFE24D' },
  { name: 'green', hex: '#47CC79' },
  { name: 'grey', hex: '#999999' },
  { name: 'white', hex: '#FFFFFF' },
  { name: 'orange', hex: '#FF7033' },
  { name: 'ochre', hex: '#B8860B' },
  { name: 'cyan', hex: '#35C6D1' },
  { name: 'brown', hex: '#8B4513' },
  { name: 'purple', hex: '#8A4BC4' },
  { name: 'pink', hex: '#E86AA8' },
] as const

export interface Selection {
  parts: string[]
  wires: string[]
  boards: string[]
}

export const EMPTY_SELECTION: Selection = { parts: [], wires: [], boards: [] }

export interface EditorState {
  project: Project
  past: Project[]
  future: Project[]
  /** Which face of the board we are looking at. New parts and wires land here. */
  side: Side
  tool: Tool
  camera: Camera
  selection: Selection
  wireColor: string
  banded: boolean
  showFarSide: boolean
  showNets: boolean
  /** Net id currently being highlighted, if any. */
  hoverNet: string | null
  /** Definition being dragged out of the parts panel, for the drop preview.
   *  `dataTransfer` will not give up its payload during dragover, so the
   *  panel parks the id here on dragstart. */
  dragDefId: string | null
  dirty: boolean
  /** Bumped by every `load()`. The canvas re-fits the camera whenever it
   *  changes, so opening a document always frames the whole build. */
  loadSeq: number
  /** Bumped by `requestFit()`. Re-frames the whole build on demand — the
   *  mobile toolbar's only way back after panning off into empty paper. */
  fitSeq: number
}

const initial: EditorState = {
  project: createProject(),
  past: [],
  future: [],
  side: 'top',
  tool: 'select',
  camera: { x: 80, y: 80, zoom: 1 },
  selection: EMPTY_SELECTION,
  wireColor: '#418DD9',
  banded: false,
  showFarSide: true,
  showNets: true,
  hoverNet: null,
  dragDefId: null,
  dirty: false,
  loadSeq: 0,
  fitSeq: 0,
}

const UNDO_LIMIT = 100

let state: EditorState = initial
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getState(): EditorState {
  return state
}

/** Ephemeral change: camera, tool, selection. Never touches the undo stack. */
export function set(patch: Partial<EditorState>): void {
  state = { ...state, ...patch }
  emit()
}

/** Ask the canvas to re-frame the whole build. View state, not a document edit. */
export function requestFit(): void {
  set({ fitSeq: state.fitSeq + 1 })
}

/**
 * Document change. Pushes the previous project onto the undo stack.
 * Pass `coalesce` to merge with the previous commit (used during a drag, so a
 * 200-frame drag is one undo step rather than 200).
 */
export function commit(fn: (p: Project) => Project, coalesce = false): void {
  const next = fn(state.project)
  if (next === state.project) return
  const past = coalesce && state.past.length > 0 ? state.past : [...state.past, state.project]
  state = {
    ...state,
    project: next,
    past: past.slice(-UNDO_LIMIT),
    future: [],
    dirty: true,
  }
  emit()
}

/** Replace the whole document (open a file, new project). Clears history. */
export function load(project: Project, dirty = false): void {
  state = {
    ...state,
    project,
    past: [],
    future: [],
    selection: EMPTY_SELECTION,
    dirty,
    loadSeq: state.loadSeq + 1,
  }
  emit()
}

export function undo(): void {
  if (state.past.length === 0) return
  const prev = state.past[state.past.length - 1]
  state = {
    ...state,
    project: prev,
    past: state.past.slice(0, -1),
    future: [state.project, ...state.future].slice(0, UNDO_LIMIT),
    selection: EMPTY_SELECTION,
    dirty: true,
  }
  emit()
}

export function redo(): void {
  if (state.future.length === 0) return
  const next = state.future[0]
  state = {
    ...state,
    project: next,
    past: [...state.past, state.project].slice(-UNDO_LIMIT),
    future: state.future.slice(1),
    selection: EMPTY_SELECTION,
    dirty: true,
  }
  emit()
}

export function markClean(): void {
  state = { ...state, dirty: false }
  emit()
}

export function useStore<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(initial),
  )
}

export function useEditor(): EditorState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => initial,
  )
}

export function selectionIsEmpty(s: Selection): boolean {
  return s.parts.length === 0 && s.wires.length === 0 && s.boards.length === 0
}

export function selectionCount(s: Selection): number {
  return s.parts.length + s.wires.length + s.boards.length
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

/** Click semantics: plain click replaces the selection, shift-click toggles. */
export function selectOne(kind: keyof Selection, id: string, additive: boolean): void {
  const cur = getState().selection
  if (!additive) {
    set({ selection: { ...EMPTY_SELECTION, [kind]: [id] } })
    return
  }
  set({ selection: { ...cur, [kind]: toggle(cur[kind], id) } })
}

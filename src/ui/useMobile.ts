import { useSyncExternalStore } from 'react'

/**
 * Is this a touch device, and therefore the view-only layout?
 *
 * The rule is the INPUT, not the width: a touch device gets the viewer, a
 * mouse gets the editor. Sizing it by width instead would flip a narrow
 * desktop window into view-only mid-edit, and would leave a tablet in
 * landscape with hit targets drawn for a mouse and no pinch-zoom — editing by
 * touch was never actually possible here, so the viewer is strictly the
 * better answer on every one of them, phone or tablet.
 *
 * The width clause is only a backstop for a handset whose browser misreports
 * its pointer; at 600px nobody is editing anyway.
 */
const MOBILE_QUERY = '(pointer: coarse), (max-width: 600px)'

let mql: MediaQueryList | null = null

function query(): MediaQueryList {
  if (!mql) mql = window.matchMedia(MOBILE_QUERY)
  return mql
}

function subscribe(onChange: () => void): () => void {
  const m = query()
  m.addEventListener('change', onChange)
  return () => m.removeEventListener('change', onChange)
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => query().matches,
    () => false,
  )
}

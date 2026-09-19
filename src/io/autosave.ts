import { openDB, type IDBPDatabase } from 'idb'
import { getAsset, setAsset } from './assets'
import type { Project } from '../model/types'

/**
 * Session restore lives in IndexedDB, not in the file.
 *
 * showSaveFilePicker does not exist in Safari or Firefox and is not going to,
 * so the file on disk cannot be the continuity mechanism. IndexedDB works
 * everywhere and survives a reload.
 *
 * The project alone is NOT enough: `project.assets` records only each
 * texture's mime and name, while the bytes live in the in-memory store in
 * `assets.ts` — which a reload wipes. So the bytes get their own object
 * store here, keyed by the same content hash, and are put back into memory
 * before the restored project is handed to the app. Without this, a restored
 * part's texture resolves to an empty object URL and the part renders bare.
 */
const DB_NAME = 'perf-wiring'
const STORE = 'session'
const ASSETS = 'assets'
const KEY = 'last'

let dbPromise: Promise<IDBPDatabase> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 2, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
        if (!d.objectStoreNames.contains(ASSETS)) d.createObjectStore(ASSETS)
      },
    })
  }
  return dbPromise
}

export interface Session {
  project: Project
  savedAt: number
}

let persistRequested = false

/** Ids already written in this session, so a 1.2s autosave is not an image rewrite. */
const written = new Set<string>()

/**
 * Write out any texture bytes this project references that are not in the
 * asset store yet. Content-addressed, so an id that exists is by definition
 * already correct and is skipped.
 */
async function saveAssets(d: IDBPDatabase, project: Project): Promise<void> {
  const ids = Object.keys(project.assets ?? {})
  for (const id of ids) {
    if (written.has(id)) continue
    const data = getAsset(id)
    if (!data) continue
    if ((await d.getKey(ASSETS, id)) === undefined) await d.put(ASSETS, data, id)
    written.add(id)
  }
}

/** Put the referenced bytes back into the in-memory store. */
async function restoreAssets(d: IDBPDatabase, project: Project): Promise<void> {
  for (const id of Object.keys(project.assets ?? {})) {
    if (getAsset(id)) continue
    const data = (await d.get(ASSETS, id)) as Uint8Array | undefined
    if (data) {
      setAsset(id, data)
      written.add(id)
    }
  }
}

export async function saveSession(project: Project): Promise<void> {
  try {
    if (!persistRequested && navigator.storage?.persist) {
      persistRequested = true
      // Without this, the data is "best effort" and evictable under pressure.
      void navigator.storage.persist()
    }
    const d = await db()
    // Assets first: a session whose textures are missing is the bug this
    // ordering exists to prevent.
    await saveAssets(d, project)
    await d.put(STORE, { project, savedAt: Date.now() } satisfies Session, KEY)
  } catch (err) {
    console.warn('autosave failed', err)
  }
}

export async function loadSession(): Promise<Session | undefined> {
  try {
    const d = await db()
    const session = (await d.get(STORE, KEY)) as Session | undefined
    if (session?.project) await restoreAssets(d, session.project)
    return session
  } catch (err) {
    console.warn('session restore failed', err)
    return undefined
  }
}

export async function clearSession(): Promise<void> {
  try {
    const d = await db()
    await d.delete(STORE, KEY)
    await d.clear(ASSETS)
    written.clear()
  } catch {
    // nothing to do
  }
}

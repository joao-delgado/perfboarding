/**
 * Id generation, in its own module so both `project.ts` and `shapes.ts` can
 * use it without importing each other.
 */
let idCounter = 0

export function uid(prefix: string): string {
  idCounter += 1
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`
}

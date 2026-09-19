import DOMPurify from 'dompurify'

/**
 * An uploaded SVG is a document, not an inert image: it can carry <script>,
 * <foreignObject>, on* handlers, javascript: hrefs and external references.
 * We inline uploads (to clip them to the part outline), so sanitising is
 * mandatory rather than defence in depth.
 */
export function sanitizeSvg(source: string): string {
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'style', 'animate', 'set', 'handler'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'style'],
  })

  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml')
  if (doc.querySelector('parsererror')) throw new Error('This file is not valid SVG.')
  const svg = doc.documentElement
  if (svg.nodeName.toLowerCase() !== 'svg') throw new Error('This file is not an SVG.')

  // Any reference that leaves the document is a tracking or injection vector.
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of ['href', 'xlink:href']) {
      const v = el.getAttribute(attr)
      if (v !== null && !v.startsWith('#') && !v.startsWith('data:image/')) {
        el.removeAttribute(attr)
      }
    }
    for (const a of Array.from(el.attributes)) {
      if (a.name.toLowerCase().startsWith('on')) el.removeAttribute(a.name)
    }
  }

  // Prefer a viewBox so the artwork scales to whatever box we give it.
  if (!svg.getAttribute('viewBox')) {
    const w = parseFloat(svg.getAttribute('width') || '0')
    const h = parseFloat(svg.getAttribute('height') || '0')
    if (w > 0 && h > 0) svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  }

  return new XMLSerializer().serializeToString(svg)
}

export const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/svg+xml'

export async function readImageFile(file: File): Promise<{ bytes: Uint8Array; mime: string }> {
  if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
    const text = await file.text()
    return { bytes: new TextEncoder().encode(sanitizeSvg(text)), mime: 'image/svg+xml' }
  }
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
    throw new Error('Please choose a PNG, JPEG or SVG file.')
  }
  return { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type }
}

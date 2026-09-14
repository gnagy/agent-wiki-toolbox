/**
 * Resolution: Quartz's `shortest`, with one deliberate difference.
 *
 * The matching rule below is `transformLink`'s, mirrored rather than approximated —
 * a single-segment link matches on **basename alone**, a multi-segment one is a
 * *suffix* match, and only a link that names a folder gets the `index` variant. An
 * earlier version of this file registered every `x/index` note under `x`, which is
 * more generous than Quartz and would have resolved links the renderer 404s.
 *
 * **Where we differ, on purpose:** Quartz resolves only on a unique match and
 * otherwise falls through *silently* to a root-relative path — which, for an
 * ambiguous stem, is a URL that 404s. Here two matches is an error reported at
 * edit time. There is no confidence threshold and no "best" candidate: one match
 * is a link, anything else is reported.
 */
import {isFolderPath, simplifySlug, slugAnchor, slugifyPath, stripSlashes} from './slug.js'

const RELATIVE_SEGMENT = /^\.{0,2}$/

/**
 * The written target, reduced to what Quartz compares against `allSlugs`, plus
 * whether it names a folder.
 */
export function canonicaliseTarget(target) {
  const written = String(target ?? '')
  const segments = written.split('/').filter((segment) => segment.length > 0)
  const prefix = segments.filter((segment) => RELATIVE_SEGMENT.test(segment)).join('/')
  const filePath = segments.filter((segment) => !RELATIVE_SEGMENT.test(segment)).join('/')

  const slugged = slugifyPath(filePath)
  const simple = simplifySlug(slugged)
  const folder = isFolderPath(written) || isFolderPath(slugged)
  const canonical = stripSlashes([prefix, simple].filter(Boolean).join('/'))

  return {canonical, folder}
}

/** Keep the old name working for callers that only want the comparison key. */
export function normaliseTarget(target) {
  return canonicaliseTarget(target).canonical
}

/**
 * Index every `/`-suffix of every slug, which is exactly what `shortest` matches
 * on. A one-segment suffix *is* the basename, so both branches of Quartz's rule
 * read the same map.
 */
export function createResolver(resources) {
  const bySuffix = new Map()
  const bySlug = new Map()

  for (const resource of resources) {
    bySlug.set(resource.slug, resource)
    const segments = resource.slug.split('/')
    for (let index = 0; index < segments.length; index++) {
      const key = segments.slice(index).join('/')
      const known = bySuffix.get(key)
      if (known) known.push(resource)
      else bySuffix.set(key, [resource])
    }
  }

  const resolve = (target) => {
    const {canonical, folder} = canonicaliseTarget(target)

    // `[[index]]` canonicalises to nothing, because Quartz reads a trailing
    // `index` as the folder holding it and the folder here is the wiki root. The
    // renderer still lands on the root page — by falling through rather than by
    // matching — so the root note is the answer, and saying "placeholder" would be
    // a broken link the site does not have.
    if (!canonical) {
      // A target that was never written is a different thing from one that
      // canonicalises away: `[[#a-heading]]` names no note, and the caller decides
      // which note it meant.
      if (!String(target ?? '').trim()) return {status: 'empty', candidates: []}
      const root = bySlug.get('index')
      return root
        ? {status: 'resolved', resource: root, candidates: [root]}
        : {status: 'placeholder', candidates: []}
    }

    const direct = bySuffix.get(canonical) ?? []
    // The `index` variant is Quartz's, and only for a multi-segment folder target.
    const viaIndex =
      folder && canonical.includes('/') ? (bySuffix.get(`${canonical}/index`) ?? []) : []
    const candidates = [...new Set([...direct, ...viaIndex])]

    if (candidates.length === 1) return {status: 'resolved', resource: candidates[0], candidates}
    if (candidates.length === 0) return {status: 'placeholder', candidates}
    return {status: 'ambiguous', candidates: [...candidates].sort(byPath)}
  }

  return {
    bySuffix,
    bySlug,
    resolve,

    /**
     * An ordinary `[text](../other/note.md)` link. A relative path is not a stem
     * and does not get the `shortest` rule — it names exactly one file, so it
     * either exists or the link is broken.
     */
    resolveRelative(from, target) {
      const resource = bySlug.get(slugifyPath(joinRelative(from, target)))
      return resource ? {status: 'resolved', resource} : {status: 'missing'}
    },
  }
}

/** `..` and `.` resolved against the linking note's directory. */
export function joinRelative(from, target) {
  const out = from.split('/').slice(0, -1)
  for (const segment of stripSlashes(target).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/**
 * Does the target note have this heading? The anchor is slugged before it is
 * compared, as the renderer slugs it, so literal heading text passes exactly when
 * the rendered link lands. A `^blockid` is Obsidian's block reference, which is
 * not modelled, so it is skipped rather than reported.
 */
export function checkAnchor(resource, anchor) {
  if (!anchor) return 'none'
  if (anchor.startsWith('^')) return 'blockReference'
  return resource.headings.some((heading) => heading.anchor === slugAnchor(anchor)) ? 'ok' : 'missing'
}

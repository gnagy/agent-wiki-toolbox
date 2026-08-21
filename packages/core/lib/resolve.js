/**
 * Resolution: Quartz's `shortest`, with one deliberate difference.
 *
 * Quartz resolves only on a unique match and otherwise **falls through silently** to
 * a root-relative path — which, for an ambiguous stem, is a URL that 404s. A
 * source-level resolver can do better, so here two matches is an authoring error
 * reported at edit time, and the emitted URL stays byte-compatible with Quartz's
 * either way (toolbox decision 7).
 *
 * There is no confidence threshold and no "best" candidate. One match is a link;
 * anything else is a question for the author.
 */
import {slugifyPath} from './slug.js'

/**
 * Index every suffix of every slug, which is exactly what `shortest` matches on:
 * `slug === target` or `slug.endsWith('/' + target)`. A folder target additionally
 * matches that folder's `index`, so `a/b/index` registers under `a/b` as well.
 */
export function createResolver(resources) {
  const bySuffix = new Map()

  const register = (key, resource) => {
    const existing = bySuffix.get(key)
    if (existing) existing.push(resource)
    else bySuffix.set(key, [resource])
  }

  for (const resource of resources) {
    const segments = resource.slug.split('/')
    for (let index = 0; index < segments.length; index++) {
      register(segments.slice(index).join('/'), resource)
    }
    if (segments.at(-1) === 'index' && segments.length > 1) {
      const folder = segments.slice(0, -1)
      for (let index = 0; index < folder.length; index++) {
        register(folder.slice(index).join('/'), resource)
      }
    }
  }

  const bySlug = new Map(resources.map((resource) => [resource.slug, resource]))

  return {
    bySuffix,
    bySlug,
    resolve: (target) => resolveTarget(bySuffix, target),

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
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

/** The written target, reduced to the key the suffix index is built on. */
export function normaliseTarget(target) {
  return slugifyPath(String(target ?? '').replace(/^\.?\//, '').replace(/\/+$/, ''))
}

function resolveTarget(bySuffix, target) {
  const key = normaliseTarget(target)
  if (!key) return {status: 'empty', candidates: []}

  const candidates = bySuffix.get(key) ?? []
  if (candidates.length === 1) return {status: 'resolved', resource: candidates[0], candidates}
  if (candidates.length === 0) return {status: 'placeholder', candidates}
  return {status: 'ambiguous', candidates: [...candidates].sort(byPath)}
}

function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/**
 * Does the target note have this heading? A `^blockid` is Obsidian's block
 * reference, which decision 8 declines to model — so it is skipped rather than
 * reported, because reporting a thing we chose not to support is noise.
 */
export function checkAnchor(resource, anchor) {
  if (!anchor) return 'none'
  if (anchor.startsWith('^')) return 'blockReference'
  return resource.headings.some((heading) => heading.anchor === anchor) ? 'ok' : 'missing'
}

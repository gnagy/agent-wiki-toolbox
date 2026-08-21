/**
 * Quartz's slug rules, reimplemented from `@quartz-community/utils` so our
 * resolution and the renderer's cannot disagree (toolbox decision 10).
 *
 * **These are not our rules, and they move when the pinned Quartz SHA moves.**
 * That is the price decision 10 names out loud, and the shadow stage is the only
 * thing that catches it — nothing in this file can.
 *
 * Read from the installed `@quartz-community/crawl-links` bundle on 2026-08-21.
 */
import GithubSlugger from 'github-slugger'

/** One path segment, per Quartz's `slugifyPath`. */
export function slugifySegment(segment) {
  return segment
    .replace(/\s/g, '-')
    .replace(/&/g, '-and-')
    .replace(/%/g, '-percent')
    .replace(/\?/g, '')
    .replace(/#/g, '')
    .replace(/[<>:"|*]/g, '')
    .toLowerCase()
}

export function sluggify(value) {
  return value.split('/').map(slugifySegment).join('/').replace(/\/$/, '')
}

/**
 * A workspace-relative markdown path to the slug Quartz publishes it at.
 *
 * The last rule is the one that bites: **`foo/foo.md` collapses to `foo/index`**,
 * so every `[[foo]]` pointing at it resolves to a URL that never exists while the
 * link graph reports a perfect note. It is the failure that cost eight dead links,
 * and it is why unique basenames alone are not sufficient.
 */
export function slugifyPath(relativePath) {
  const withoutExtension = stripSlashes(relativePath).replace(/\.md$/i, '')
  let slug = sluggify(withoutExtension).replace(/(^|\/)_index$/, '$1index')

  const segments = slug.split('/')
  if (segments.length >= 2 && segments.at(-1) === segments.at(-2)) {
    segments[segments.length - 1] = 'index'
    slug = segments.join('/')
  }
  return slug
}

/** Quartz's `simplifySlug`: a trailing `index` is the folder it sits in. */
export function simplifySlug(slug) {
  const trimmed = endsWithSegment(slug, 'index') ? slug.slice(0, -'index'.length) : slug
  return stripSlashes(trimmed.replace(/\/$/, ''))
}

/** Quartz's `isFolderPath`: what makes a link name a folder rather than a note. */
export function isFolderPath(value) {
  return (
    value.endsWith('/') ||
    endsWithSegment(value, 'index') ||
    endsWithSegment(value, 'index.md') ||
    endsWithSegment(value, 'index.html')
  )
}

export function endsWithSegment(value, suffix) {
  return value === suffix || value.endsWith(`/${suffix}`)
}

export function stripSlashes(value) {
  return value.replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Heading text to its anchor, deduplicated within one note the way a rendered page
 * deduplicates it — two headings reading the same give `#a-heading` and
 * `#a-heading-1`. So a slugger belongs to a note, never to a workspace.
 */
export function createAnchorSlugger() {
  const slugger = new GithubSlugger()
  return (text) => slugger.slug(text)
}

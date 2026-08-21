/**
 * Quartz's slug rules, reimplemented because our resolution has to agree with the
 * renderer's byte for byte (toolbox decision 10).
 *
 * **These are not our rules and they move when the pinned Quartz SHA moves.** That
 * is the price decision 10 names explicitly, and the shadow stage exists to catch it
 * — nothing here can.
 */
import GithubSlugger from 'github-slugger'

/** `?#<>:"|*` cannot appear in a URL path segment, so Quartz drops them. */
const DROPPED = /[?#<>:"|*]/g

export function slugifySegment(segment) {
  return segment
    .replace(/\s/g, '-')
    .replace(/&/g, '-and-')
    .replace(/%/g, '-percent')
    .replace(DROPPED, '')
    .toLowerCase()
}

/** A workspace-relative markdown path to the slug Quartz would publish it at. */
export function slugifyPath(relativePath) {
  const withoutExtension = relativePath.replace(/\.md$/i, '')
  const slug = withoutExtension.split('/').map(slugifySegment).join('/').replace(/\/$/, '')
  return slug.replace(/_index$/, 'index')
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

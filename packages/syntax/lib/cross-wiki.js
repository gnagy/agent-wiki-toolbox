/**
 * `[text](prefix:path.md)` — a reference into another wiki.
 *
 * It is deliberately *not* a `[[wikilink]]`: an unresolved `[[…]]` is a
 * placeholder, and every cross-wiki reference would otherwise land in the
 * placeholder list forever, destroying the one signal that means *a note worth
 * writing*. So it is an ordinary markdown link with a scheme, invisible to the link
 * graph and resolved by the renderer.
 *
 * This package answers only *is this destination shaped like one, and what are its
 * parts*. Which prefixes exist, and what they resolve to, is a registry `publish`
 * owns.
 */

/**
 * Schemes that are URLs rather than wiki prefixes. The `//` guard catches
 * `https://…` on its own; these are the ones that do not use it.
 */
const URL_SCHEMES = new Set([
  'about',
  'blob',
  'data',
  'file',
  'ftp',
  'javascript',
  'mailto',
  'sms',
  'tel',
  'urn',
])

const PREFIXED = /^([A-Za-z][A-Za-z0-9+.-]*):(?!\/\/)(\S+)$/

/**
 * `{prefix, path, anchor}` for a cross-wiki destination, or `null` for anything
 * else — an ordinary relative link, a URL, a bare anchor.
 */
export function parseCrossWikiTarget(url) {
  const match = PREFIXED.exec(url ?? '')
  if (!match) return null

  const [, prefix, rest] = match
  if (URL_SCHEMES.has(prefix.toLowerCase())) return null

  const hash = rest.indexOf('#')
  const path = hash === -1 ? rest : rest.slice(0, hash)
  if (!path) return null

  const anchor = hash === -1 ? '' : rest.slice(hash + 1)
  return {prefix, path, anchor: anchor || null}
}

/** True when a link destination names another wiki. */
export function isCrossWikiTarget(url) {
  return parseCrossWikiTarget(url) !== null
}

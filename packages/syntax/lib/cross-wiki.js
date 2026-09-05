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
 * Schemes that are never wiki prefixes, whatever a registry says. The `//` guard
 * already catches `https://…`; `http:` and `https:` are here because the
 * slash-less form is legal and is still a URL.
 *
 * **This set and `PREFIXED` are the grammar**, and the Quartz cross-wiki
 * transformer restates both — it is symlinked into `.quartz/plugins/` and cannot
 * import them. `packages/publish/test/cross-wiki-agreement.test.js` drives the two
 * over one corpus and fails when they part company, because a prefix `core`
 * excludes from the graph and the renderer leaves as written is a link nothing
 * reports.
 */
const URL_SCHEMES = new Set([
  'about',
  'blob',
  'data',
  'file',
  'ftp',
  'http',
  'https',
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

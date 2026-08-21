/**
 * One note, reduced to what the graph needs.
 *
 * The result is plain JSON — no mdast, no positions beyond a line number. That is
 * what lets the whole index be written to a cache file and read back without
 * reparsing, and what lets the Quartz plugins consume it as data.
 */
import {getFrontmatter, parseCrossWikiTarget, visit} from '@agent-wiki-toolbox/syntax'

import {createAnchorSlugger, slugifyPath} from './slug.js'

/**
 * A link into another note, whatever syntax it was written in.
 *
 * `wiki` and `embed` are `[[…]]` and `![[…]]`; `markdown` is an ordinary relative
 * link to a `.md` file, which this estate uses rarely but does use; `crossWiki` is
 * `prefix:path.md`, which is deliberately *not* a graph edge — it names a note in
 * another workspace, and registering it here would poison the placeholder signal.
 */
function wikiLinkOf(node) {
  return {
    kind: node.embed ? 'embed' : 'wiki',
    target: node.target,
    anchor: node.anchor,
    alias: node.alias,
    line: node.position?.start.line ?? 0,
  }
}

function markdownLinkOf(node) {
  const url = node.url ?? ''
  const crossWiki = parseCrossWikiTarget(url)
  if (crossWiki) {
    return {
      kind: 'crossWiki',
      prefix: crossWiki.prefix,
      target: crossWiki.path,
      anchor: crossWiki.anchor,
      line: node.position?.start.line ?? 0,
    }
  }

  // Absolute URLs, mailto:, and in-page anchors are not edges between notes.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url === '') return null
  const [path, anchor = null] = url.split('#')
  if (!path || !/\.md$/i.test(path)) return null

  return {kind: 'markdown', target: path, anchor: anchor || null, line: node.position?.start.line ?? 0}
}

function headingText(node) {
  let text = ''
  visit(node, (child) => {
    if (child.type === 'text' || child.type === 'inlineCode') text += child.value
    else if (child.type === 'wikiLink') text += child.alias ?? child.target
  })
  return text.trim()
}

/** Parse one note's source into the record the index stores. */
export function parseNote({path, source, parser}) {
  const tree = parser.parse(source)
  const properties = getFrontmatter(tree) ?? {}

  const anchorOf = createAnchorSlugger()
  const headings = []
  const links = []
  let firstHeading = null

  visit(tree, (node) => {
    if (node.type === 'heading') {
      const text = headingText(node)
      if (node.depth === 1 && firstHeading === null) firstHeading = text
      headings.push({depth: node.depth, text, anchor: anchorOf(text)})
    } else if (node.type === 'wikiLink') {
      links.push(wikiLinkOf(node))
    } else if (node.type === 'link') {
      const link = markdownLinkOf(node)
      if (link) links.push(link)
    }
  })

  const slug = slugifyPath(path)
  const tags = Array.isArray(properties.tags)
    ? properties.tags.map(String)
    : typeof properties.tags === 'string'
      ? properties.tags.split(/[,\s]+/).filter(Boolean)
      : []

  return {
    path,
    slug,
    stem: slug.split('/').pop(),
    title: properties.title ?? firstHeading ?? slug.split('/').pop(),
    type: properties.type ?? 'note',
    properties,
    tags,
    headings,
    links,
  }
}

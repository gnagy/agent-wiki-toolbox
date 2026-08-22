/**
 * The mdast dialect: what a wikilink, an embed and front matter *are*.
 *
 * The bottom of the layer graph, and the only package that configures remark.
 * It resolves nothing, reads no directory and knows about no wiki — `core` does
 * that, and `format` deliberately cannot (toolbox decision 11).
 */
import {visit} from 'unist-util-visit'

export {visit}

export {
  default as remarkWikiLinks,
  wikiLinkSyntax,
  wikiLinkFromMarkdown,
  wikiLinkToMarkdown,
  wikiLinkToString,
} from './lib/wiki-link.js'

export {
  syntaxPlugins,
  createParser,
  createProcessor,
  parse,
  stringify,
} from './lib/processor.js'

export {getFrontmatter, setFrontmatter, editFrontmatter, sequenceItems} from './lib/frontmatter.js'

export {parseCrossWikiTarget, isCrossWikiTarget} from './lib/cross-wiki.js'

/** Every `[[wikilink]]` and `![[embed]]` in the note, in document order. */
export function wikiLinks(tree) {
  const found = []
  // A visitor returning a number is an index to continue from, so `push`'s return
  // value would make `visit` walk back over the node it just handed us.
  visit(tree, 'wikiLink', (node) => {
    found.push(node)
  })
  return found
}

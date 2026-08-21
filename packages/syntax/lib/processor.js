/**
 * The one place remark is configured. `core` and `format` both parse, and the one
 * place drift between them would be fatal is the wikilink dialect — so neither
 * assembles a processor of its own (toolbox decision 11).
 */
import {unified} from 'unified'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'

import remarkWikiLinks from './wiki-link.js'

/**
 * The dialect, as a list `unified().use()` accepts whole. Anything that parses a
 * note in this estate uses exactly this list and adds its own concerns after it.
 *
 * `remark-frontmatter` is not optional: without it YAML front matter parses as a
 * thematic break followed by prose, and serialising destroys it.
 */
export function syntaxPlugins() {
  return [[remarkFrontmatter, ['yaml', 'toml']], remarkGfm, remarkWikiLinks]
}

/** Parse only — the shape `core` wants, since it never writes. */
export function createParser() {
  return unified().use(remarkParse).use(syntaxPlugins()).freeze()
}

/**
 * Parse and serialise. `settings` goes to `remark-stringify`; the IntelliJ house
 * style lives in `format`, because deciding what a document should look like is
 * not the same question as deciding what it means.
 */
export function createProcessor({settings = {}} = {}) {
  return unified()
    .use(remarkParse)
    .use(syntaxPlugins())
    .use(remarkStringify, settings)
    .freeze()
}

const shared = createProcessor()

/** Markdown to mdast. */
export function parse(markdown) {
  return shared.parse(markdown)
}

/** mdast back to markdown, in the dialect's plainest form. */
export function stringify(tree) {
  return String(shared.stringify(tree))
}

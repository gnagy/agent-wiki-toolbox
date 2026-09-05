/**
 * The formatter: parse with the shared dialect, serialise the way IntelliJ would.
 *
 * **This package must never reach `core`**, and the layering check enforces it. It
 * is what keeps `awt fmt` working on a lone `CLAUDE.md` with no wiki anywhere in
 * sight, and it is the reason `syntax` is a layer of its own rather than something
 * `core` owns.
 */
import {unified} from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkLintFrontmatterSchema from 'remark-lint-frontmatter-schema'
import remarkValidateLinks from 'remark-validate-links'

import {syntaxPlugins} from '@agent-wiki-toolbox/syntax'

import {DEFAULT_SETTINGS} from './config.js'
import remarkIntellijTables from './intellij-tables.js'

/**
 * Report files whose contents differ from their formatted form.
 *
 * This is a transform rather than a compiler wrapper on purpose: unified-engine
 * skips stringification altogether when it has nothing to write, so in `--check`
 * mode the compiler is never called and a wrapper there would silently never fire.
 * Serialising the tree ourselves is the only way to compare. Apply last, after
 * every other plugin.
 */
export function remarkCheckFormatting() {
  const processor = this
  return (tree, file) => {
    const formatted = String(processor.stringify(tree, file))
    if (String(file.value) !== formatted) {
      const message = file.message('File is not formatted; run `awt fmt` to fix')
      message.ruleId = 'formatted'
      message.source = 'agent-wiki-toolbox'
    }
  }
}

/**
 * Build the processor. `mode: 'check'` adds the lint plugins the project config
 * asks for plus the formatting check; `mode: 'format'` stays purely mechanical.
 *
 * A `wikiLinks` key in an old config is accepted and ignored: the dialect is
 * `syntax`'s and is not configurable.
 */
export function buildProcessor(config = {}, mode = 'format') {
  const processor = unified().use(remarkParse).use(syntaxPlugins())

  if (mode === 'check') {
    if (config.schemas) processor.use(remarkLintFrontmatterSchema, {schemas: config.schemas})
    if (config.validateLinks) {
      const options = typeof config.validateLinks === 'object' ? config.validateLinks : {}
      processor.use(remarkValidateLinks, {repository: false, ...options})
    }
  }

  processor.use(remarkStringify, {...DEFAULT_SETTINGS, ...config.settings})
  processor.use(remarkIntellijTables)

  if (mode === 'check') processor.use(remarkCheckFormatting)

  return processor
}

/** Format one document. The whole of `awt fmt --stdin`, and the unit tests' door in. */
export function formatMarkdown(source, config = {}) {
  return String(buildProcessor(config, 'format').processSync(source))
}

/** True when the document is already in the form the formatter would write. */
export function isFormatted(source, config = {}) {
  return formatMarkdown(source, config) === source
}

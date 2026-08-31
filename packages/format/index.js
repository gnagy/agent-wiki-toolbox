/**
 * `mdfmt`'s formatter, absorbed: markdown serialised byte-identically to IntelliJ's
 * own formatter.
 *
 * **It must never depend on `core`.** Formatting a standalone `CLAUDE.md` with no
 * wiki in sight is the test, and the layering check is what keeps it true.
 */
export {
  buildProcessor,
  formatMarkdown,
  isFormatted,
  remarkCheckFormatting,
} from './lib/processor.js'
export {collectStream, runFormat} from './lib/engine.js'
export {
  AMBIGUOUS_CONFIG,
  CONFIG_NAMES,
  IGNORE_NAMES,
  anchorSchemas,
  detectIgnoreName,
  DEFAULT_SETTINGS,
  loadProjectConfig,
  resolveProjectConfig,
} from './lib/config.js'
export {intellijTables, default as remarkIntellijTables} from './lib/intellij-tables.js'

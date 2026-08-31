/**
 * Formatting a tree of files, as opposed to a string.
 *
 * This lives here rather than in `cli` so the regression it guards stays testable
 * next to the code: unified-engine skips stringification when it has nothing to
 * write, which is why `remarkCheckFormatting` is a transform. Route a check through
 * `processor.process()` instead and it passes on documents the engine would fail.
 */
import {statSync} from 'node:fs'
import {resolve as resolvePath} from 'node:path'
import process from 'node:process'

import {engine} from 'unified-engine'

import {detectIgnoreName} from './config.js'
import {buildProcessor} from './processor.js'

const MARKDOWN = /\.(md|markdown)$/i

/**
 * `extensions` governs what a *directory search* picks up. A file named on the
 * command line bypasses it entirely and is parsed as markdown whatever it is — so
 * `awt fmt awt.config.mjs` rewrote a JavaScript file as a markdown document,
 * escaping its `/**` to `/\*\*` and turning every ` * ` continuation line into a
 * list item. It reported success.
 *
 * There is no version of that a caller wanted, and the damage is silent and
 * total, so a named file with the wrong extension is refused rather than skipped:
 * skipping would also hide a typo in a path that was meant to be markdown.
 */
function notMarkdown(entries, cwd) {
  return entries.filter((entry) => {
    if (MARKDOWN.test(entry)) return false
    try {
      return statSync(resolvePath(cwd, entry)).isFile()
    } catch {
      // Not there, or not readable. unified-engine reports that better than this can.
      return false
    }
  })
}

/**
 * Run the formatter over `files`. Resolves to the exit code — 0 clean, 1 if any
 * file was unformatted or any lint rule fired.
 *
 * `cwd` is what the paths are relative to, and what the report names them
 * against. It is the cwd for a standalone run and the **wiki root** for one the
 * caller scoped with `--workspace` or drove over MCP, which is what lets both of
 * those speak in the workspace-relative paths every other part of the surface
 * takes — `meta/conventions.md`, not a path through wherever the wiki sits on disk.
 */
export function runFormat({
  files,
  config = {},
  mode = 'format',
  quiet = false,
  streamError,
  cwd = process.cwd(),
  // A person reading a terminal wants the colour; a program reading the report as
  // a string wants the filename it can match on, not the escape codes around it.
  color = true,
} = {}) {
  const processor = buildProcessor(config, mode)
  const roots = files?.length ? files : (config.files ?? ['.'])

  const wrong = notMarkdown(roots, cwd)
  if (wrong.length > 0) {
    const out = streamError ?? process.stderr
    out.write(
      `awt fmt: not markdown, and naming it would have rewritten it as markdown: ${wrong.join(', ')}\n` +
        '  Pass a directory to format the markdown inside it, or a .md/.markdown file.\n',
    )
    return Promise.resolve(2)
  }

  return new Promise((resolve, reject) => {
    engine(
      {
        processor,
        cwd,
        files: roots,
        extensions: ['md', 'markdown'],
        out: false,
        output: mode === 'format',
        frail: mode === 'check',
        quiet,
        color,
        detectConfig: false,
        // One name is all unified-engine takes, and we honour two — see
        // `detectIgnoreName`, which is where the choice between them is made.
        ignoreName: detectIgnoreName(roots, cwd),
        ignorePatterns: ['node_modules/'],
        detectIgnore: true,
        silentlyIgnore: true,
        ...(streamError ? {streamError} : {}),
      },
      (error, code) => (error ? reject(error) : resolve(code)),
    )
  })
}

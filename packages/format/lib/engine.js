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
import {Writable} from 'node:stream'

import {engine} from 'unified-engine'

import {anchorSchemas, detectIgnoreName} from './config.js'
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
 * A `Writable` that keeps what was written to it, for a caller that wants the
 * report as a value rather than on a stream — the CLI, so it can print a verdict
 * above it, and the MCP tool, so it does not land in the transport's log.
 *
 * **A real stream, not an object with a `write`.** The engine writes through the
 * callback form and waits for it, so a duck-typed one does not fail, it hangs —
 * and only on the runs that have something to report.
 */
export function collectStream() {
  const chunks = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk))
      done()
    },
  })
  stream.text = () => chunks.join('')
  return stream
}

/**
 * Run the formatter over `files`. Resolves to `{code, files, problems}` — the exit
 * code (0 clean, 1 if any file was unformatted or any lint rule fired), how many
 * files were processed, and how many of them had something to say.
 *
 * **The counts are the whole point of returning an object.** `quiet` suppresses
 * the files with nothing wrong, which is the right default and leaves a clean run
 * printing nothing at all — so the caller needs the totals to say *73 files
 * checked, all clean* rather than leaving silence to be read as "it did nothing".
 *
 * `cwd` is what the paths are relative to, and what the report names them
 * against. It is the cwd for a standalone run and the **wiki root** for one the
 * caller scoped with `--workspace` or drove over MCP, which is what lets both of
 * those speak in the workspace-relative paths every other part of the surface
 * takes — `meta/conventions.md`, not a path through wherever the wiki sits on disk.
 *
 * `configPath` is where `config` was read from, and it is what anchors the `schemas`
 * associations to the directory that declared them — see `anchorSchemas`. Without
 * it those globs fall back to being read against `cwd`, which is right only when
 * the run happens to be rooted where the config sits.
 */
export function runFormat({
  files,
  config = {},
  configPath,
  mode = 'format',
  // Only the files with something wrong, which is what every comparable formatter
  // reports. Listing the ones that were fine made `awt fmt --check` on a wiki 76
  // lines of "no issues found" — the one output on this binary long enough to
  // need a `| head`, which is where an exit code goes to die.
  quiet = true,
  streamError,
  cwd = process.cwd(),
  // A person reading a terminal wants the colour; a program reading the report as
  // a string wants the filename it can match on, not the escape codes around it.
  color = true,
} = {}) {
  const processor = buildProcessor(anchorSchemas(config, configPath, cwd), mode)
  const roots = files?.length ? files : (config.files ?? ['.'])

  const wrong = notMarkdown(roots, cwd)
  if (wrong.length > 0) {
    const out = streamError ?? process.stderr
    out.write(
      `awt fmt: not markdown, and naming it would have rewritten it as markdown: ${wrong.join(', ')}\n` +
        '  Pass a directory to format the markdown inside it, or a .md/.markdown file.\n',
    )
    return Promise.resolve({code: 2, files: 0, problems: 0})
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
      (error, code, context) => {
        if (error) return reject(error)
        const processed = context?.files ?? []
        resolve({
          code,
          files: processed.length,
          problems: processed.filter((file) => file.messages.length > 0).length,
        })
      },
    )
  })
}

/**
 * Formatting a tree of files, as opposed to a string.
 *
 * This lives here rather than in `cli` so the regression it guards stays testable
 * next to the code: unified-engine skips stringification when it has nothing to
 * write, which is why `remarkCheckFormatting` is a transform. Route a check through
 * `processor.process()` instead and it passes on documents the engine would fail.
 */
import {engine} from 'unified-engine'

import {IGNORE_NAMES} from './config.js'
import {buildProcessor} from './processor.js'

/**
 * Run the formatter over `files`. Resolves to the exit code — 0 clean, 1 if any
 * file was unformatted or any lint rule fired.
 */
export function runFormat({files, config = {}, mode = 'format', quiet = false, streamError} = {}) {
  const processor = buildProcessor(config, mode)

  return new Promise((resolve, reject) => {
    engine(
      {
        processor,
        files: files?.length ? files : (config.files ?? ['.']),
        extensions: ['md', 'markdown'],
        out: false,
        output: mode === 'format',
        frail: mode === 'check',
        quiet,
        color: true,
        detectConfig: false,
        // Two names, because a project that already has a `.mdfmtignore` is a
        // project we may not rename a file in.
        ignoreName: IGNORE_NAMES[0],
        ignorePatterns: ['node_modules/'],
        detectIgnore: true,
        silentlyIgnore: true,
        ...(streamError ? {streamError} : {}),
      },
      (error, code) => (error ? reject(error) : resolve(code)),
    )
  })
}

/**
 * Finding the notes, and the files beside them. A wiki is a directory of markdown
 * files; what else sits in it is an attachment a note can link to.
 */
import {readdirSync} from 'node:fs'
import {join} from 'node:path'

/** Never indexed: version control, dependencies, build output, editor state. */
const SKIP = new Set(['node_modules', '.git', '.obsidian', '.quartz-cache', 'public'])

/**
 * What Quartz's `**\/*.*` glob takes as a file: a name with an extension. A dotfile
 * is skipped before this is asked, as the glob skips it.
 */
const HAS_EXTENSION = /.\.[^.]+$/

/**
 * Every `.md` file under `root`, as workspace-relative POSIX paths, sorted so two
 * runs over one tree produce the same index in the same order.
 */
export function walkNotes(root) {
  return walkFiles(root).notes
}

/**
 * The notes and every other file with an extension, in one pass. The second list is
 * what a relative link to a CSV or an image is checked against, and what the
 * renderer publishes as a page of its own.
 */
export function walkFiles(root) {
  const notes = []
  const attachments = []
  walk(root, '', notes, attachments)
  return {notes: notes.sort(), attachments: attachments.sort()}
}

function walk(root, prefix, notes, attachments) {
  const dir = prefix ? join(root, prefix) : root
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const name = entry.name
    if (name.startsWith('.') || SKIP.has(name)) continue
    const relative = prefix ? `${prefix}/${name}` : name
    if (entry.isDirectory()) walk(root, relative, notes, attachments)
    else if (name.toLowerCase().endsWith('.md')) notes.push(relative)
    else if (HAS_EXTENSION.test(name)) attachments.push(relative)
  }
}

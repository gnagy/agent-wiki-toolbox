/** Finding the notes. A wiki is a directory of markdown files and nothing more. */
import {readdirSync} from 'node:fs'
import {join} from 'node:path'

/** Never indexed: version control, dependencies, build output, editor state. */
const SKIP = new Set(['node_modules', '.git', '.obsidian', '.quartz-cache', 'public'])

/**
 * Every `.md` file under `root`, as workspace-relative POSIX paths, sorted so two
 * runs over one tree produce the same index in the same order.
 */
export function walkNotes(root) {
  const found = []
  walk(root, '', found)
  return found.sort()
}

function walk(root, prefix, found) {
  const dir = prefix ? join(root, prefix) : root
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const name = entry.name
    if (name.startsWith('.') || SKIP.has(name)) continue
    const relative = prefix ? `${prefix}/${name}` : name
    if (entry.isDirectory()) walk(root, relative, found)
    else if (name.toLowerCase().endsWith('.md')) found.push(relative)
  }
}

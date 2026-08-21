/**
 * `renameTag` — one tag becomes another, everywhere it appears.
 *
 * Front-matter tags only. Obsidian's inline `#tag` is deliberately not a second tag
 * vocabulary here ([[toolbox-decisions]] 8), and Foam never treated it as one
 * either, so there is nothing else to rewrite.
 */
import {getFrontmatter, setFrontmatter} from '@agent-wiki-toolbox/syntax'

import {createContext, finish, parseNote, refuse, serialize} from './context.js'

export function renameTag(root, {from, to, workspace, dryRun} = {}) {
  const verb = 'renameTag'
  const context = createContext(root, {workspace, dryRun})
  const index = context.workspace
  const notes = []

  if (!from || !to) throw refuse(verb, 'renameTag needs both from and to')
  if (from === to) throw refuse(verb, `"${from}" and "${to}" are the same tag`)

  const carriers = index.tags.get(from) ?? []
  if (carriers.length === 0) {
    // Re-run, or a typo. Both are worth saying out loud rather than reporting
    // a silent success.
    notes.push(`no note carries the tag "${from}"`)
    return finish(verb, context, {notes})
  }

  for (const path of carriers) {
    const tree = parseNote(context, path)
    const properties = getFrontmatter(tree)
    if (!Array.isArray(properties?.tags)) continue

    // A note already carrying both ends up with one, not a duplicate.
    const tags = []
    for (const tag of properties.tags) {
      const next = tag === from ? to : tag
      if (!tags.includes(next)) tags.push(next)
    }
    setFrontmatter(tree, {...properties, tags})
    context.edit.update(path, serialize(tree))
  }

  return finish(verb, context, {notes})
}

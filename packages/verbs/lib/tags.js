/**
 * `renameTag` — one tag becomes another, everywhere it appears.
 *
 * Front-matter tags only. Obsidian's inline `#tag` is not a tag here, so there is
 * nothing else to rewrite.
 */
import {editFrontmatter, sequenceItems} from '@agent-wiki-toolbox/syntax'

import {createContext, finish, parseNote, refuse, serialize} from './context.js'

export function renameTag(notesDir, {from, to, workspace, dryRun} = {}) {
  const verb = 'renameTag'
  const context = createContext(notesDir, {workspace, dryRun})
  const index = context.workspace
  const notes = []

  if (!from || !to) throw refuse(verb, 'renameTag needs both from and to')
  if (from === to) throw refuse(verb, `"${from}" and "${to}" are the same tag`)

  const carriers = index.tags.get(from) ?? []
  // A re-run or a typo, and the verb cannot tell them apart — so it refuses, the
  // way `deleteNote` and `mergeFiles` do about a note that is not there. It used
  // to say this in a note and still report `ok` and exit 0, which is the reading
  // a person takes from the verdict line and the only thing a script can see.
  // Nothing is lost by refusing: renaming a tag no note carries is not work that
  // was done, and `awt search --tag` is what says which tags exist.
  if (carriers.length === 0) throw refuse(verb, `no note carries the tag "${from}"`)

  for (const path of carriers) {
    const tree = parseNote(context, path)

    // Through the YAML document rather than through the parsed object: a rename
    // of one tag is not permission to reformat the block around it. Rewriting
    // `tags: [a, b]` as a block sequence and dropping the author's comments is
    // a change nobody asked for, and `awt fmt` leaves front matter alone for the
    // same reason.
    const changed = editFrontmatter(tree, (document) => {
      const tags = sequenceItems(document, 'tags')
      if (!tags) return false

      // A note already carrying both ends up with one, not a duplicate.
      const seen = new Set()
      tags.items = tags.items.filter((item) => {
        const next = item.value === from ? to : item.value
        if (seen.has(next)) return false
        seen.add(next)
        item.value = next
        return true
      })
    })

    if (changed) context.edit.update(path, serialize(tree))
  }

  return finish(verb, context, {notes})
}

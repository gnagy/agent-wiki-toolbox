/** YAML front matter, as data rather than as an opaque string. */
import {isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml} from 'yaml'

/** The parsed front matter, or `undefined` when the note has none. */
export function getFrontmatter(tree) {
  const node = tree.children[0]
  if (!node || node.type !== 'yaml') return undefined
  return parseYaml(node.value)
}

/**
 * Replace the front matter, inserting a node when the note has none. Returns the
 * tree so calls chain.
 *
 * This **reformats**: the data goes back through `stringify`, so comments are
 * gone and every style choice becomes the serializer's. That is right for front
 * matter this toolbox is deriving — a new note out of `splitByHeading` — and
 * wrong for front matter an author wrote. Use `editFrontmatter` for that.
 */
export function setFrontmatter(tree, data) {
  const value = stringifyYaml(data).replace(/\n$/, '')
  const first = tree.children[0]
  if (first && first.type === 'yaml') first.value = value
  else tree.children.unshift({type: 'yaml', value})
  return tree
}

/**
 * Edit an author's front matter in place, keeping what a `parse`/`stringify`
 * round trip loses: comments, quoting, and flow sequences written `[a, b]` rather
 * than as a block. `mutate` receives the YAML document.
 *
 * `awt fmt` deliberately leaves front matter opaque, so a verb that reformats it
 * is the only thing in the toolbox that touches an author's YAML style at all —
 * and it would do it on a note the author only asked to rename a tag in.
 *
 * A note with no front matter is left alone: there is nothing to edit, and
 * inventing a block is `setFrontmatter`'s job. Returns whether anything changed.
 */
export function editFrontmatter(tree, mutate) {
  const first = tree.children[0]
  if (!first || first.type !== 'yaml') return false
  const document = parseDocument(first.value)
  if (mutate(document) === false) return false
  // `[a, b]`, not `[ a, b ]`: the serializer pads a flow collection by default and
  // the estate's notes are not written that way, so the default would show up as a
  // diff on every note a tag rename touched.
  const value = document.toString({flowCollectionPadding: false}).replace(/\n$/, '')
  if (value === first.value) return false
  first.value = value
  return true
}

/** The items of a front-matter sequence as YAML nodes, or `null` if it is not one. */
export function sequenceItems(document, key) {
  const node = document.get(key)
  return isSeq(node) ? node : null
}

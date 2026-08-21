/** YAML front matter, as data rather than as an opaque string. */
import {parse as parseYaml, stringify as stringifyYaml} from 'yaml'

/** The parsed front matter, or `undefined` when the note has none. */
export function getFrontmatter(tree) {
  const node = tree.children[0]
  if (!node || node.type !== 'yaml') return undefined
  return parseYaml(node.value)
}

/**
 * Replace the front matter, inserting a node when the note has none. Returns the
 * tree so calls chain.
 */
export function setFrontmatter(tree, data) {
  const value = stringifyYaml(data).replace(/\n$/, '')
  const first = tree.children[0]
  if (first && first.type === 'yaml') first.value = value
  else tree.children.unshift({type: 'yaml', value})
  return tree
}

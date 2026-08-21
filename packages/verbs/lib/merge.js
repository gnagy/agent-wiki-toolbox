/**
 * `mergeFiles` — several notes become one, and the links into them follow.
 *
 * The inverse of `splitByHeading`, and it inherits the same rule about judgment:
 * the caller says which notes merge into which, and in what order. Each source
 * arrives as a section under its own title, so `[[source]]` can be rewritten to
 * `[[target#that-title]]` and no inbound link is lost.
 */
import {getFrontmatter} from '@agent-wiki-toolbox/syntax'
import {createAnchorSlugger, slugifyPath} from '@agent-wiki-toolbox/core'

import {createContext, finish, parseNote, refuse, serialize} from './context.js'
import {shortestUniqueForm, visitLinks} from './rewrite.js'

/**
 * @param sources `[path]` — merged in the order given.
 * @param into    the note they are appended to. It must already exist.
 * @param depth   heading depth for each source's section (default 2).
 * @param source  `'delete' | 'keep'` — what happens to the merged notes.
 */
export function mergeFiles(root, {sources, into, depth = 2, source, workspace, dryRun} = {}) {
  const verb = 'mergeFiles'
  const context = createContext(root, {workspace, dryRun})
  const index = context.workspace
  const notes = []
  const unresolved = []

  if (!Array.isArray(sources) || sources.length === 0) throw refuse(verb, 'mergeFiles needs sources')
  if (!['delete', 'keep'].includes(source)) {
    throw refuse(verb, `the sources' fate is part of the call: source must be delete or keep`)
  }
  const target = index.get(into)
  if (!target) throw refuse(verb, `no note at ${into} to merge into`)
  if (sources.includes(into)) throw refuse(verb, `${into} cannot be merged into itself`)

  const present = sources.filter((path) => index.get(path))
  const already = sources.filter((path) => !index.get(path))
  if (already.length > 0) notes.push(`already merged, and skipped: ${already.join(', ')}`)
  if (present.length === 0) return finish(verb, context, {notes})

  const targetTree = parseNote(context, into)
  const anchorOf = createAnchorSlugger()
  for (const heading of targetTree.children.filter((node) => node.type === 'heading')) {
    // Prime the slugger with the headings already on the page, so a new section
    // that repeats one gets the `-1` a rendered page would give it.
    anchorOf(textOf(heading))
  }

  const merged = []

  for (const path of present) {
    const tree = parseNote(context, path)
    const properties = getFrontmatter(tree) ?? {}
    const title = properties.title ?? textOf(tree.children.find((node) => node.type === 'heading')) ?? path

    const body = tree.children.filter((node) => node.type !== 'yaml' && node.type !== 'toml')
    // The source's own `#` title becomes the section heading, so it is not
    // repeated inside.
    const first = body[0]
    const rest = first?.type === 'heading' && first.depth === 1 ? body.slice(1) : body

    targetTree.children.push({
      type: 'heading',
      depth,
      children: [{type: 'text', value: title}],
    })
    targetTree.children.push(...shiftHeadings(rest, depth))
    merged.push({path, title, anchor: anchorOf(title)})
  }

  context.edit.update(into, serialize(targetTree))

  const slugsAfter = index.resources
    .filter((resource) => source !== 'delete' || !present.includes(resource.path))
    .map((resource) => resource.slug)
    .sort()
  const targetForm = shortestUniqueForm(slugifyPath(into), slugsAfter) ?? slugifyPath(into)

  for (const {path, anchor} of merged) {
    for (const notePath of index.backlinks(path)) {
      if (notePath === into) continue
      const tree = parseNote(context, notePath)
      let touched = false
      visitLinks(tree, (node) => {
        if (node.type !== 'wikiLink' || !node.target) return
        const outcome = index.resolve(node.target)
        if (outcome.status !== 'resolved' || outcome.resource.path !== path) return
        node.target = targetForm
        node.anchor = anchor
        touched = true
      })
      if (touched) context.edit.update(notePath, serialize(tree))
    }
    if (source === 'delete') context.edit.remove(path)
  }

  return finish(verb, context, {unresolved, notes})
}

function textOf(node) {
  if (!node) return null
  let text = ''
  const walk = (child) => {
    if (child.type === 'text' || child.type === 'inlineCode') text += child.value
    for (const grandchild of child.children ?? []) walk(grandchild)
  }
  walk(node)
  return text.trim() || null
}

function shiftHeadings(nodes, depth) {
  return nodes.map((node) =>
    node.type === 'heading' ? {...node, depth: Math.min(6, node.depth + depth - 1)} : node,
  )
}

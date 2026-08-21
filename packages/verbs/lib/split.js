/**
 * `splitByHeading` — one note becomes several, and the links into it follow.
 *
 * **The caller supplies the plan** ([[toolbox-decisions]] 15). A section title
 * becoming a filename is judgment, and the tool holds no naming convention at all:
 * with no plan it refuses rather than inventing names.
 *
 * What the tool does hold is the graph invariant. A basename already in the index
 * is a **hard error** and nothing is written — not a warning, and not a suffix
 * quietly appended.
 */
import {createAnchorSlugger, slugifyPath} from '@agent-wiki-toolbox/core'
import {getFrontmatter, setFrontmatter} from '@agent-wiki-toolbox/syntax'

import {createContext, finish, parseNote, refuse, serialize} from './context.js'
import {shortestUniqueForm, visitLinks} from './rewrite.js'

/** Heading text, the way `core` computes it, without importing its private helper. */
function headingText(node) {
  let text = ''
  const walk = (child) => {
    if (child.type === 'text' || child.type === 'inlineCode') text += child.value
    else if (child.type === 'wikiLink') text += child.alias ?? child.target
    for (const grandchild of child.children ?? []) walk(grandchild)
  }
  for (const child of node.children ?? []) walk(child)
  return text.trim()
}

/**
 * The nodes belonging to a heading: the heading itself and everything up to the
 * next heading at the same depth or shallower.
 */
function sectionOf(tree, heading) {
  const start = tree.children.findIndex(
    (node) => node.type === 'heading' && headingText(node) === heading,
  )
  if (start === -1) return null

  const depth = tree.children[start].depth
  let end = start + 1
  while (end < tree.children.length) {
    const node = tree.children[end]
    if (node.type === 'heading' && node.depth <= depth) break
    end++
  }
  return {start, end, depth, nodes: tree.children.slice(start, end)}
}

/** Shift every heading so the section's own becomes the child note's `#` title. */
function promoteHeadings(nodes, depth) {
  return nodes.map((node) => {
    if (node.type !== 'heading') return node
    return {...node, depth: Math.max(1, node.depth - (depth - 1))}
  })
}

/**
 * @param plan   `[{heading, path}]` — every section to extract, and where it goes.
 * @param source `'delete' | 'stub' | 'keep'` — the source note's fate. No default.
 */
export function splitByHeading(root, {path, plan, source, workspace, dryRun} = {}) {
  const verb = 'splitByHeading'
  const context = createContext(root, {workspace, dryRun})
  const index = context.workspace
  const notes = []
  const unresolved = []

  if (!Array.isArray(plan) || plan.length === 0) {
    throw refuse(verb, 'splitByHeading needs an explicit heading-to-path plan; it invents no names')
  }
  if (!['delete', 'stub', 'keep'].includes(source)) {
    throw refuse(verb, `the source note's fate is part of the plan: source must be delete, stub or keep`)
  }

  const parent = index.get(path)
  if (!parent) throw refuse(verb, `no note at ${path}`)

  // Every basename in the plan must be free. Checked for the whole plan before
  // anything is written, so a collision on the third section does not leave the
  // first two extracted.
  const takenBy = new Map(index.resources.map((resource) => [resource.slug.split('/').pop(), resource.path]))
  const clashes = []
  for (const step of plan) {
    if (!step.path?.endsWith('.md')) throw refuse(verb, `plan entry for "${step.heading}" needs a .md path`)
    const stem = slugifyPath(step.path).split('/').pop()
    const owner = takenBy.get(stem)
    // A re-run finds its own earlier output: identical content is done, not a clash.
    if (owner && owner !== step.path) clashes.push(`${stem} (already ${owner})`)
  }
  if (clashes.length > 0) {
    throw refuse(verb, `these basenames are already in the wiki, so nothing was written: ${clashes.join(', ')}`)
  }

  const tree = parseNote(context, path)
  const properties = getFrontmatter(tree) ?? {}

  const sections = []
  for (const step of plan) {
    const section = sectionOf(tree, step.heading)
    if (!section) throw refuse(verb, `${path} has no heading "${step.heading}"; nothing was written`)
    sections.push({...step, section})
  }

  const slugsAfter = [
    ...index.resources.filter((resource) => resource.path !== path || source !== 'delete').map((r) => r.slug),
    ...plan.map((step) => slugifyPath(step.path)),
  ].sort()

  // Children first, so a run that dies halfway has written notes rather than
  // dangling links to notes that do not exist.
  for (const {heading, path: childPath, section} of sections) {
    const child = {
      type: 'root',
      children: promoteHeadings(section.nodes, section.depth),
    }
    setFrontmatter(child, {
      title: heading,
      type: properties.type ?? 'note',
      // [[conventions]] makes `area` equal the top-level folder, so it is derived
      // and checkable rather than guessed.
      area: childPath.split('/')[0],
      ...(properties.topic ? {topic: properties.topic} : {}),
      status: properties.status ?? 'draft',
      ...(properties.tags ? {tags: properties.tags} : {}),
    })
    context.edit.create(childPath, serialize(child))
    notes.push(`${childPath} has no description: that is judgment, and it is yours to write`)
  }

  // The source note.
  const remaining = tree.children.filter(
    (node) => !sections.some(({section}) => section.nodes.includes(node)),
  )

  if (source === 'delete') {
    context.edit.remove(path)
  } else if (source === 'stub') {
    const stub = {type: 'root', children: remaining}
    stub.children.push({
      type: 'paragraph',
      children: [{type: 'text', value: 'Split into:'}],
    })
    stub.children.push({
      type: 'list',
      ordered: false,
      spread: false,
      children: sections.map(({path: childPath}) => ({
        type: 'listItem',
        spread: false,
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'wikiLink',
                embed: false,
                target: shortestUniqueForm(slugifyPath(childPath), slugsAfter) ?? slugifyPath(childPath),
                anchor: null,
                alias: null,
              },
            ],
          },
        ],
      })),
    })
    context.edit.update(path, serialize(stub))
  } else {
    context.edit.update(path, serialize({type: 'root', children: remaining}))
  }

  // Inbound links. `[[parent#that-section]]` names exactly one child and is
  // rewritten; a bare `[[parent]]` has as many candidates as there are children
  // and escalates (decision 15).
  const anchorToChild = new Map(
    sections.map(({heading, path: childPath}) => [
      anchorFor(heading),
      shortestUniqueForm(slugifyPath(childPath), slugsAfter) ?? slugifyPath(childPath),
    ]),
  )

  for (const notePath of index.backlinks(path)) {
    const inboundTree = parseNote(context, notePath)
    let touched = false

    visitLinks(inboundTree, (node) => {
      if (node.type !== 'wikiLink' || !node.target) return
      const outcome = index.resolve(node.target)
      if (outcome.status !== 'resolved' || outcome.resource.path !== path) return

      if (node.anchor && anchorToChild.has(node.anchor)) {
        node.target = anchorToChild.get(node.anchor)
        node.anchor = null
        touched = true
        return
      }
      if (source === 'delete') {
        unresolved.push({
          from: notePath,
          line: node.position?.start.line ?? 0,
          target: node.target,
          reason: 'the note was split and deleted; this link names no single child',
          candidates: sections.map((entry) => entry.path),
        })
      }
    })

    if (touched) context.edit.update(notePath, serialize(inboundTree))
  }

  return finish(verb, context, {unresolved, notes})
}

/**
 * The anchor a rendered page gives a heading. `core`'s slugger, one string at a
 * time — a second implementation here would drift from the one the index built.
 */
function anchorFor(heading) {
  return createAnchorSlugger()(heading)
}

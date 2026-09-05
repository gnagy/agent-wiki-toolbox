/**
 * `splitByHeading`: one note becomes several, and the links into it follow.
 *
 * The caller supplies the heading-to-path plan; with no plan the verb refuses. A
 * basename already in the index is an error and nothing is written.
 */
import {createAnchorSlugger, createResolver, slugifyPath} from '@agent-wiki-toolbox/core'
import {getFrontmatter, setFrontmatter} from '@agent-wiki-toolbox/syntax'

import {createContext, finish, parseNote, refuse, serialize} from './context.js'
import {ambiguousStems, shortestResolvingForm, visitLinks} from './rewrite.js'

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
export function splitByHeading(notesDir, {path, plan, source, workspace, dryRun} = {}) {
  const verb = 'splitByHeading'
  const context = createContext(notesDir, {workspace, dryRun})
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

  for (const step of plan) {
    if (!step.path?.endsWith('.md')) throw refuse(verb, `plan entry for "${step.heading}" needs a .md path`)
  }

  // The children do not exist yet, so the wiki they are checked and named against
  // is the one this split produces — them included, and the source note dropped
  // when it is being deleted. Keyed by path so a re-run, which finds its own
  // earlier output already in the index, does not count a child twice and call it
  // ambiguous with itself.
  const afterByPath = new Map(
    index.resources
      .filter((resource) => resource.path !== path || source !== 'delete')
      .map((resource) => [resource.path, resource]),
  )
  for (const step of plan) {
    afterByPath.set(step.path, {path: step.path, slug: slugifyPath(step.path)})
  }
  const after = [...afterByPath.values()]
  const {resolve: resolveAfter} = createResolver(after)

  // A name already in the wiki means a bare stem matching more than one note.
  // Checked for the whole plan before anything is written, and asked of the
  // resolver, so a child named after its own folder is not mistaken for a clash
  // with the wiki's root note. `move` asks the same question.
  const wasAmbiguous = ambiguousStems(index.resources, index.resolve)
  const clashes = [...ambiguousStems(after, resolveAfter)].filter((stem) => !wasAmbiguous.has(stem)).sort()
  if (clashes.length > 0) {
    const matched = clashes
      .map((stem) => `[[${stem}]] (${resolveAfter(stem).candidates.map((c) => c.path).join(' and ')})`)
      .join(', ')
    throw refuse(verb, `these names are already in the wiki, so nothing was written: ${matched}`)
  }

  const linkTo = (childPath) =>
    shortestResolvingForm({path: childPath, slug: slugifyPath(childPath)}, resolveAfter) ??
    slugifyPath(childPath)

  const tree = parseNote(context, path)
  const properties = getFrontmatter(tree) ?? {}

  const sections = []
  for (const step of plan) {
    const section = sectionOf(tree, step.heading)
    if (!section) throw refuse(verb, `${path} has no heading "${step.heading}"; nothing was written`)
    sections.push({...step, section})
  }


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
      // `area` is the top-level folder.
      area: childPath.split('/')[0],
      ...(properties.topic ? {topic: properties.topic} : {}),
      status: properties.status ?? 'draft',
      ...(properties.tags ? {tags: properties.tags} : {}),
    })
    context.edit.create(childPath, serialize(child))
    notes.push(`${childPath} has no description`)
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
                target: linkTo(childPath),
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
  // and is reported as unresolved.
  const anchorToChild = new Map(
    sections.map(({heading, path: childPath}) => [anchorFor(heading), linkTo(childPath)]),
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

/**
 * `splitByHeading`: one note becomes several, and the links into it follow.
 *
 * The caller supplies the heading-to-path plan; with no plan the verb refuses. A
 * basename already in the index is an error and nothing is written.
 *
 * **A child inherits its front matter; it invents none.** The source's block is
 * copied as the author wrote it — comments, quoting and flow sequences included —
 * with `title` set to the heading and `description` left out, because a
 * description is judgment about the new note and the source's is about the old
 * one. Nothing is derived from the path and no key gets a default: which keys a
 * wiki has and what their values mean are the project's choices, and a toolbox
 * that filled in `type: note` or read an area off the top folder was asserting a
 * vocabulary it does not own, and asserting it wrong wherever the layout nests.
 *
 * What a copy can get wrong is reported instead of guessed at: a key the child's
 * schema requires that the source never had, a violation of that schema, and —
 * when the child lands in another folder — the copied keys that may describe
 * where the source sat rather than where the child does. The schema check is the
 * one `frontmatter` writes run, and reports the same way: the write lands.
 */
import {dirname} from 'node:path'

import {createAnchorSlugger, createResolver, slugifyPath} from '@agent-wiki-toolbox/core'
import {readSchema} from '@agent-wiki-toolbox/format'
import {editFrontmatter, getFrontmatter, setFrontmatter} from '@agent-wiki-toolbox/syntax'

import {createContext, finish, parseNote, refuse, resolveNotePath, serialize} from './context.js'
import {FRONTMATTER_CODES, schemaCheck, schemaFor} from './frontmatter.js'
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
export async function splitByHeading(notesDir, {path: typedPath, plan: typedPlan, source, workspace, dryRun} = {}) {
  const verb = 'splitByHeading'
  const context = createContext(notesDir, {workspace, dryRun})
  const index = context.workspace
  const notes = []
  const unresolved = []

  if (!Array.isArray(typedPlan) || typedPlan.length === 0) {
    throw refuse(verb, 'splitByHeading needs an explicit heading-to-path plan; it invents no names')
  }
  if (!['delete', 'stub', 'keep'].includes(source)) {
    throw refuse(verb, `the source note's fate is part of the plan: source must be delete, stub or keep`)
  }

  for (const step of typedPlan) {
    if (!step.path?.endsWith('.md')) throw refuse(verb, `plan entry for "${step.heading}" needs a .md path`)
  }

  // The paths as this wiki names them, so a caller who types them the way the
  // shell shows them — `wiki/notes/…` from the repo root — gets the note and puts
  // the children where they meant. `mergeFiles` and `deleteNote` read them the
  // same way; the children do not exist yet, so for them the folders decide.
  const named = (typed) => {
    const found = resolveNotePath(notesDir, index, typed)
    if (found !== typed) notes.push(`read ${typed} as ${found}, relative to the notes directory`)
    return found
  }
  const path = named(typedPath)
  const plan = typedPlan.map((step) => ({...step, path: named(step.path)}))

  const parent = index.get(path)
  if (!parent) throw refuse(verb, `no note at ${path}`)

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
  const sourceBlock = tree.children[0]?.type === 'yaml' ? tree.children[0].value : null

  const sections = []
  for (const step of plan) {
    const section = sectionOf(tree, step.heading)
    if (!section) throw refuse(verb, `${path} has no heading "${step.heading}"; nothing was written`)
    sections.push({...step, section})
  }

  const violations = []

  // Children first, so a run that dies halfway has written notes rather than
  // dangling links to notes that do not exist.
  for (const {heading, path: childPath, section} of sections) {
    const child = {
      type: 'root',
      children: promoteHeadings(section.nodes, section.depth),
    }
    inheritFrontmatter(child, sourceBlock, heading)
    const childSource = serialize(child)
    notes.push(`${childPath} has no description`)

    const inherited = Object.keys(properties).filter((key) => key !== 'title' && key !== 'description')
    if (dirname(childPath) !== dirname(path)) {
      notes.push(...placementNotes({path, childPath, properties, inherited}))
    }

    const schema = await schemaFor(notesDir, childPath, childSource)
    const required = readSchema(schema)?.required
    if (Array.isArray(required)) {
      const missing = required.filter((key) => key !== 'title' && !(key in properties))
      if (missing.length > 0) {
        notes.push(
          `the schema for ${childPath} requires ${missing.join(', ')}, which ${path} does not have; ` +
            'no value was guessed',
        )
      }
    }

    const found = await schemaCheck(notesDir, childPath, childSource)
    if (found.length > 0) {
      notes.push(`written, and the schema for ${childPath} does not accept the result: ${found.join('; ')}`)
      violations.push(...found.map((reason) => `${childPath}: ${reason}`))
    }

    context.edit.create(childPath, childSource)
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

  const report = finish(verb, context, {unresolved, notes})
  return violations.length > 0 ? {...report, violations, code: FRONTMATTER_CODES.SCHEMA_VIOLATION} : report
}

/**
 * The source's front matter on the child, as the author wrote it, with the title
 * the heading and no description. A source with no block gives a child with only
 * a title — the one key the split itself decides.
 */
function inheritFrontmatter(child, sourceBlock, heading) {
  if (sourceBlock === null || !getFrontmatter({children: [{type: 'yaml', value: sourceBlock}]})) {
    setFrontmatter(child, {title: heading})
    return
  }
  child.children.unshift({type: 'yaml', value: sourceBlock})
  editFrontmatter(child, (document) => {
    document.delete('description')
    // In place when the source has a title, so its position and quoting hold;
    // first otherwise, which is where a title is looked for.
    if (document.has('title')) document.set('title', heading)
    else document.contents.items.unshift(document.createPair('title', heading))
  })
}

/**
 * What a child in another folder may have inherited wrongly. The keys are copied
 * regardless — which of them depend on placement is the project's knowledge, not
 * the toolbox's — but the caller is told they were written for somewhere else, and
 * any value that names one of the source's folders the child is not under is
 * named outright, since that is the likeliest to be wrong.
 */
function placementNotes({path, childPath, properties, inherited}) {
  if (inherited.length === 0) return []
  const from = dirname(path)
  const to = dirname(childPath)
  const childFolders = new Set(to.split('/'))
  const lines = [
    `${childPath} is in ${to}/ and its front matter was copied from ${path} in ${from}/; ` +
      `check whichever of ${inherited.join(', ')} depend on where a note sits`,
  ]
  const sourceFolders = new Set(from.split('/').filter((folder) => folder !== '.'))
  for (const key of inherited) {
    const value = properties[key]
    if (typeof value === 'string' && sourceFolders.has(value) && !childFolders.has(value)) {
      lines.push(`${childPath} inherited ${key}: ${value}, which names a folder ${path} is in and it is not`)
    }
  }
  return lines
}

/**
 * The anchor a rendered page gives a heading. `core`'s slugger, one string at a
 * time — a second implementation here would drift from the one the index built.
 */
function anchorFor(heading) {
  return createAnchorSlugger()(heading)
}

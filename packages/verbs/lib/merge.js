/**
 * `mergeFiles` — several notes become one, and the links into them follow.
 *
 * The inverse of `splitByHeading`, and it inherits the same rule about judgment:
 * the caller says which notes merge into which, and in what order. Each source
 * arrives as a section under its own title, so `[[source]]` can be rewritten to
 * `[[target#that-title]]` and no inbound link is lost.
 */
import {getFrontmatter} from '@agent-wiki-toolbox/syntax'
import {createAnchorSlugger, createResolver, slugifyPath} from '@agent-wiki-toolbox/core'

import {createContext, finish, parseNote, refuse, serialize} from './context.js'
import {relativePathFrom, shortestResolvingForm, visitLinks} from './rewrite.js'

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

    // In document order, so the shared slugger sees the merged page exactly as a
    // renderer would: the section heading first, then the source's own headings
    // under it.
    const sectionAnchor = anchorOf(title)
    targetTree.children.push({
      type: 'heading',
      depth,
      children: [{type: 'text', value: title}],
    })
    targetTree.children.push(...shiftHeadings(rest, depth))

    // What each of the source's anchors becomes on the merged page. Mostly
    // itself — the heading keeps its text — but a target that already had that
    // heading owns the plain slug, and the source's becomes `-1`. A link that
    // named one has to follow it there, not land on the target's.
    const sourceAnchorOf = createAnchorSlugger()
    const anchors = new Map()
    for (const heading of body.filter((node) => node.type === 'heading')) {
      const text = textOf(heading)
      anchors.set(sourceAnchorOf(text), rest.includes(heading) ? anchorOf(text) : sectionAnchor)
    }

    merged.push({path, title, anchor: sectionAnchor, anchors})
  }

  context.edit.update(into, serialize(targetTree))

  // Resolution as it will be once the sources are gone: dropping them can shorten
  // the form the target is named by, and the form has to resolve in the wiki that
  // results rather than in the one this read.
  const {resolve: resolveAfter} = createResolver(
    index.resources.filter((resource) => source !== 'delete' || !present.includes(resource.path)),
  )
  const targetForm = shortestResolvingForm(target, resolveAfter) ?? slugifyPath(into)

  for (const {path, anchor, anchors} of merged) {
    /**
     * Where a link into this source should now point. An anchor it did not name
     * lands on the section; one it did follows its heading. An anchor that names
     * no heading of the source was already pointing at nothing, and saying so is
     * what `deleteNote` does for the same situation.
     */
    const follow = (written, site) => {
      if (!written) return anchor
      const after = anchors.get(written)
      if (after !== undefined) return after
      unresolved.push({...site, reason: `${path} has no heading "#${written}"`, candidates: [into]})
      return anchor
    }

    for (const notePath of index.backlinks(path)) {
      if (notePath === into) continue
      const tree = parseNote(context, notePath)
      let touched = false
      visitLinks(tree, (node) => {
        const line = node.position?.start.line ?? 0

        if (node.type === 'wikiLink') {
          if (!node.target) return
          const outcome = index.resolve(node.target)
          if (outcome.status !== 'resolved' || outcome.resource.path !== path) return
          node.target = targetForm
          node.anchor = follow(node.anchor, {from: notePath, line, target: node.target})
          touched = true
          return
        }

        // A `[text](../a/source.md)` link points at a file, and after a merge with
        // `source: delete` that file is gone. It follows the content the same way
        // a wikilink does — the section is where the content now is.
        if (node.type !== 'link' || typeof node.url !== 'string') return
        if (!/\.md(#|$)/i.test(node.url)) return
        if (/^[a-z][a-z0-9+.-]*:/i.test(node.url)) return
        const [written, writtenAnchor] = node.url.split('#')
        const outcome = index.resolveRelative(notePath, written)
        if (outcome.status !== 'resolved' || outcome.resource.path !== path) return

        const to = follow(writtenAnchor, {from: notePath, line, target: node.url})
        node.url = `${relativePathFrom(notePath, into)}#${to}`
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

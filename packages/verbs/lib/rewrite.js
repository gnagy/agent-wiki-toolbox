/**
 * Rewriting the links into a note that moved.
 *
 * The edit is AST-scoped, not text-scoped: a stem appears in code spans, in URLs
 * and in ordinary prose, and node offsets tell those apart.
 *
 * A link is
 * written as the **shortest suffix of the new slug that resolves to one note**, so
 * `[[stem]]` stays a bare stem when the basename is still unique and grows a folder
 * segment when it is not. Anything with no unambiguous form comes back in the
 * report rather than being guessed at.
 */
import {slugifyPath} from '@agent-wiki-toolbox/core'

/**
 * The shortest way of writing a link to `{path, slug}` that resolution leads back
 * to it. **The one way a verb names a note in a link it writes.**
 *
 * The obvious implementation asks the string question — which suffix of the slug
 * no other slug shares — and that is not the same question, which is what an
 * earlier `shortestUniqueForm` got wrong in three verbs at once. A note named
 * after its own folder has the slug `x/y/index`, whose unique suffix `y/index` the
 * resolver reads as the folder `y` and does not find; the root note's slug is
 * `index`, unique and canonicalising to nothing. Both produced a link that was
 * written confidently and resolved to nothing.
 *
 * So candidates are generated shortest-first and each is put **back through
 * resolution**, and the first that comes back to this very resource wins. `resolve`
 * has to be the resolver of the wiki that will exist *after* the edit — the note
 * may be about to move, or may not be written yet.
 *
 * `null` when no form resolves, which a caller reports rather than guesses at.
 */
export function shortestResolvingForm(resource, resolve) {
  const segments = resource.slug.split('/')
  for (let index = segments.length - 1; index >= 0; index--) {
    const candidate = segments.slice(index).join('/')
    const outcome = resolve(candidate)
    if (outcome.status === 'resolved' && outcome.resource.path === resource.path) return candidate
  }
  return null
}

/**
 * The bare stems that match more than one note.
 *
 * Asked of the resolver rather than of the strings. Comparing last slug segments
 * is a different question and gets two cases
 * wrong at once: a note named after its own folder has the slug `x/y/index`, whose
 * last segment is `index` — a segment nobody chose and nothing resolves by — so a
 * string comparison called it a clash with the wiki's root note, while a stem that
 * genuinely resolves to two notes is what actually breaks a link.
 *
 * A verb diffs this across its own edit: a stem that is ambiguous afterwards and
 * was not before is an ambiguity the verb *created*, and the links it breaks are
 * in notes the verb never touches — every note that already wrote `[[stem]]` about
 * the other one. One that was already ambiguous is not the verb's doing.
 */
export function ambiguousStems(resources, resolve) {
  const found = new Set()
  for (const resource of resources) {
    const stem = resource.slug.split('/').pop()
    if (found.has(stem)) continue
    if (resolve(stem).status === 'ambiguous') found.add(stem)
  }
  return found
}

/** Relative path from the directory holding `from` to the file `to`. */
export function relativePathFrom(from, to) {
  const fromParts = from.split('/').slice(0, -1)
  const toParts = to.split('/')
  let shared = 0
  while (shared < fromParts.length && shared < toParts.length - 1 && fromParts[shared] === toParts[shared]) {
    shared++
  }
  const up = fromParts.slice(shared).map(() => '..')
  const down = toParts.slice(shared)
  const path = [...up, ...down].join('/')
  return up.length === 0 ? `./${path}` : path
}

/**
 * Rewrite every link in one already-parsed note that pointed at the note being
 * moved, so it points at where the note went. Returns what it did, so a verb can
 * report an empty rewrite rather than writing an unchanged file.
 *
 * `pointsAtMoved` is a predicate rather than a path because of the re-run case: a
 * move that wrote the file and died before the links leaves those links resolving
 * to *nothing*, so "which links pointed at the old note" can no longer be answered
 * by resolution. Finishing a partial completion has to match on the written target.
 */
export function rewriteLinksInTree({tree, notePath, pointsAtMoved, movedTo, resolveAfter, rebasing = false}) {
  const rewritten = []
  const unresolved = []
  const wanted = shortestResolvingForm({path: movedTo, slug: slugifyPath(movedTo)}, resolveAfter)

  visitLinks(tree, (node) => {
    const line = node.position?.start.line ?? 0

    if (node.type === 'wikiLink') {
      if (!node.target) return
      const verdict = pointsAtMoved(node, 'wiki')
      if (verdict === 'ambiguous') {
        unresolved.push({line, target: node.target, reason: 'ambiguous before the rewrite', candidates: []})
        return
      }
      if (verdict !== true) return

      if (wanted === null) {
        unresolved.push({
          line,
          target: node.target,
          reason: 'no unambiguous form for the new path',
          candidates: [movedTo],
        })
        return
      }
      if (node.target === wanted) return
      rewritten.push({from: node.target, to: wanted})
      node.target = wanted
      return
    }

    if (node.type === 'link' && typeof node.url === 'string' && /\.md(#|$)/i.test(node.url)) {
      // The note being moved carries *every* relative link from a directory that is
      // about to change, not only the ones aimed at itself. `rebaseRelativeLinks`
      // takes all of them, so this branch would only compute a second, wrong answer.
      if (rebasing) return
      if (isExternal(node.url)) return // a URL, or a cross-wiki reference
      if (pointsAtMoved(node, 'markdown') !== true) return
      const [, anchor] = node.url.split('#')
      const next = relativePathFrom(notePath, movedTo)
      if (node.url === next) return
      rewritten.push({from: node.url, to: next})
      node.url = anchor === undefined ? next : `${next}#${anchor}`
    }
  })

  return {rewritten, unresolved}
}

/**
 * Recompute a moved note's own outbound relative links against its new directory.
 *
 * `[text](../b/other.md)` is written from where the note sits, so a note that
 * changes folder arrives carrying paths computed from a directory it no longer
 * occupies — including the ones that point back at itself, which have to follow it
 * to its new path rather than resolve to the old one.
 *
 * A link that resolved to nothing before the move cannot be rebased: there is no
 * correct new form to compute, so it is reported rather than guessed at.
 */
export function rebaseRelativeLinks({tree, from, to, resolveRelative}) {
  const rewritten = []
  const unresolved = []

  visitLinks(tree, (node) => {
    if (node.type !== 'link' || typeof node.url !== 'string') return
    if (!/\.md(#|$)/i.test(node.url)) return
    if (isExternal(node.url)) return

    const [path, anchor] = node.url.split('#')
    const line = node.position?.start.line ?? 0
    const outcome = resolveRelative(from, path)
    if (outcome.status !== 'resolved') {
      unresolved.push({
        line,
        target: node.url,
        reason: 'a relative link that resolved to nothing, written from a folder that has changed',
        candidates: [],
      })
      return
    }

    const destination = outcome.resource.path === from ? to : outcome.resource.path
    const next = relativePathFrom(to, destination)
    const url = anchor === undefined ? next : `${next}#${anchor}`
    if (node.url === url) return
    rewritten.push({from: node.url, to: url})
    node.url = url
  })

  return {rewritten, unresolved}
}

/** A URL or a cross-wiki reference: a scheme-like prefix that is not a path. */
function isExternal(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url)
}

/** Every link-bearing node, in document order. */
export function visitLinks(node, visitor) {
  if (node.type === 'wikiLink' || node.type === 'link') visitor(node)
  for (const child of node.children ?? []) visitLinks(child, visitor)
}

/**
 * Rewriting the links into a note that moved.
 *
 * The edit is **AST-scoped**, not text-scoped, and toolbox decision 19 spells out
 * why: a stem appears in code spans, in URLs and in ordinary prose, and node
 * offsets tell those apart where a line-oriented match does not.
 *
 * The form a rewritten link takes is decision 7's rule run backwards. A link is
 * written as the **shortest suffix of the new slug that resolves to one note**, so
 * `[[stem]]` stays a bare stem when the basename is still unique and grows a folder
 * segment when it is not. Anything with no unambiguous form comes back in the
 * report rather than being guessed at.
 */
import {slugifyPath} from '@agent-wiki-toolbox/core'

/**
 * The shortest `folder/.../stem` form of `slug` that no other slug in `all` also
 * ends with. `null` when even the full slug is ambiguous, which cannot happen for
 * a real file but can for a caller-supplied plan.
 */
export function shortestUniqueForm(slug, all) {
  const segments = slug.split('/')
  for (let index = segments.length - 1; index >= 0; index--) {
    const candidate = segments.slice(index).join('/')
    const matches = all.filter((other) => other === candidate || other.endsWith(`/${candidate}`))
    if (matches.length === 1) return candidate
  }
  return null
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
export function rewriteLinksInTree({tree, notePath, pointsAtMoved, movedTo, slugsAfter}) {
  const rewritten = []
  const unresolved = []
  const wanted = shortestUniqueForm(slugifyPath(movedTo), slugsAfter)

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
      if (/^[a-z][a-z0-9+.-]*:/i.test(node.url)) return // a URL, or a cross-wiki reference
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

/** Every link-bearing node, in document order. */
export function visitLinks(node, visitor) {
  if (node.type === 'wikiLink' || node.type === 'link') visitor(node)
  for (const child of node.children ?? []) visitLinks(child, visitor)
}

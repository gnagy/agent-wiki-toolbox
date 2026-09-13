/**
 * Rewriting the links a move changes.
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
 * Point every link in one already-parsed note where a plan of moves leaves its
 * target, and write it once, against the tree the plan produces. Returns what it
 * did, so a verb can skip writing an unchanged file.
 *
 * A wikilink is touched when its note moves — rewritten to the shortest form that
 * resolves to the note in `resolveAfter`, which may drop a qualifier as well as
 * add one — or when its note stays but the written form would reach something
 * else afterwards. A link that still reaches the note it reached is left as
 * written.
 *
 * A relative markdown link is written from where its note sits, so a note that
 * moves has *every* relative link recomputed from `destination`, including the
 * ones pointing back at itself. In a note that stays, only a link whose target
 * moves changes.
 *
 * `finished` is the re-run case: a move that wrote the file and died before the
 * links leaves those links resolving to *nothing*, so which note they meant
 * cannot be answered by resolution, and the written target is matched against
 * the old slug by the same suffix rule that resolved it before.
 */
export function retargetLinksInTree({
  tree,
  notePath,
  destination,
  resolveBefore,
  resolveRelativeBefore,
  resolveAfter,
  finalPath,
  finished = [],
}) {
  const rewritten = []
  const unresolved = []
  const moving = destination !== notePath
  const forms = new Map()
  const formFor = (path) => {
    if (!forms.has(path)) forms.set(path, shortestResolvingForm({path, slug: slugifyPath(path)}, resolveAfter))
    return forms.get(path)
  }

  visitLinks(tree, (node) => {
    const line = node.position?.start.line ?? 0

    if (node.type === 'wikiLink') {
      if (!node.target) return
      const before = resolveBefore(node.target)
      let target
      let moves

      if (before.status === 'resolved') {
        target = finalPath(before.resource.path)
        moves = target !== before.resource.path
      } else if (before.status === 'ambiguous') {
        // Somebody else's ambiguity, unless the plan moves one of the notes it names.
        if (before.candidates.every((candidate) => finalPath(candidate.path) === candidate.path)) return
        unresolved.push({
          line,
          target: node.target,
          reason: 'ambiguous before the rewrite',
          candidates: before.candidates.map((candidate) => candidate.path),
        })
        return
      } else {
        const written = slugifyPath(node.target)
        const meant = finished.filter(({oldSlug}) => oldSlug === written || oldSlug.endsWith(`/${written}`))
        if (meant.length === 0) return
        if (meant.length > 1) {
          unresolved.push({
            line,
            target: node.target,
            reason: 'ambiguous before the rewrite',
            candidates: meant.map((entry) => entry.to),
          })
          return
        }
        target = meant[0].to
        moves = true
      }

      if (!moves) {
        const now = resolveAfter(node.target)
        if (now.status === 'resolved' && now.resource.path === target) return
      }

      const wanted = formFor(target)
      if (wanted === null) {
        unresolved.push({line, target: node.target, reason: 'no unambiguous form for the new path', candidates: [target]})
        return
      }
      if (node.target === wanted) return
      rewritten.push({from: node.target, to: wanted})
      node.target = wanted
      return
    }

    if (node.type === 'link' && typeof node.url === 'string' && /\.md(#|$)/i.test(node.url)) {
      if (isExternal(node.url)) return // a URL, or a cross-wiki reference

      const [path, anchor] = node.url.split('#')
      const before = resolveRelativeBefore(notePath, path)
      if (before.status !== 'resolved') {
        // Nothing to recompute a new form from, and the folder it was written
        // from is changing: reported rather than guessed at.
        if (moving) {
          unresolved.push({
            line,
            target: node.url,
            reason: 'a relative link that resolved to nothing, written from a folder that has changed',
            candidates: [],
          })
        }
        return
      }

      const target = finalPath(before.resource.path)
      if (!moving && target === before.resource.path) return
      const next = relativePathFrom(destination, target)
      if (path === next) return
      const url = anchor === undefined ? next : `${next}#${anchor}`
      rewritten.push({from: node.url, to: url})
      node.url = url
    }
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

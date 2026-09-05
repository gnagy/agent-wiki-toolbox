/**
 * `resolve` — what does this link point at, and what else was a candidate.
 *
 * New, not ported. [[toolbox-decisions]] 7 makes an ambiguous stem a hard error
 * rather than a guess, so **the tool that explains the failure is part of the
 * design**, not a debugging aid: "two notes match, here they are" is the whole
 * answer an author needs, and nothing else in the surface gives it.
 */
import {checkAnchor} from '@agent-wiki-toolbox/core'
import {parseCrossWikiTarget} from '@agent-wiki-toolbox/syntax'

export function resolve(workspace, {target, from} = {}) {
  const crossWiki = parseCrossWikiTarget(target)
  if (crossWiki) {
    return {
      target,
      status: 'crossWiki',
      prefix: crossWiki.prefix,
      path: crossWiki.path,
      anchor: crossWiki.anchor,
      note: 'a reference into another wiki; not resolved here',
    }
  }

  const [stem, anchor = null] = String(target ?? '').split('#')
  const outcome = stem === '' && from ? {status: 'resolved', resource: workspace.get(from)} : workspace.resolve(stem)

  if (outcome.status === 'ambiguous') {
    return {
      target,
      status: 'ambiguous',
      candidates: outcome.candidates.map((candidate) => candidate.path),
      note: 'add a folder segment to the link, or rename one of the notes',
    }
  }
  if (outcome.status !== 'resolved' || !outcome.resource) {
    return {target, status: 'placeholder', candidates: [], note: 'nothing matches'}
  }

  const resource = outcome.resource
  return {
    target,
    status: 'resolved',
    path: resource.path,
    slug: resource.slug,
    title: resource.title,
    anchor: anchor ? {name: anchor, status: checkAnchor(resource, anchor)} : null,
    headings: anchor ? resource.headings.map((heading) => heading.anchor) : undefined,
  }
}

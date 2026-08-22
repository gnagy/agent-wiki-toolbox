/**
 * The index and the graph: one pass over a directory of markdown, and everything
 * downstream reads the result rather than the files.
 *
 * It carries what Foam's index carried — resources, links, tags, placeholders — and
 * the one thing it did not: **headings**, which is what makes an anchor checkable at
 * all, in this wiki and across wikis.
 */
import {readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'

import {createParser} from '@agent-wiki-toolbox/syntax'

import {computeAddresses} from './address.js'
import {hashSource, readCache, writeCache} from './cache.js'
import {checkAnchor, createResolver, normaliseTarget} from './resolve.js'
import {parseNote} from './note.js'
import {walkNotes} from './walk.js'

const parser = createParser()

/** Every kind of link that is an edge between notes in *this* workspace. */
const INTERNAL = new Set(['wiki', 'embed', 'markdown'])

/**
 * Load a workspace. Warm, this is a few `stat` calls; cold, it parses everything.
 *
 * `cache: false` forces a cold read — what a benchmark wants, and what to reach for
 * when a cache is suspected of lying.
 */
export function loadWorkspace(root, {cache = true} = {}) {
  const previous = cache ? readCache(root) : new Map()
  const entries = new Map()
  const resources = []
  const stats = {parsed: 0, reused: 0, hashed: 0}
  // A `stat` that moved is a cache write even when nothing was parsed: without it
  // a touched-but-unchanged file fails the `stat` fast path on every load from
  // then on, and is re-read and re-hashed forever.
  let restatted = false

  for (const path of walkNotes(root)) {
    const absolute = join(root, path)
    const {size, mtimeMs} = statSync(absolute)
    const known = previous.get(path)

    // The fast path is `stat`; the hash is only the tiebreak. Hashing every note
    // unconditionally would read the whole wiki to learn nothing.
    if (known && known.size === size && known.mtimeMs === mtimeMs) {
      entries.set(path, known)
      resources.push(known.resource)
      stats.reused++
      continue
    }

    const source = readFileSync(absolute, 'utf8')
    const hash = hashSource(source)
    stats.hashed++

    if (known && known.hash === hash) {
      const entry = {...known, size, mtimeMs}
      entries.set(path, entry)
      resources.push(entry.resource)
      stats.reused++
      restatted = true
      continue
    }

    const resource = parseNote({path, source, parser})
    entries.set(path, {size, mtimeMs, hash, resource})
    resources.push(resource)
    stats.parsed++
  }

  if (cache && (stats.parsed > 0 || restatted || entries.size !== previous.size)) writeCache(root, entries)

  return buildWorkspace(root, resources, stats)
}

/** The graph over an already-parsed set of resources. Pure, and the unit tests' door in. */
export function buildWorkspace(root, resources, stats = {}) {
  const byPath = new Map(resources.map((resource) => [resource.path, resource]))
  const {resolve, resolveRelative} = createResolver(resources)

  const edges = []
  const placeholders = new Map()
  const ambiguities = []
  const brokenAnchors = []
  const brokenLinks = []
  const crossWikiLinks = []
  const aliasedLinks = []
  const backlinks = new Map()

  for (const resource of resources) {
    for (const link of resource.links) {
      const site = {from: resource.path, line: link.line, target: link.target, kind: link.kind}

      // `[[target|label]]`. Collected whatever the link resolves to, and whichever
      // wiki it points at: the objection is to the label, not to the target.
      if (link.alias) aliasedLinks.push({...site, alias: link.alias})

      if (link.kind === 'crossWiki') {
        crossWikiLinks.push({...site, prefix: link.prefix, anchor: link.anchor})
        continue
      }
      if (!INTERNAL.has(link.kind)) continue

      // A relative markdown link names a file; a wikilink names a stem. Only the
      // second gets the `shortest` rule.
      const found =
        link.kind === 'markdown' ? resolveRelative(resource.path, link.target) : resolve(link.target)

      // `[[#a-heading]]` names no note at all, which is what `resolve` reports as
      // `empty`. The note it means is the one it is written in. Deciding that here
      // rather than in `resolve` would put the same knowledge in two places, and
      // did: the branch in `resolve` was unreachable for exactly as long.
      const outcome = found.status === 'empty' ? {status: 'resolved', resource} : found

      if (outcome.status === 'missing') {
        brokenLinks.push(site)
        continue
      }

      if (outcome.status === 'ambiguous') {
        ambiguities.push({...site, candidates: outcome.candidates.map((candidate) => candidate.path)})
        continue
      }
      if (outcome.status !== 'resolved') {
        const key = normaliseTarget(link.target)
        const known = placeholders.get(key)
        if (known) known.sites.push(site)
        else placeholders.set(key, {target: key, sites: [site]})
        continue
      }

      const anchor = checkAnchor(outcome.resource, link.anchor)
      if (anchor === 'missing') brokenAnchors.push({...site, anchor: link.anchor, to: outcome.resource.path})

      // `target` is the link as written. It travels with the edge because the
      // anchor-only `[[#a-heading]]` case is a self-edge with an empty target, and
      // that is the only way to tell it apart from a note that links to itself by
      // name — which is a real edge the renderer draws.
      edges.push({
        from: resource.path,
        to: outcome.resource.path,
        kind: link.kind,
        line: link.line,
        anchor: link.anchor,
        target: link.target,
      })

      if (outcome.resource.path !== resource.path) {
        const inbound = backlinks.get(outcome.resource.path)
        if (inbound) inbound.add(resource.path)
        else backlinks.set(outcome.resource.path, new Set([resource.path]))
      }
    }
  }

  const outbound = new Map()
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    const known = outbound.get(edge.from)
    if (known) known.add(edge.to)
    else outbound.set(edge.from, new Set([edge.to]))
  }

  const unclosedLinks = resources.flatMap((resource) =>
    (resource.suspect ?? []).map((entry) => ({from: resource.path, ...entry})),
  )

  // Where each note is served, which is not always what it is named by — see
  // `address.js`. Derived rather than stored on the resource, because a resource
  // comes out of the cache and this is a property of the whole tree.
  const {addresses, collisions} = computeAddresses(resources)

  const tags = new Map()
  for (const resource of resources) {
    for (const tag of resource.tags) {
      const known = tags.get(tag)
      if (known) known.push(resource.path)
      else tags.set(tag, [resource.path])
    }
  }

  return {
    root,
    stats,
    resources,
    byPath,
    get(path) {
      return byPath.get(path)
    },
    resolve,
    resolveRelative,
    edges,
    crossWikiLinks,
    aliasedLinks,
    ambiguities,
    brokenAnchors,
    brokenLinks,
    unclosedLinks,
    shadowedNotes: collisions,
    tags,

    /**
     * The URL path this note is served at. Its slug, except where the note is the
     * landing page of a folder of its own name.
     */
    addressOf(path) {
      return addresses.get(path) ?? byPath.get(path)?.slug
    },

    /** Distinct notes linking *to* this one. */
    backlinks(path) {
      return [...(backlinks.get(path) ?? [])].sort()
    },

    /** Distinct notes this one links *to*. */
    outbound(path) {
      return [...(outbound.get(path) ?? [])].sort()
    },

    /**
     * Targets nothing resolves to. **This is the backlog signal, not an error
     * list** — a placeholder is a note worth writing, which is why a cross-wiki
     * reference must never be a wikilink.
     */
    placeholders() {
      return [...placeholders.values()].sort((a, b) => (a.target < b.target ? -1 : 1))
    },

    /** Notes with no edges at all, in either direction. */
    orphans() {
      return resources
        .filter((resource) => !backlinks.has(resource.path) && !outbound.has(resource.path))
        .map((resource) => resource.path)
    },

    /**
     * Notes with no way out. Foam's term, and Foam's meaning — a note you can reach
     * and then cannot leave, which is a different complaint from nobody linking to
     * it.
     */
    deadends() {
      return resources.filter((resource) => !outbound.has(resource.path)).map((resource) => resource.path)
    },

    /** Notes nothing links to. Reachable by search and by nothing else. */
    unreferenced() {
      return resources.filter((resource) => !backlinks.has(resource.path)).map((resource) => resource.path)
    },
  }
}

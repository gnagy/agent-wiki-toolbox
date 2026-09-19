/**
 * The index, written out as data.
 *
 * This is what makes the three Quartz plugins possible at all: Quartz symlinks a
 * local plugin directory into `.quartz/plugins/`, so a plugin that imported `core`
 * would have to resolve a bare specifier from outside the Quartz tree. They read
 * the index as an artifact instead.
 *
 * Keyed by slug, because that is the identity Quartz knows a page by. Everything is
 * sorted, so two runs over an unchanged wiki produce the same bytes and a diff of
 * two artifacts means something.
 */
import {mkdirSync, renameSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'
import process from 'node:process'

import {normaliseTarget} from './resolve.js'

export const ARTIFACT_VERSION = 1

/** The whole index as a plain object. */
export function materialiseIndex(workspace) {
  const pages = {}

  for (const resource of workspace.resources) {
    pages[resource.slug] = {
      path: resource.path,
      title: resource.title,
      // Where the page is served, which is the slug except for a note that is the
      // landing page of a folder of its own name. Published because the renderer
      // has to be told rather than work it out: a plugin that recomputed it would
      // move the slug Quartz reports without this index knowing, and everything
      // that looks a page up by that slug — the shadow, the published heading
      // list — would drop it silently.
      address: workspace.addressOf(resource.path),
      links: [],
      unresolved: [],
      ambiguous: [],
      // Where Quartz lands an ambiguous link. It resolves only on a unique match
      // and otherwise falls through silently to this root-relative slug, which
      // is usually a 404 and occasionally a real page. Published so the shadow can
      // exclude it from the comparison; `awt check` reports the ambiguity.
      ambiguousSlugs: [],
      headings: resource.headings.map((heading) => heading.anchor),
    }
  }

  for (const edge of workspace.edges) {
    // The one self-link the renderer does not draw is the anchor-only
    // `[[#a-heading]]`, which never leaves the page and is written with an empty
    // target. `[[its-own-stem]]` *is* rendered, so dropping it here would make the
    // shadow report an `extra` link on every note that names itself.
    if (edge.from === edge.to && !edge.target) continue
    const page = pages[workspace.get(edge.from).slug]
    const slug = workspace.get(edge.to).slug
    if (!page.links.includes(slug)) page.links.push(slug)
  }

  // A link to an attachment is no edge, but the renderer publishes the file as a
  // page of its own and links to it there, so the index says so too.
  for (const link of workspace.attachmentLinks) {
    const page = pages[workspace.get(link.from).slug]
    if (!page.links.includes(link.slug)) page.links.push(link.slug)
  }

  // A relative path that names no file is a broken link to `awt check`, and one
  // that climbs out of the notes names nothing the site publishes. Both render
  // broken, landed where the renderer lands them.
  for (const site of [...workspace.brokenLinks, ...workspace.outsideLinks]) {
    const page = pages[workspace.get(site.from).slug]
    if (!page.unresolved.includes(site.landing)) page.unresolved.push(site.landing)
  }

  for (const placeholder of workspace.placeholders()) {
    for (const site of placeholder.sites) {
      const page = pages[workspace.get(site.from).slug]
      if (!page.unresolved.includes(placeholder.target)) page.unresolved.push(placeholder.target)
    }
  }

  for (const site of workspace.ambiguities) {
    const page = pages[workspace.get(site.from).slug]
    if (!page.ambiguous.includes(site.target)) page.ambiguous.push(site.target)
    const fallthrough = normaliseTarget(site.target)
    if (fallthrough && !page.ambiguousSlugs.includes(fallthrough)) page.ambiguousSlugs.push(fallthrough)
  }

  for (const page of Object.values(pages)) {
    page.links.sort()
    page.unresolved.sort()
    page.ambiguous.sort()
    page.ambiguousSlugs.sort()
  }

  return {
    version: ARTIFACT_VERSION,
    notesDir: workspace.notesDir,
    slugs: workspace.resources.map((resource) => resource.slug).sort(),
    pages,
  }
}

/** Write it where a build can read it. Temp-and-rename, like the cache. */
export function writeIndexArtifact(workspace, outputPath) {
  const artifact = materialiseIndex(workspace)
  const temporary = `${outputPath}.${process.pid}.tmp`
  mkdirSync(dirname(outputPath), {recursive: true})
  writeFileSync(temporary, `${JSON.stringify(artifact, null, 1)}\n`)
  renameSync(temporary, outputPath)
  return artifact
}

/**
 * The index, written out as data.
 *
 * This is what makes the three Quartz plugins possible at all: Quartz symlinks a
 * local plugin directory into `.quartz/plugins/`, so a plugin that imported `core`
 * would have to resolve a bare specifier from outside the Quartz tree. **They read
 * the index as an artifact instead** ([[toolbox-shape]]), which is the same reason
 * decision 9 makes the index a pure function of the tree.
 *
 * Keyed by slug, because that is the identity Quartz knows a page by. Everything is
 * sorted, so two runs over an unchanged wiki produce the same bytes and a diff of
 * two artifacts means something.
 */
import {mkdirSync, renameSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'
import process from 'node:process'

export const ARTIFACT_VERSION = 1

/** The whole index as a plain object. */
export function materialiseIndex(workspace) {
  const pages = {}

  for (const resource of workspace.resources) {
    pages[resource.slug] = {
      path: resource.path,
      title: resource.title,
      links: [],
      unresolved: [],
      ambiguous: [],
      headings: resource.headings.map((heading) => heading.anchor),
    }
  }

  for (const edge of workspace.edges) {
    // A link into the note it is written in is not an edge the renderer draws:
    // `[[#a-heading]]` never leaves the page.
    if (edge.from === edge.to && !edge.target) continue
    const page = pages[workspace.get(edge.from).slug]
    const slug = workspace.get(edge.to).slug
    if (!page.links.includes(slug)) page.links.push(slug)
  }

  for (const placeholder of workspace.placeholders()) {
    for (const site of placeholder.sites) {
      const page = pages[workspace.get(site.from).slug]
      if (!page.unresolved.includes(placeholder.target)) page.unresolved.push(placeholder.target)
    }
  }

  for (const site of workspace.ambiguities) {
    const page = pages[workspace.get(site.from).slug]
    const key = site.target
    if (!page.ambiguous.includes(key)) page.ambiguous.push(key)
  }

  for (const page of Object.values(pages)) {
    page.links.sort()
    page.unresolved.sort()
    page.ambiguous.sort()
  }

  return {
    version: ARTIFACT_VERSION,
    root: workspace.root,
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

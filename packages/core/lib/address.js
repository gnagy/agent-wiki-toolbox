/**
 * Where a note is **served**, as opposed to what a link **names** it by.
 *
 * These are two different things and the toolbox used to have only one word for
 * both. A note sitting beside a folder of its own name is the case that splits
 * them:
 *
 *     campaigns/cosites-v2.md      ─┐
 *     campaigns/cosites-v2/         ├─ one page, served at /campaigns/cosites-v2/
 *       design/…  analysis/…       ─┘
 *
 * **Left alone, the two compete and the folder wins.** Quartz slugs the note to
 * `campaigns/cosites-v2` and emits `cosites-v2.html`; its FolderPage sees a folder
 * with no landing page inside it and emits `cosites-v2/index.html`, a generated
 * listing. Both are served, and nothing warns — two slugs, two files, every link
 * resolving to something. What makes it a defect is the trie behind breadcrumbs
 * and the explorer: it holds one node for `campaigns/cosites-v2`, carrying the
 * note's title and the listing's URL, so every navigation link for that folder
 * points away from the note it names.
 *
 * Quartz already applies this rule to the *other* layout — `x/x.md` becomes
 * `x/index`, Obsidian's convention with the landing page inside the folder, and
 * `slugifyPath` mirrors it. It cannot mirror the sibling layout, because
 * `slugifyPath` is handed one path and cannot know whether a folder of that name
 * exists. That needs the whole file list, which is what a workspace is.
 *
 * **The name does not move.** Resolution matches on the last segment of a slug, so
 * moving `campaigns/cosites-v2` to `campaigns/cosites-v2/index` would make
 * `[[cosites-v2]]` match nothing — the same reason `[[toolbox]]` does not resolve
 * under Quartz's own `toolbox/toolbox.md` layout. So a resource keeps its slug as
 * its identity and gains an `address` beside it, and only the address moves.
 *
 * This lives in `core` rather than in a Quartz plugin on purpose. A plugin that
 * recomputed it would move the slug the renderer reports without the index
 * knowing, and both the shadow and the published heading list look a page up by
 * exactly that, so every moved note would drop out of the comparison silently.
 * The address is published in the index artifact and the plugin reads it.
 */

const INDEX = 'index'

/**
 * `{addresses, collisions}` for a set of resources.
 *
 * `addresses` is path → served address, holding an entry only where the address
 * differs from the slug. `collisions` names the notes that should have moved and
 * could not because another note already holds the folder's landing page — which
 * is an authoring error rather than something to resolve silently, since one of
 * the two pages then shadows the other.
 */
export function computeAddresses(resources) {
  const addresses = new Map()
  const collisions = []

  // Every folder a note lives in. Only markdown makes a folder worth claiming: a
  // folder holding nothing but images gets no generated listing, so there is
  // nothing for a note to collide with and no reason to move its URL.
  const folders = new Set()
  for (const resource of resources) {
    const segments = resource.slug.split('/')
    for (let index = 1; index < segments.length; index++) {
      folders.add(segments.slice(0, index).join('/'))
    }
  }

  const bySlug = new Map(resources.map((resource) => [resource.slug, resource]))

  for (const resource of resources) {
    const {slug} = resource
    // Already a landing page, written as `index.md` or as Quartz's own `x/x.md`.
    if (slug === INDEX || slug.endsWith(`/${INDEX}`)) continue
    if (!folders.has(slug)) continue

    const target = `${slug}/${INDEX}`
    const held = bySlug.get(target)
    if (held) {
      collisions.push({path: resource.path, address: target, heldBy: held.path})
      continue
    }
    addresses.set(resource.path, target)
  }

  return {addresses, collisions}
}

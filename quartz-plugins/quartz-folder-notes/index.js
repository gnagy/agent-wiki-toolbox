/**
 * awt-folder-notes — a note beside a folder of its own name becomes that folder's
 * landing page.
 *
 *     campaigns/cosites-v2.md      ─┐
 *     campaigns/cosites-v2/         ├─ one page, served at /campaigns/cosites-v2/
 *       design/…  analysis/…       ─┘
 *
 * Without it the two compete and the folder wins: Quartz emits the note as
 * `cosites-v2.html` and its FolderPage emits `cosites-v2/index.html`, a generated
 * listing. Both are served, and the trie behind breadcrumbs and the explorer holds
 * one node carrying the note's title and the listing's URL — so every navigation
 * link for that folder points away from the note it names. The reasoning is in
 * `packages/core/lib/address.js`, and Quartz already applies the same rule to the
 * layout where the landing page sits *inside* the folder (`x/x.md` → `x/index`).
 *
 * **THE ADDRESS IS READ, NEVER COMPUTED** — rule 1 of the cross-wiki plugin, for
 * the same reason and with a sharper edge here. Recomputing it inside Quartz would
 * move the slug the renderer reports without the toolbox index knowing, and both
 * `awt-links` and `awt-headings` look a page up by exactly that slug: every moved
 * note would drop out of the shadow's comparison and out of the published heading
 * list, silently and uncounted. So `core` decides, the index carries
 * `pages[slug].address`, and this reads it.
 *
 * WHAT MOVES, AND WHAT DELIBERATELY DOES NOT
 *
 *   `file.data.slug` MOVES. Emitters write the page from it, so the note is
 *   emitted at `campaigns/cosites-v2/index.html`; FolderPage reads it to decide a
 *   folder already has a landing page, so no listing is generated; and the
 *   navigation trie is built from it, so the node carrying the note's title now
 *   also carries its address.
 *
 *   `ctx.allSlugs` DOES NOT. CrawlLinks resolves `[[wikilinks]]` against it by
 *   comparing the link text to the last segment of each slug. Move the entry and
 *   that segment becomes `index`, so `[[cosites-v2]]` matches nothing — which is
 *   exactly what happens to `[[toolbox]]` under Quartz's own `toolbox/toolbox.md`
 *   layout. The toolbox splits the two for the same reason: a note keeps its slug
 *   as its name and gains an address beside it.
 *
 * That leaves one gap, and closing it is the second half of the plugin. CrawlLinks
 * resolves to the slug it matched, so a link to a moved note comes out one segment
 * too shallow — `../campaigns/cosites-v2` rather than `../campaigns/cosites-v2/`.
 * A host trying `$uri/index.html` still finds the page and then serves it under a
 * URL one segment too shallow, so every relative link and asset on it resolves
 * against the parent folder. A page that loads with its stylesheet missing is
 * worse than one that 404s. The html pass puts the slash back, on the finished
 * href rather than on any one link syntax, so it is indifferent to whether the
 * link was written `[[cosites-v2]]`, `[[campaigns/cosites-v2]]` or as a relative
 * markdown link.
 *
 * The two passes cannot be folded together: every transformer's markdown plugins
 * run over every file before any html plugin sees any of them, so the slug is
 * settled site-wide by the time the first href is read.
 *
 * **Zero dependencies**, like the other three: the plugin directory is symlinked
 * into `.quartz/plugins/`, so anything imported here would have to resolve from
 * outside the Quartz tree.
 */
import fs from 'fs'
import path from 'path'

const DEFAULTS = {
  index: './.awt-index.json',
  indexBase: '..',
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Where an href lands, as a slug — or `null` if it is not this site's to resolve.
 *
 * `from` is the slug of the page the href was written on, which by this point is
 * the *moved* slug, and which is also what CrawlLinks measured its relative paths
 * against. Resolving against anything else would be off by the very segment this
 * plugin added.
 */
function resolveHref(from, href) {
  if (!href || href.startsWith('#') || href.startsWith('//') || SCHEME.test(href)) return null
  const [link] = href.split('#')
  // Already a folder URL. Nothing to add, and adding it would be wrong.
  if (!link || link.endsWith('/')) return null
  const base = link.startsWith('/') ? '/' : path.posix.dirname(`/${from}`)
  return path.posix.normalize(path.posix.join(base, link)).replace(/^\/+/, '')
}

/** Every `<a href=…>` in a hast tree. No dependency on unist-util-visit. */
function visitAnchors(node, visitor) {
  if (!node || typeof node !== 'object') return
  if (node.tagName === 'a' && typeof node.properties?.href === 'string') visitor(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) visitAnchors(child, visitor)
  }
}

export const AwtFolderNotes = (userOptions) => {
  const options = {...DEFAULTS, ...userOptions}

  /**
   * slug → address, for the notes whose address is not their slug.
   *
   * Read once per plugin instance — once per worker thread above 128 files, where
   * Quartz parses in a pool and hands each worker a structured clone that nothing
   * written here would survive.
   */
  let moves = null
  const rewrites = () => {
    if (moves) return moves
    moves = new Map()
    const file = path.isAbsolute(options.index)
      ? options.index
      : path.resolve(process.cwd(), options.indexBase, options.index)

    let artifact
    try {
      artifact = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      // Silent, and deliberately so: `awt-links` already refuses to build without
      // an index, and two plugins shouting about one missing file is noise. If
      // the shadow is off as well, no page moves and the site is what Quartz
      // alone would have made of it.
      return moves
    }

    for (const [slug, page] of Object.entries(artifact.pages ?? {})) {
      if (page?.address && page.address !== slug) moves.set(slug, page.address)
    }
    return moves
  }

  return {
    name: 'AwtFolderNotes',

    markdownPlugins() {
      const moved = rewrites()
      if (moved.size === 0) return []
      return [
        () => (_tree, file) => {
          const address = moved.get(file?.data?.slug)
          if (address) file.data.slug = address
        },
      ]
    },

    htmlPlugins() {
      const moved = rewrites()
      if (moved.size === 0) return []
      return [
        () => (tree, file) => {
          const from = file?.data?.slug
          if (!from) return
          visitAnchors(tree, (node) => {
            const landed = resolveHref(from, String(node.properties.href))
            if (landed === null || !moved.has(landed)) return
            // A link CrawlLinks could not resolve is a placeholder, and a
            // placeholder is the backlog signal rather than a URL to repair.
            const classes = [].concat(node.properties.className ?? [])
            if (classes.includes('broken')) return
            const [link, anchor = ''] = String(node.properties.href).split(/(#.*)$/)
            node.properties.href = `${link}/${anchor}`
          })
        },
      ]
    },
  }
}

export default AwtFolderNotes

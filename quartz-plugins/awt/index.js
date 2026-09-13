/**
 * awt — the toolbox inside a Quartz build. One plugin, both a transformer and an
 * emitter, and everything it does comes from reading the toolbox's index as data.
 *
 * It replaced four plugins that read the same file the same way, and were wired
 * into every project separately: a change to any of them meant a change to every
 * wiki's config. Now the toolbox writes the one entry that names this package
 * into the config it derives for a build, and a project's own files say nothing
 * about it. Quartz allows the merge outright: `quartz.category` may be a list,
 * the loader puts the package into each matching bucket and calls the default
 * factory once per bucket, and checks only that the instance *has* the methods
 * that bucket needs. So two instances of this exist during a build, one asked
 * for `markdownPlugins`/`htmlPlugins` and one for `emit`, and each reads the
 * index for itself. That is cheap, and it is also the only correct shape: above
 * 128 files Quartz parses in a worker pool and hands each worker a structured
 * clone, so nothing shared between instances would survive anyway.
 *
 * THE INDEX IS READ, NEVER RECOMPUTED. Every fact below — a note's address, the
 * headings on a page, what a link resolves to — is decided in `core` and carried
 * in `.awt-index.json`. Recomputing any of it here would be a second
 * implementation free to disagree, and the failure mode is a link that renders and
 * points somewhere wrong. `awt site serve` and `awt site publish` emit the index
 * immediately before the build; a build started any other way has to run
 * `awt site index` first.
 *
 * A MISSING INDEX IS AN ERROR, ONE POLICY, EVERYWHERE. Four plugins had three
 * answers to that file being absent — refuse, warn, stay silent — and the reasoning
 * for the silent one held only while all four were enabled together, which two of
 * the four wikis on the machine this was written on were not. Comparing against a
 * stale index is the same error: it reports disagreements that are not real and
 * hides ones that are. The staleness check runs once, in the emitter, where the
 * whole tree is in view.
 *
 * ZERO DEPENDENCIES. Quartz symlinks a local plugin directory into
 * `.quartz/plugins/` and imports it from there, so a bare specifier would have to
 * resolve from outside the Quartz tree. `fs` and `path` are the whole import list,
 * and the cross-wiki reference grammar is restated rather than imported from
 * `syntax`; `packages/publish/test/cross-wiki-agreement.test.js` holds the two
 * together.
 *
 * WHAT EACH HALF DOES
 *
 * Transformer, markdown pass:
 *   - Folder notes. A note beside a folder of its own name is that folder's
 *     landing page, at the address the index gives it. `file.data.slug` moves so
 *     emitters write the page there, FolderPage sees the folder already has a
 *     landing page, and the navigation trie carries the note's title with its
 *     address. `ctx.allSlugs` does NOT move: CrawlLinks matches link text against
 *     the last segment of each slug, and a moved entry's last segment is `index`.
 *   - Cross-wiki references. `[text](prefix:path.md#anchor)` becomes the URL the
 *     target wiki actually serves, read from that wiki's own `contentIndex.json`
 *     and never computed. Mode comes from the build itself (`ctx.argv.serve`):
 *     a dev server links to registry `dev` bases, a publish build to `published`
 *     ones. Everything unresolvable is a warning, never a failure, because a wiki
 *     has to build before the wikis it depends on have ever been built.
 *
 * Transformer, html pass:
 *   - The second half of folder notes. CrawlLinks resolves to the slug it matched,
 *     so a link to a moved note comes out one segment too shallow; a host trying
 *     `$uri/index.html` still finds the page and then serves it under a URL from
 *     which every relative asset resolves against the parent folder. The trailing
 *     slash goes back on the finished href, whatever link syntax produced it. This
 *     has to be an html pass: Quartz runs every transformer's markdown pass over
 *     every file before any html pass runs, so the slug is settled site-wide by
 *     the time the first href is read. It must run after CrawlLinks, which is
 *     what the order the toolbox writes (61, above crawl-links' 60) is for.
 *
 * Emitter:
 *   - `static/awtHeadings.json`: every published page's heading anchors, keyed by
 *     served address beside the file path, mirroring `contentIndex.json` so a
 *     consumer reads both the same way. It is what lets another wiki check a
 *     cross-wiki reference that carries an anchor.
 *   - The shadow (toolbox-decisions 10). Two resolvers currently compute where
 *     every link goes — Quartz's `crawl-links` at the hast layer, the toolbox's at
 *     the source layer — and this compares them page by page and fails the build
 *     when they disagree. The point is not that ours is right: it is that the
 *     incumbent validates the replacement across real edits and real Quartz bumps
 *     before anything is switched off. It is an emitter so the report covers the
 *     whole wiki rather than dying on the first page. `shadow: false` is the
 *     resolver switch, when its gate is met; the check goes and nothing else moves.
 */
import fs from 'fs'
import path from 'path'

const DEFAULTS = {
  index: './.awt-index.json',
  self: null,
  registry: {},
  shadow: true,
  headings: 'static/awtHeadings.json',
  warnOnUnknownPrefix: true,
  warnOnMissingIndex: true,
  warnOnMissingPath: true,
  warnOnMissingAnchor: true,
}

// ------------------------------------------------------------------ the index

/**
 * Where the site root is: the directory the config Quartz is reading actually
 * lives in, found by following the symlink Quartz's working directory always
 * holds. `<site>/…config.yaml` is the site root by definition, so this needs no
 * configured depth and cannot drift when the depth does — which it did once, when
 * Quartz moved from `site/.quartz-src` to `site/node_modules/quartz`.
 *
 * With no symlink there is no site root to find, and saying so is the useful
 * error: falling back to Quartz's own directory produced a "no index at
 * node_modules/quartz/.awt-index.json" that named a file nobody ever had.
 */
function siteRoot(cwd = process.cwd()) {
  const link = path.join(cwd, 'quartz.config.yaml')
  try {
    return path.dirname(fs.realpathSync(link))
  } catch {
    throw new Error(
      `awt: ${link} is not a link into the site directory, so the site root cannot be found.\n` +
        '  Build with `awt site serve` or `awt site publish`, which wire it, or run `awt site setup`.',
    )
  }
}

function indexPath(options) {
  return path.isAbsolute(options.index) ? options.index : path.resolve(siteRoot(), options.index)
}

/** The index, parsed, or a thrown error that says how to get one. */
function readArtifact(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    throw new Error(
      `awt: no index at ${file}, so nothing here can run.\n` +
        '  Build with `awt site serve` or `awt site publish`, which emit it first, or run\n' +
        `  \`awt site index\` immediately before the build.`,
    )
  }
}

/**
 * The newest mtime among the wiki's notes, or `null` when the tree cannot be read
 * — an index emitted on another machine, which is a reason to say so rather than
 * to fail.
 */
function newestNote(root) {
  let newest = null
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true})
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.toLowerCase().endsWith('.md')) {
        const {mtimeMs} = fs.statSync(full)
        if (newest === null || mtimeMs > newest) newest = mtimeMs
      }
    }
  }
  walk(root)
  return newest
}

// ------------------------------------------------------------ folder notes

/** slug → address, for the notes whose address is not their slug. */
function movesIn(artifact) {
  const moves = new Map()
  for (const [slug, page] of Object.entries(artifact.pages ?? {})) {
    if (page?.address && page.address !== slug) moves.set(slug, page.address)
  }
  return moves
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
export function resolveHref(from, href) {
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

function classesOf(node) {
  const classes = node.properties?.className
  if (Array.isArray(classes)) return classes
  if (typeof classes === 'string') return classes.split(/\s+/)
  return []
}

// ---------------------------------------------------------- cross-wiki links

/**
 * `prefix:some/path.md#anchor`.
 *
 * This grammar is `packages/syntax/lib/cross-wiki.js`'s, restated rather than
 * imported. The two used to differ — a prefix carrying an uppercase letter, a `.`
 * or a `+` was a cross-wiki reference to the toolbox and an ordinary link to the
 * renderer — which is a link excluded from the graph and never resolved in the
 * site, reported by neither. Change one, change the other; the agreement test
 * fails when they part company.
 */
const REFERENCE = /^([A-Za-z][A-Za-z0-9+.-]*):(?!\/\/)(\S+)$/

/** Schemes that are never registry keys, whatever the registry says. */
const RESERVED = new Set([
  'about',
  'blob',
  'data',
  'file',
  'ftp',
  'http',
  'https',
  'javascript',
  'mailto',
  'sms',
  'tel',
  'urn',
])

/**
 * `{prefix, target, anchor}` for a cross-wiki destination, or `null`. `anchor`
 * keeps its `#`, because all anything here does is append it to a resolved URL.
 */
export function parseReference(url) {
  const match = REFERENCE.exec(url ?? '')
  if (!match) return null

  const [, prefix, rest] = match
  if (RESERVED.has(prefix.toLowerCase())) return null

  const hash = rest.indexOf('#')
  const target = hash === -1 ? rest : rest.slice(0, hash)
  if (!target) return null

  return {prefix, target, anchor: hash === -1 ? '' : rest.slice(hash)}
}

function slugifyFallback(filePath) {
  // Only reached when the target's index is unavailable. Deliberately crude:
  // it is a guess, and the warning beside it says so.
  return filePath.replace(/\.md$/, '').replace(/\/index$/, '')
}

function joinUrl(base, slug) {
  return `${base.replace(/\/+$/, '')}/${slug.replace(/^\/+/, '')}`
}

/**
 * The heading anchors a wiki built with this plugin publishes beside its
 * `contentIndex.json`, keyed by slug, so `prefix:path.md#anchor` can be checked
 * against a real heading.
 */
function readHeadings(contentIndex) {
  const file = path.join(path.dirname(contentIndex), 'awtHeadings.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const bySlug = new Map()
  for (const [slug, entry] of Object.entries(raw)) {
    if (Array.isArray(entry?.headings)) bySlug.set(slug, new Set(entry.headings))
  }
  return bySlug
}

/** contentIndex.json is keyed by slug; the lookup needs the reverse. */
function readContentIndex(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const byFilePath = new Map()
  for (const entry of Object.values(raw)) {
    if (entry && typeof entry.filePath === 'string' && typeof entry.slug === 'string') {
      byFilePath.set(entry.filePath, entry.slug)
    }
  }
  return byFilePath
}

/** filePath → slug for the wiki being built, from ctx. */
function selfIndex(ctx) {
  const files = ctx.allFiles ?? []
  const slugs = ctx.allSlugs ?? []
  const map = new Map()
  if (files.length !== slugs.length) return map
  for (let i = 0; i < files.length; i++) map.set(files[i], slugs[i])
  return map
}

function walkLinks(node, visit) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'link') visit(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkLinks(child, visit)
  }
}

/** The cross-wiki rewriter over one build, with its per-build caches. */
function crossWikiPass(ctx, options) {
  const serving = Boolean(ctx?.argv?.serve)

  // `null` means "already tried and failed" — a missing index warns once, not
  // once per reference.
  const indexes = new Map()
  const headings = new Map()
  const warnedPrefixes = new Set()
  let self = null

  // Relative to the site root, like the config file the registry used to sit in.
  // Resolved lazily: an absolute path needs no site root, and a test has none.
  const contentIndexOf = (entry) => {
    const rel = serving ? entry.buildIndex : entry.publishedIndex
    if (!rel) return null
    return path.isAbsolute(rel) ? rel : path.resolve(siteRoot(), rel)
  }

  const targetIndex = (prefix, entry) => {
    if (indexes.has(prefix)) return indexes.get(prefix)
    const abs = contentIndexOf(entry)
    let loaded = null
    if (!abs) {
      if (options.warnOnMissingIndex) {
        console.warn(
          `⚠ awt: no ${serving ? 'buildIndex' : 'publishedIndex'} configured for "${prefix}"; slugs will be guessed`,
        )
      }
    } else {
      try {
        loaded = readContentIndex(abs)
      } catch {
        if (options.warnOnMissingIndex) {
          console.warn(
            `⚠ awt: cannot read ${prefix}'s content index at ${abs}; slugs will be guessed. Build that wiki to fix this.`,
          )
        }
      }
    }
    indexes.set(prefix, loaded)
    return loaded
  }

  /**
   * The target wiki's published heading anchors, or `null` when it publishes
   * none. Silence is the right answer there: a wiki built without this plugin
   * has not said its anchors are unknown, it has said nothing, and warning about
   * every anchor into it would drown the ones that mean something.
   */
  const targetHeadings = (prefix, entry) => {
    if (headings.has(prefix)) return headings.get(prefix)
    const abs = contentIndexOf(entry)
    let loaded = null
    if (abs) {
      try {
        loaded = readHeadings(abs)
      } catch {
        loaded = null
      }
    }
    headings.set(prefix, loaded)
    return loaded
  }

  return (tree, file) => {
    const where = file?.data?.filePath ?? file?.path ?? '?'

    walkLinks(tree, (node) => {
      const reference = parseReference(node.url)
      if (!reference) return

      const {prefix, target, anchor} = reference
      const entry = options.registry[prefix]
      if (!entry) {
        if (options.warnOnUnknownPrefix && !warnedPrefixes.has(prefix)) {
          warnedPrefixes.add(prefix)
          console.warn(`⚠ awt: unknown wiki prefix "${prefix}" (first seen in ${where}); left as written`)
        }
        return
      }

      // A reference naming the wiki being built becomes an ordinary internal
      // link, so it keeps hover previews and backlinks instead of bouncing the
      // reader out to their own site.
      if (prefix === options.self) {
        self ??= selfIndex(ctx)
        const slug = self.get(target) ?? slugifyFallback(target)
        node.url = `/${slug}${anchor}`
        return
      }

      const baseUrl = serving ? entry.dev : entry.published
      if (!baseUrl) {
        if (options.warnOnUnknownPrefix) {
          console.warn(
            `⚠ awt: "${prefix}" has no ${serving ? 'dev' : 'published'} base URL; left as written (${where})`,
          )
        }
        return
      }

      const index = targetIndex(prefix, entry)
      let slug = index?.get(target)
      if (slug === undefined) {
        if (index && options.warnOnMissingPath) {
          console.warn(`⚠ awt: ${prefix}:${target} is not a page ${prefix} serves (referenced in ${where})`)
        }
        slug = slugifyFallback(target)
      } else if (anchor && options.warnOnMissingAnchor) {
        // A warning and never a failure: the target wiki may not have been
        // rebuilt since the heading was written.
        const anchors = targetHeadings(prefix, entry)?.get(slug)
        if (anchors && !anchors.has(anchor.slice(1))) {
          console.warn(
            `⚠ awt: ${prefix}:${target} has no heading "${anchor}" (referenced in ${where}); ` +
              'the link lands on the page, not the place',
          )
        }
      }

      node.url = joinUrl(baseUrl, slug) + anchor
    })
  }
}

// ----------------------------------------------------------------- the shadow

function eachElement(node, visitor) {
  if (node.type === 'element') visitor(node)
  for (const child of node.children ?? []) eachElement(child, visitor)
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort()
}

/**
 * Compare what Quartz rendered against what the index says, page by page.
 * Returns the report lines, empty when the resolvers agree.
 */
function shadowReport(artifact, content) {
  // Keyed by the address a page is *served* at, which is not always its slug:
  // the folder-note move above changes `vfile.data.slug` before an emitter sees
  // it, and looking pages up by slug alone dropped every moved note out of the
  // comparison — silently, and without counting it.
  const byAddress = new Map()
  for (const [slug, page] of Object.entries(artifact.pages ?? {})) {
    byAddress.set(page.address ?? slug, page)
  }

  const disagreements = []
  let compared = 0

  for (const [tree, vfile] of content) {
    const slug = vfile.data?.slug
    const page = byAddress.get(slug)
    // Tag pages, folder pages and the 404 are Quartz's own, not notes.
    if (!page) continue
    compared++

    const rendered = new Set()
    const renderedBroken = new Set()
    eachElement(tree, (node) => {
      if (node.tagName !== 'a') return
      const destination = node.properties?.['data-slug']
      if (typeof destination !== 'string') return // external, or an in-page anchor
      if (classesOf(node).includes('broken')) renderedBroken.add(destination)
      else rendered.add(destination)
    })

    const ours = new Set(page.links)
    const oursBroken = new Set(page.unresolved)

    // An ambiguous link is where the two resolvers differ by design, so whatever
    // Quartz did with it is not drift. awt reports two matches as an error at
    // edit time; Quartz resolves only on a unique match and otherwise falls
    // through *silently* to a root-relative slug — usually a 404, occasionally a
    // real page. The shadow cannot predict which, so it excludes the landing slug
    // from the comparison in both directions. `awt check` is what reports these.
    const undecided = new Set(page.ambiguousSlugs ?? [])
    const without = (slugs) => slugs.filter((value) => !undecided.has(value))

    const row = {
      slug,
      missing: difference(ours, rendered),
      extra: without(difference(rendered, ours)),
      brokenMissing: difference(oursBroken, renderedBroken),
      brokenExtra: without(difference(renderedBroken, oursBroken)),
    }
    if (row.missing.length || row.extra.length || row.brokenMissing.length || row.brokenExtra.length) {
      disagreements.push(row)
    }
  }

  return {compared, disagreements}
}

function formatDisagreements(rows) {
  return rows
    .map((row) => {
      const parts = []
      if (row.missing.length) parts.push(`    ours resolves, quartz does not: ${row.missing.join(', ')}`)
      if (row.extra.length) parts.push(`    quartz resolves, ours does not: ${row.extra.join(', ')}`)
      if (row.brokenMissing.length) parts.push(`    ours calls unresolved: ${row.brokenMissing.join(', ')}`)
      if (row.brokenExtra.length) parts.push(`    quartz calls broken: ${row.brokenExtra.join(', ')}`)
      return `  ${row.slug}\n${parts.join('\n')}`
    })
    .join('\n')
}

// ----------------------------------------------------------------- the plugin

export const Awt = (userOptions) => {
  const options = {...DEFAULTS, ...userOptions}

  // Read once per instance. Two instances exist per build (one per category
  // bucket) and one per worker thread besides; each reads for itself.
  let artifact = null
  const index = () => (artifact ??= readArtifact(indexPath(options)))

  return {
    name: 'Awt',

    markdownPlugins(ctx) {
      const moved = movesIn(index())
      const crossWiki = crossWikiPass(ctx, options)
      return [
        () => (tree, file) => {
          const address = moved.get(file?.data?.slug)
          if (address) file.data.slug = address
          crossWiki(tree, file)
        },
      ]
    },

    htmlPlugins() {
      const moved = movesIn(index())
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
            if (classesOf(node).includes('broken')) return
            const [link, anchor = ''] = String(node.properties.href).split(/(#.*)$/)
            node.properties.href = `${link}/${anchor}`
          })
        },
      ]
    },

    async emit(ctx, content) {
      const file = indexPath(options)
      const data = index()

      // Stale is as wrong as missing, and this is the one place the whole tree is
      // in view to say so.
      const newest = data.notesDir ? newestNote(data.notesDir) : null
      if (newest === null) {
        console.warn(`⚠ awt: cannot read ${data.notesDir} to tell whether ${file} is current; continuing anyway.`)
      } else if (newest > fs.statSync(file).mtimeMs) {
        throw new Error(
          `awt: ${file} is older than the newest note in ${data.notesDir}.\n` +
            '  A stale index moves pages to old addresses and reports disagreements that are not real.\n' +
            '  Build with `awt site serve` or `awt site publish`, which emit it first.',
        )
      }

      const emitted = []

      // Only pages that actually got built: a note excluded from publishing has
      // no anchors anyone can link to. Keyed by served address, so a moved note
      // is found, and so the key means what contentIndex.json's key means.
      if (options.headings) {
        const published = new Set(content.map(([, vfile]) => vfile.data?.slug).filter(Boolean))
        const headings = {}
        for (const [slug, page] of Object.entries(data.pages ?? {})) {
          const address = page.address ?? slug
          if (!published.has(address)) continue
          headings[address] = {filePath: page.path, headings: page.headings ?? []}
        }
        const out = path.join(ctx.argv.output, options.headings)
        fs.mkdirSync(path.dirname(out), {recursive: true})
        fs.writeFileSync(out, JSON.stringify(headings))
        console.log(`✓ awt: ${Object.keys(headings).length} pages' headings in ${options.headings}`)
        emitted.push(out)
      }

      if (options.shadow) {
        const {compared, disagreements} = shadowReport(data, content)
        if (disagreements.length) {
          throw new Error(
            `awt: the two resolvers disagree on ${disagreements.length} of ${compared} pages\n` +
              formatDisagreements(disagreements),
          )
        }
        console.log(`✓ awt: both resolvers agree on all ${compared} pages`)
      }

      return emitted
    },
  }
}

export default Awt

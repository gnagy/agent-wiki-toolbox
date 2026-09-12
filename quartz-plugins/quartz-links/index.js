/**
 * awt-links: the shadow comparison between two link resolvers.
 *
 * Two resolvers currently compute where every link in this wiki goes: Quartz's
 * `crawl-links`, at the hast layer after `[[wikilinks]]` have already become `<a>`
 * elements, and the toolbox's, at the source layer. **This compares them page by
 * page and fails the build when they disagree.**
 *
 * The point is not that ours is right. It is that the incumbent gets to validate
 * the replacement across real edits and real Quartz bumps before anything is
 * switched off — the on-demand check that `awt check` performs becomes one
 * that runs on every build. **Do not read a clean first run as a result**: what
 * this is here to catch is Quartz's slug semantics moving under us, and that only
 * happens when the pinned SHA moves.
 *
 * It is an **emitter**, not a transformer, for one reason: an emitter runs once
 * with every page already transformed, so the report covers the whole wiki instead
 * of dying on the first page that disagrees. It emits no files.
 *
 * **Zero dependencies, deliberately.** Quartz symlinks a local plugin directory
 * into `.quartz/plugins/`, so anything imported here would have to resolve from
 * outside the Quartz tree. It reads the toolbox index as an artifact instead.
 *
 * **A missing or stale index is an error, not a shrug.** Comparing against an
 * artifact one edit out of date is worse than not comparing: it reports a
 * disagreement that is not real, and hides one that is. This used to warn and
 * return `[]`, so a build with no index went green while the check this plugin
 * exists for had not run. `awt site publish` and `awt site serve` emit the index
 * immediately before the build; anything else has to run `awt site index --out` first.
 */
import fs from 'fs'
import path from 'path'

const DEFAULTS = {
  index: './.awt-index.json',
  failOnDisagreement: true,
}

/**
 * Where quartz.config.yaml actually lives — found by following the symlink
 * Quartz's working directory always holds one of, rather than assuming how
 * many directories separate that cwd from the site root. `site/quartz.config.yaml`
 * is the site root by definition, so this needs no configured depth and cannot
 * drift when the depth does — which it did once, when Quartz moved from
 * `site/.quartz-src` to `site/node_modules/quartz`.
 */
function siteRoot(cwd = process.cwd()) {
  try {
    return path.dirname(fs.realpathSync(path.join(cwd, 'quartz.config.yaml')))
  } catch {
    return cwd
  }
}

function classesOf(node) {
  const classes = node.properties?.className
  if (Array.isArray(classes)) return classes
  if (typeof classes === 'string') return classes.split(/\s+/)
  return []
}

/**
 * Walk a hast tree without `unist-util-visit`, which we may not import. One page
 * per call, so a plain recursion is the whole cost.
 */
function eachElement(node, visitor) {
  if (node.type === 'element') visitor(node)
  for (const child of node.children ?? []) eachElement(child, visitor)
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort()
}

/**
 * The newest mtime among the wiki's notes, or `null` when the tree cannot be read
 * — an index emitted on another machine, which is a reason to say so rather than
 * to fail. `fs` only: nothing may be imported here.
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

export const AwtLinks = (userOptions) => {
  const options = {...DEFAULTS, ...userOptions}

  return {
    name: 'AwtLinks',

    async emit(ctx, content) {
      const file = path.isAbsolute(options.index)
        ? options.index
        : path.resolve(siteRoot(), options.index)

      // One switch decides whether this build is allowed to fail on what the
      // plugin finds, and a check that did not run is one of those things.
      const refuse = (message) => {
        if (options.failOnDisagreement) throw new Error(`awt-links: ${message}`)
        console.warn(`⚠ awt-links: ${message}`)
      }

      let artifact
      let emitted
      try {
        emitted = fs.statSync(file).mtimeMs
        artifact = JSON.parse(fs.readFileSync(file, 'utf-8'))
      } catch {
        refuse(
          `no index at ${file}, so the comparison this plugin exists for did not run.\n` +
            '  Build with `awt site serve` or `awt site publish`, which emit it first, or run\n' +
            `  \`awt site index -w <wiki> --out ${file}\` immediately before the build.`,
        )
        return []
      }

      const newest = artifact.notesDir ? newestNote(artifact.notesDir) : null
      if (newest === null) {
        console.warn(
          `⚠ awt-links: cannot read ${artifact.notesDir} to tell whether ${file} is current; comparing anyway.`,
        )
      } else if (newest > emitted) {
        refuse(
          `${file} is older than the newest note in ${artifact.notesDir}.\n` +
            '  Comparing against a stale index reports disagreements that are not real and\n' +
            '  hides ones that are. Build with `awt site serve` or `awt site publish`.',
        )
        return []
      }

      // Keyed by the address a page is *served* at, which is not always its slug:
      // `awt-folder-notes` moves a note beside a folder of its own name onto that
      // folder's landing page, and `vfile.data.slug` is the moved one by the time
      // an emitter sees it. Looking pages up by slug alone dropped every moved
      // note out of the comparison — silently, and without counting it.
      const byAddress = new Map()
      for (const [slug, page] of Object.entries(artifact.pages ?? {})) {
        byAddress.set(page.address ?? slug, page)
      }

      const disagreements = []
      let compared = 0

      for (const [tree, vfile] of content) {
        const slug = vfile.data?.slug
        const page = byAddress.get(slug)
        if (!page) {
          // Tag pages, folder pages and the 404 are Quartz's own, not notes.
          continue
        }
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

        // An ambiguous link is where the two resolvers differ by design, so
        // whatever Quartz did with it is not drift. awt reports two matches as an
        // error at edit time; Quartz resolves only on a
        // unique match and otherwise falls through *silently* to a root-relative
        // slug — usually a 404, and occasionally a real page, which is what
        // `[[README]]` does in a wiki holding four of them. The shadow cannot
        // predict which, so it excludes the landing slug from the comparison in
        // both directions rather than guessing. `awt check` is what reports these.
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

      if (disagreements.length === 0) {
        console.log(`✓ awt-links: both resolvers agree on all ${compared} pages`)
        return []
      }

      const report = disagreements
        .map((row) => {
          const parts = []
          if (row.missing.length) parts.push(`    ours resolves, quartz does not: ${row.missing.join(', ')}`)
          if (row.extra.length) parts.push(`    quartz resolves, ours does not: ${row.extra.join(', ')}`)
          if (row.brokenMissing.length) parts.push(`    ours calls unresolved: ${row.brokenMissing.join(', ')}`)
          if (row.brokenExtra.length) parts.push(`    quartz calls broken: ${row.brokenExtra.join(', ')}`)
          return `  ${row.slug}\n${parts.join('\n')}`
        })
        .join('\n')

      const message = `awt-links: the two resolvers disagree on ${disagreements.length} of ${compared} pages\n${report}`
      if (options.failOnDisagreement) throw new Error(message)
      console.warn(`⚠ ${message}`)
      return []
    },
  }
}

export default AwtLinks

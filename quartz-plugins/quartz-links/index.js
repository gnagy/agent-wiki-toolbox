/**
 * awt-links — the shadow half of toolbox decision 10.
 *
 * Two resolvers currently compute where every link in this wiki goes: Quartz's
 * `crawl-links`, at the hast layer after `[[wikilinks]]` have already become `<a>`
 * elements, and the toolbox's, at the source layer. **This compares them page by
 * page and fails the build when they disagree.**
 *
 * The point is not that ours is right. It is that the incumbent gets to validate
 * the replacement across real edits and real Quartz bumps before anything is
 * switched off — the on-demand check that `check-link-graph` performs becomes one
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
 * outside the Quartz tree. It reads the toolbox index as an artifact instead —
 * emit that immediately before the build, or the comparison is against a stale
 * answer, which is worse than no comparison at all.
 */
import fs from 'fs'
import path from 'path'

const DEFAULTS = {
  index: './.awt-index.json',
  indexBase: '..',
  failOnDisagreement: true,
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

export const AwtLinks = (userOptions) => {
  const options = {...DEFAULTS, ...userOptions}

  return {
    name: 'AwtLinks',

    async emit(ctx, content) {
      const file = path.isAbsolute(options.index)
        ? options.index
        : path.resolve(process.cwd(), options.indexBase, options.index)

      let artifact
      try {
        artifact = JSON.parse(fs.readFileSync(file, 'utf-8'))
      } catch {
        console.warn(
          `⚠ awt-links: no index at ${file} — nothing to compare against. Run \`awt index\` before the build.`,
        )
        return []
      }

      const disagreements = []
      let compared = 0

      for (const [tree, vfile] of content) {
        const slug = vfile.data?.slug
        const page = artifact.pages?.[slug]
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
        // A link we call ambiguous is one Quartz cannot resolve either: it falls
        // through to a root-relative slug and marks it broken. Same outcome in the
        // site — named at the source instead of discovered by a reader, which is
        // the whole of what decision 7 buys.
        const oursBroken = new Set([...page.unresolved, ...page.ambiguous])

        const row = {
          slug,
          missing: difference(ours, rendered),
          extra: difference(rendered, ours),
          brokenMissing: difference(oursBroken, renderedBroken),
          brokenExtra: difference(renderedBroken, oursBroken),
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

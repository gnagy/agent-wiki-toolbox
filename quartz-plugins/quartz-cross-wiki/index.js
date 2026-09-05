/**
 * cross-wiki-links — a Quartz v5 transformer resolving prefixed cross-wiki
 * references at build time.
 *
 * A reference is an ordinary markdown link whose destination carries a wiki
 * prefix instead of a scheme:
 *
 *     See [conventions](platform:meta/conventions.md).
 *
 * Foam treats a destination with a scheme as external, so it never becomes a
 * placeholder; remark and mdfmt leave it alone; this transformer turns it into
 * the URL the target wiki actually serves.
 *
 * Design: docs/wiki/design/agent-wiki-toolbox/cross-wiki-link-resolution.md in the
 *         AiSandbox workspace wiki.
 *
 * Two rules the design insists on, both implemented here:
 *
 *   1. The slug is READ from the target wiki's own contentIndex.json, never
 *      computed. Recomputing another wiki's path rules is a second
 *      implementation free to drift, and it fails by rendering a link that
 *      points nowhere.
 *   2. Everything unresolvable is a WARNING, never a build failure. A wiki has
 *      to build before the wikis it depends on have ever been built, or nothing
 *      bootstraps.
 *
 * Mode comes from the build itself (`ctx.argv.serve`) — there is no flag to
 * forget, so a published site cannot end up full of localhost links.
 *
 * Zero dependencies on purpose: the plugin directory is symlinked into
 * `.quartz/plugins/`, so anything it imports has to resolve from outside the
 * Quartz tree.
 */

import fs from "fs"
import path from "path"

/**
 * `prefix:some/path.md#anchor`.
 *
 * This grammar is `packages/syntax/lib/cross-wiki.js`'s, restated rather than
 * imported: the plugin directory is symlinked into `.quartz/plugins/`, so nothing
 * here can resolve a bare specifier. The two used to differ — a prefix carrying an
 * uppercase letter, a `.` or a `+` was a cross-wiki reference to the toolbox and
 * an ordinary link to the renderer — which is a link excluded from the graph and
 * never resolved in the site, reported by neither.
 *
 * `packages/publish/test/cross-wiki-agreement.test.js` drives both over one corpus
 * and fails when they part company. Change one, change the other.
 */
const REFERENCE = /^([A-Za-z][A-Za-z0-9+.-]*):(?!\/\/)(\S+)$/

/** Schemes that are never registry keys, whatever the registry says. */
const RESERVED = new Set([
  "about",
  "blob",
  "data",
  "file",
  "ftp",
  "http",
  "https",
  "javascript",
  "mailto",
  "sms",
  "tel",
  "urn",
])

/**
 * `{prefix, target, anchor}` for a cross-wiki destination, or `null`. `anchor`
 * keeps its `#`, because everything here does is append it to a resolved URL.
 */
export function parseReference(url) {
  const match = REFERENCE.exec(url ?? "")
  if (!match) return null

  const [, prefix, rest] = match
  if (RESERVED.has(prefix.toLowerCase())) return null

  const hash = rest.indexOf("#")
  const target = hash === -1 ? rest : rest.slice(0, hash)
  if (!target) return null

  return { prefix, target, anchor: hash === -1 ? "" : rest.slice(hash) }
}

function slugifyFallback(filePath) {
  // Only reached when the target's index is unavailable. Deliberately crude:
  // it is a guess, and the warning beside it says so.
  const withoutExt = filePath.replace(/\.md$/, "")
  return withoutExt.replace(/\/index$/, "")
}

function joinUrl(base, slug) {
  return `${base.replace(/\/+$/, "")}/${slug.replace(/^\/+/, "")}`
}

/**
 * The heading anchors `awt-headings` publishes beside `contentIndex.json`, keyed
 * by slug. Read so that `prefix:path.md#anchor` can be checked against a real heading.
 */
function readHeadings(indexPath) {
  const file = path.join(path.dirname(indexPath), "awtHeadings.json")
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"))
  const bySlug = new Map()
  for (const [slug, entry] of Object.entries(raw)) {
    if (Array.isArray(entry?.headings)) bySlug.set(slug, new Set(entry.headings))
  }
  return bySlug
}

/**
 * contentIndex.json is keyed by slug; we need the reverse. Built once per
 * target per build.
 */
function readIndex(indexPath) {
  const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"))
  const byFilePath = new Map()
  for (const entry of Object.values(raw)) {
    if (entry && typeof entry.filePath === "string" && typeof entry.slug === "string") {
      byFilePath.set(entry.filePath, entry.slug)
    }
  }
  return byFilePath
}

/** filePath -> slug for the wiki currently being built, from ctx. */
function selfIndex(ctx) {
  const files = ctx.allFiles ?? []
  const slugs = ctx.allSlugs ?? []
  const map = new Map()
  if (files.length !== slugs.length) return map
  for (let i = 0; i < files.length; i++) {
    map.set(files[i], slugs[i])
  }
  return map
}

function walkLinks(node, visit) {
  if (!node || typeof node !== "object") return
  if (node.type === "link") visit(node)
  const children = node.children
  if (Array.isArray(children)) {
    for (const child of children) walkLinks(child, visit)
  }
}

export default function crossWikiLinks(userOpts) {
  const opts = {
    self: null,
    registry: {},
    // Index paths in the registry are resolved against this, itself resolved
    // against Quartz's working directory (`site/.quartz-src`). The default puts
    // the base at `site/`, where quartz.config.yaml lives — so a registry entry
    // reads the same way as the config file it sits in.
    indexBase: "..",
    warnOnUnknownPrefix: true,
    warnOnMissingIndex: true,
    warnOnMissingPath: true,
    warnOnMissingAnchor: true,
    ...(userOpts ?? {}),
  }

  return {
    name: "CrossWikiLinks",
    markdownPlugins(ctx) {
      const serving = Boolean(ctx?.argv?.serve)
      const base = path.resolve(process.cwd(), opts.indexBase)

      // Per-build caches. `null` means "already tried and failed" — the warning
      // for a missing index is emitted once, not once per reference.
      const indexes = new Map()
      const headings = new Map()
      const warnedPrefixes = new Set()
      let self = null

      const indexPath = (entry) => {
        const rel = serving ? entry.buildIndex : entry.publishedIndex
        return rel ? path.resolve(base, rel) : null
      }

      const targetIndex = (prefix, entry) => {
        if (indexes.has(prefix)) return indexes.get(prefix)
        const abs = indexPath(entry)
        let loaded = null
        if (!abs) {
          if (opts.warnOnMissingIndex) {
            console.warn(
              `⚠ cross-wiki-links: no ${serving ? "buildIndex" : "publishedIndex"} configured for "${prefix}"; slugs will be guessed`,
            )
          }
        } else {
          try {
            loaded = readIndex(abs)
          } catch {
            if (opts.warnOnMissingIndex) {
              console.warn(
                `⚠ cross-wiki-links: cannot read ${prefix}'s content index at ${abs}; ` +
                  `slugs will be guessed. Build that wiki to fix this.`,
              )
            }
          }
        }
        indexes.set(prefix, loaded)
        return loaded
      }

      /**
       * The target wiki's published heading anchors, or `null` when it publishes
       * none. **Silence is the right answer there**: a wiki not built with
       * `awt-headings` has not said its anchors are unknown, it has said nothing,
       * and warning about every anchor into it would drown the ones that mean
       * something.
       */
      const targetHeadings = (prefix, entry) => {
        if (headings.has(prefix)) return headings.get(prefix)
        const abs = indexPath(entry)
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

      return [
        () => (tree, file) => {
          const where = file?.data?.filePath ?? file?.path ?? "?"

          walkLinks(tree, (node) => {
            const reference = parseReference(node.url)
            if (!reference) return

            const { prefix, target, anchor } = reference
            const entry = opts.registry[prefix]
            if (!entry) {
              if (opts.warnOnUnknownPrefix && !warnedPrefixes.has(prefix)) {
                warnedPrefixes.add(prefix)
                console.warn(
                  `⚠ cross-wiki-links: unknown wiki prefix "${prefix}" (first seen in ${where}); left as written`,
                )
              }
              return
            }

            // A reference naming the wiki being built becomes an ordinary
            // internal link, so it keeps hover previews and backlinks instead
            // of bouncing the reader out to their own site.
            if (prefix === opts.self) {
              self ??= selfIndex(ctx)
              const slug = self.get(target) ?? slugifyFallback(target)
              node.url = `/${slug}${anchor}`
              return
            }

            const baseUrl = serving ? entry.dev : entry.published
            if (!baseUrl) {
              if (opts.warnOnUnknownPrefix) {
                console.warn(
                  `⚠ cross-wiki-links: "${prefix}" has no ${serving ? "dev" : "published"} base URL; left as written (${where})`,
                )
              }
              return
            }

            const index = targetIndex(prefix, entry)
            let slug = index?.get(target)
            if (slug === undefined) {
              if (index && opts.warnOnMissingPath) {
                console.warn(
                  `⚠ cross-wiki-links: ${prefix}:${target} is not a page ${prefix} serves (referenced in ${where})`,
                )
              }
              slug = slugifyFallback(target)
            } else if (anchor && opts.warnOnMissingAnchor) {
              // A warning and never a failure, by rule 2 above: the target wiki
              // may not have been rebuilt since the heading was written.
              const anchors = targetHeadings(prefix, entry)?.get(slug)
              if (anchors && !anchors.has(anchor.slice(1))) {
                console.warn(
                  `⚠ cross-wiki-links: ${prefix}:${target} has no heading "${anchor}" ` +
                    `(referenced in ${where}); the link lands on the page, not the place`,
                )
              }
            }

            node.url = joinUrl(baseUrl, slug) + anchor
          })
        },
      ]
    },
  }
}

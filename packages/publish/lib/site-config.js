/**
 * The Quartz config a build reads, derived rather than tracked.
 *
 * Quartz reads `<cwd>/quartz.config.yaml` and nothing else — no `--config` flag,
 * no variable expansion — and every wiki's file was Quartz's own shipped default
 * plus the same handful of changes, copied per project. Four of them were diffed
 * with the comments stripped: 328 lines each, and what differed was the title,
 * a base URL derived from a port the project already declares, the wiki's own
 * prefix and registry, which of the toolbox's plugins were on, a properties list
 * and the footer. Everything else was identical because it has to match the
 * pinned commit, and the pin is one for every wiki (wiki-publishing-decisions
 * 20 in the AiSandbox workspace wiki). A config that must match a shared pin is
 * shared by the same argument; copying it four times was drift waiting to happen,
 * and a change inside the toolbox's plugins meant editing every wiki's file.
 *
 * So the toolbox owns the file. Before every build:
 *
 *   1. The base is `quartz.config.default.yaml` from the pinned Quartz install,
 *      so a pin bump that renames a community plugin or changes a manifest is
 *      absorbed here once, not once per wiki.
 *   2. The toolbox's own changes go on: analytics off, `crawl-links` marking
 *      unresolved wikilinks (the shadow and the handoff copy both read that
 *      mark), `og-image` off (most of a build's weight, for a preview card no
 *      wiki here needs), and the one entry naming this toolbox's Quartz plugin
 *      by absolute path into the install, at the order its html pass needs.
 *   3. The project's declaration goes on last — `site` in `awt.config.mjs`:
 *
 *        site: {
 *          title: 'DIOS wiki',                // configuration.pageTitle
 *          self: 'shelton-dios',              // this wiki's own cross-wiki prefix
 *          registry: {                        // the other wikis it references
 *            'shelton-dios-data': {dev: 'http://localhost:8102', buildIndex: '../../x/site/public/static/contentIndex.json'},
 *          },
 *          baseUrl: 'wiki.example.org',       // the published host; localhost:<port> when serving
 *          properties: ['type', 'status'],    // front-matter fields shown on a page
 *          footer: {GitHub: 'https://…'},     // footer links
 *          plugins: [                         // extra Quartz plugins, passed through
 *            {source: './plugins/mine', options: {…}, order: 70},
 *          ],
 *        }
 *
 *      A `plugins` entry whose `source` matches one already in the config replaces
 *      that entry's fields; any other is appended. A local source is resolved
 *      against the project's root before it is written, because Quartz resolves a
 *      relative path against its own working directory under `node_modules`.
 *
 * The result is written to `<site>/.quartz.config.yaml`, gitignored, and the
 * symlink inside the Quartz install points at it. **A project that needs what
 * the declaration does not expose takes the file over**: a tracked
 * `<site>/quartz.config.yaml` replaces steps 1 and 2 wholesale, and only the
 * plugin entry is still injected from the declaration's `self` and `registry`.
 * That file may not carry the old `../awt-*` entries — they name symlinks
 * nothing writes any more — and a build refuses one that does, naming
 * `awt site migrate`.
 *
 * Parsed and written with the `yaml` inside the Quartz install, the same parser
 * Quartz reads the file with, so the two cannot disagree about what it says.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { loadFromQuartz } from "./quartz-deps.js"

/** The toolbox root: packages/publish/lib -> packages/publish -> packages -> root. */
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/** The plugin, by absolute path into this install; Quartz symlinks it from there. */
export const PLUGIN_SOURCE = path.join(HERE, "quartz-plugins", "awt")

/** What a build reads. Gitignored; rewritten before every build. */
export const DERIVED_CONFIG = ".quartz.config.yaml"
/** What a project may track to take the base over. */
export const PROJECT_CONFIG = "quartz.config.yaml"

/** The order the plugin's html pass needs: after crawl-links, which is 60. */
const PLUGIN_ORDER = 61

/** The keys a declaration may carry. Anything else is a typo worth one line. */
const DECLARATION_KEYS = ["title", "self", "registry", "baseUrl", "properties", "footer", "plugins"]

/** The `../awt-*` sources of the four plugins this one replaced. */
const OLD_SOURCES = /^\.\.\/awt-(links|cross-wiki|headings|folder-notes)$/

/**
 * Every plugin entry whose source matches, by the string form. Sources may be
 * objects (`{repo, subdir}`), which are compared by their repo.
 */
function sourceOf(entry) {
  const source = entry?.source
  return typeof source === "string" ? source : (source?.repo ?? "")
}

function findEntry(config, predicate) {
  return (config.plugins ?? []).find((entry) => predicate(sourceOf(entry)))
}

function endsWithName(name) {
  return (source) => source === `@quartz-community/${name}` || source.split("/").pop() === name
}

/**
 * The base config: the project's own file when it tracks one, else Quartz's
 * shipped default with the toolbox's changes applied.
 */
function baseConfig(site, quartz, parse, die) {
  const own = path.join(site, PROJECT_CONFIG)
  if (fs.existsSync(own)) {
    const config = parse(fs.readFileSync(own, "utf8")) ?? {}
    const stale = (config.plugins ?? []).filter((entry) => OLD_SOURCES.test(sourceOf(entry)))
    if (stale.length) {
      die(
        `${own} still names ${stale.map(sourceOf).join(", ")}.\n` +
          "Those were the toolbox's four Quartz plugins, wired into every project by symlinks\n" +
          "nothing writes any more; the toolbox now writes its own entry into the config it derives.\n" +
          "Run `awt site migrate` to move this project's own settings into awt.config.mjs.",
      )
    }
    return { config, own: true }
  }

  const shipped = path.join(quartz, "quartz.config.default.yaml")
  if (!fs.existsSync(shipped)) {
    die(`no ${shipped}; the Quartz install is missing its default config. Run \`awt site setup\`.`)
  }
  const config = parse(fs.readFileSync(shipped, "utf8")) ?? {}
  config.configuration ??= {}

  // The toolbox's own changes to Quartz's default. Each is what every wiki here
  // set by hand; the reason is beside each.
  config.configuration.analytics = { provider: null }

  // Unresolved wikilinks rendered with the `broken` class: the shadow reads it to
  // tell a placeholder from a disagreement, and the handoff copy to neutralise a
  // link rather than report it.
  const crawl = findEntry(config, endsWithName("crawl-links"))
  if (crawl) crawl.options = { ...(crawl.options ?? {}), disableBrokenWikilinks: true }

  // One webp per page, rendered on every build, for an unfurler no local wiki
  // ever meets. A published wiki that wants them declares the plugin back on.
  const og = findEntry(config, endsWithName("og-image"))
  if (og) og.enabled = false

  return { config, own: false }
}

/**
 * Where a declared local plugin source is, as Quartz will need it: absolute.
 * Quartz reads `./x` against its own cwd under `node_modules`, so a project
 * writing `./plugins/mine` means it against the project, and this is where that
 * meaning is preserved.
 */
function absoluteSource(source, projectDir) {
  const fix = (value) =>
    typeof value === "string" && (value.startsWith("./") || value.startsWith("../"))
      ? path.resolve(projectDir, value)
      : value
  if (typeof source === "string") return fix(source)
  if (source && typeof source === "object") return { ...source, repo: fix(source.repo) }
  return source
}

/**
 * The plugin entry the toolbox writes. `registry` gets the wiki's own entry
 * added when `self` is declared, since both halves of it are derivable: the dev
 * base is the port, the published base is the declared host, and both indexes
 * sit at fixed names under the site.
 */
function pluginEntry(declaration, { port, baseUrl }) {
  const registry = { ...(declaration.registry ?? {}) }
  if (declaration.self && !registry[declaration.self]) {
    registry[declaration.self] = {
      dev: `http://localhost:${port}`,
      buildIndex: "./public/static/contentIndex.json",
      ...(baseUrl ? { published: `https://${baseUrl}`, publishedIndex: "./release/static/contentIndex.json" } : {}),
    }
  }
  return {
    source: PLUGIN_SOURCE,
    enabled: true,
    order: PLUGIN_ORDER,
    options: {
      index: "./.awt-index.json",
      self: declaration.self ?? null,
      registry,
      shadow: true,
      headings: "static/awtHeadings.json",
    },
  }
}

/**
 * Derive the config for one build. Pure over its inputs apart from reading the
 * base; writing is `writeSiteConfig`'s.
 *
 *   declaration   the project's `site` object, or {}
 *   projectDir    where a declared relative plugin source is resolved from
 *   port          the dev server's port, for the localhost base URL
 *   serving       dev server (true) or publish build (false)
 *   warn          where a line about an unknown key goes
 */
export async function deriveSiteConfig(
  site,
  quartz,
  declaration = {},
  { projectDir = path.dirname(site), port, serving = true, die, warn = (m) => console.warn(m) } = {},
) {
  const { parse } = await loadFromQuartz(quartz, "yaml", die)

  for (const key of Object.keys(declaration)) {
    if (!DECLARATION_KEYS.includes(key)) {
      warn(`⚠ site.${key} in awt.config.mjs is not a key the site build reads; it was ignored.`)
    }
  }

  const { config, own } = baseConfig(site, quartz, parse, die)
  config.configuration ??= {}
  config.plugins ??= []

  const baseUrl = declaration.baseUrl ?? null
  if (!own) {
    config.configuration.pageTitle = declaration.title ?? "wiki"
    config.configuration.baseUrl = serving || !baseUrl ? `localhost:${port}` : baseUrl

    if (declaration.properties) {
      const props = findEntry(config, endsWithName("note-properties"))
      if (props) props.options = { ...(props.options ?? {}), includeAll: false, includedProperties: [...declaration.properties] }
    }
    if (declaration.footer) {
      const footer = findEntry(config, endsWithName("footer"))
      if (footer) footer.options = { ...(footer.options ?? {}), links: { ...declaration.footer } }
    }
  }

  // The toolbox's entry, whichever base was taken. A project file carrying one
  // already (a hand-wired install, say) keeps its own.
  if (!findEntry(config, (source) => source === PLUGIN_SOURCE || source.split("/").pop() === "awt")) {
    config.plugins.push(pluginEntry(declaration, { port, baseUrl }))
  }

  // Declared plugins: replace by source, else append.
  for (const declared of declaration.plugins ?? []) {
    if (!declared || typeof declared !== "object" || !declared.source) {
      warn(`⚠ site.plugins in awt.config.mjs holds an entry with no source; it was ignored.`)
      continue
    }
    const entry = { ...declared, source: absoluteSource(declared.source, projectDir) }
    const existing = findEntry(config, (source) => source === sourceOf(declared))
    if (existing) Object.assign(existing, entry, { source: existing.source })
    else config.plugins.push({ enabled: true, ...entry })
  }

  return { config, own, baseUrl }
}

/**
 * Write the derived config beside the project's site files and hand back its
 * name relative to the site, which is what the symlink inside the Quartz install
 * has to name.
 */
export async function writeSiteConfig(site, quartz, declaration, options = {}) {
  const derived = await deriveSiteConfig(site, quartz, declaration, options)
  const { stringify } = await loadFromQuartz(quartz, "yaml", options.die)
  const file = path.join(site, DERIVED_CONFIG)
  fs.writeFileSync(
    file,
    "# GENERATED by awt before every build. Do not edit: it is rewritten each time.\n" +
      (derived.own
        ? `# Base: this project's own ${PROJECT_CONFIG}, plus the toolbox's plugin entry.\n`
        : "# Base: quartz.config.default.yaml from the pinned Quartz install, plus the toolbox's\n" +
          "# changes and the `site` declaration in awt.config.mjs. To take the whole file over,\n" +
          `# copy it to ${PROJECT_CONFIG} beside this one and track it; awt then only injects its entry.\n`) +
      stringify(derived.config),
  )
  return { ...derived, file, name: DERIVED_CONFIG }
}

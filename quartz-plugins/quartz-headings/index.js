/**
 * awt-headings — publish each page's heading anchors, so a *cross-wiki* anchor
 * becomes checkable.
 *
 * `contentIndex.json` carries `filePath`, `slug`, `title` and `content`, but no
 * heading list, so `handbook:foo.md#a-heading` can be resolved to a page and never
 * to a place on it.
 *
 * The toolbox index carries headings, so publishing them beside
 * `contentIndex.json` costs one file. The
 * shape mirrors `contentIndex.json` deliberately: keyed by slug, with the file path
 * beside it, so a consumer that already reads one can read the other the same way.
 *
 * **Zero dependencies**, like the other two: a symlinked plugin directory cannot
 * resolve a bare specifier from outside the Quartz tree, so it reads the
 * materialised index as data.
 */
import fs from 'fs'
import path from 'path'

const DEFAULTS = {
  index: './.awt-index.json',
  outputPath: 'static/awtHeadings.json',
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

export const AwtHeadings = (userOptions) => {
  const options = {...DEFAULTS, ...userOptions}

  return {
    name: 'AwtHeadings',

    async emit(ctx, content) {
      const file = path.isAbsolute(options.index)
        ? options.index
        : path.resolve(siteRoot(), options.index)

      let artifact
      try {
        artifact = JSON.parse(fs.readFileSync(file, 'utf-8'))
      } catch {
        console.warn(`⚠ awt-headings: no index at ${file}; emitting nothing. Run \`awt site index --out\` first.`)
        return []
      }

      // Only pages that actually got built: a note excluded from publishing has no
      // anchors anyone can link to, and listing it would answer *does this note
      // exist* where the question is *is this page served*.
      const published = new Set(content.map(([, vfile]) => vfile.data?.slug).filter(Boolean))

      // Keyed by served address rather than by slug, for two reasons that are the
      // same reason: `vfile.data.slug` is the address by the time an emitter runs,
      // so a note moved by `awt-folder-notes` would otherwise look unpublished;
      // and the consumer resolves a page through `contentIndex.json`, which Quartz
      // also keys by the address. Both sides then agree on what a key means.
      const headings = {}
      for (const [slug, page] of Object.entries(artifact.pages ?? {})) {
        const address = page.address ?? slug
        if (!published.has(address)) continue
        headings[address] = {filePath: page.path, headings: page.headings ?? []}
      }

      const out = path.join(ctx.argv.output, options.outputPath)
      fs.mkdirSync(path.dirname(out), {recursive: true})
      fs.writeFileSync(out, JSON.stringify(headings))
      console.log(`✓ awt-headings: ${Object.keys(headings).length} pages in ${options.outputPath}`)
      return [out]
    },
  }
}

export default AwtHeadings

/**
 * The absorbed orchestrators, checked for the things a move can silently break.
 *
 * `bootstrap-quartz` and `publish-quartz` came across from `quartz-wiki-tools` as
 * working code; the real evidence they still work is that both ran against two real
 * sites, which is in the worklog. What is worth a test here is the seam: the
 * exports exist, the entry points take an argv array rather than reading
 * `process.argv`, and the plugin manifests are the shape Quartz's loader expects —
 * because a manifest Quartz cannot read fails as a **warning during a build that
 * then succeeds**, which is the worst failure mode this repo has.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {bootstrap, gitignoreGaps, prerenderDiagrams, publish} from '../index.js'

const PLUGINS = new URL('../../../quartz-plugins/', import.meta.url)

test('the orchestrators are functions that take an argv array', () => {
  assert.equal(typeof bootstrap, 'function')
  assert.equal(typeof publish, 'function')
  assert.equal(typeof prerenderDiagrams, 'function')
  // One parameter each, defaulted — the CLI passes its own args rather than the
  // module reading process.argv at import time.
  assert.ok(bootstrap.length <= 1)
  assert.ok(publish.length <= 1)
})

/**
 * The loading contract, asserted the way Quartz's own `config-loader.ts` reads
 * it at the pinned commit: the manifest's `category` may be a list, the loader
 * puts the package into every bucket named there, calls the *default* export once
 * per bucket, and checks only that the instance has that bucket's methods. None
 * of that is importable here — the loader is TypeScript inside the Quartz
 * install — so this mirrors it. Re-verify against the loader on a pin bump.
 */
test('the one Quartz plugin declares a manifest its loader can read', () => {
  assert.deepEqual(readdirSync(PLUGINS).sort(), ['awt'])

  const manifest = JSON.parse(readFileSync(new URL('awt/package.json', PLUGINS), 'utf8'))
  assert.ok(manifest.quartz, 'no quartz manifest')
  assert.deepEqual(manifest.quartz.category, ['transformer', 'emitter'])
  assert.equal(manifest.quartz.name, 'awt')
  assert.ok(manifest.quartz.description?.length > 20, 'needs a description')
  // A local plugin is symlinked into the Quartz tree, so a bare specifier here
  // would have to resolve from outside it. Zero dependencies is the contract.
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'must stay dependency-free')
})

test('its default factory answers both category buckets from one instance', async () => {
  const module = await import(new URL('awt/index.js', PLUGINS).pathname)
  assert.equal(typeof module.default, 'function', 'no default export')
  const instance = module.default({})
  assert.ok(instance.name, 'instance has no name')
  // validateCategory, restated: a transformer has any of the three passes, an
  // emitter has emit. One instance passes both.
  assert.ok(['textTransform', 'markdownPlugins', 'htmlPlugins'].some((m) => typeof instance[m] === 'function'))
  assert.equal(typeof instance.emit, 'function')
})

/**
 * The shadow, fed a hand-built artifact and a hand-built page.
 *
 * The check it performs was proved once by breaking it on purpose during M7, and
 * that was a manual act that did not become a test — so the one thing the plugin
 * exists to do had no coverage at all, and neither did its two ways of not
 * running.
 */
const shadow = async (options) => {
  const {default: Awt} = await import(new URL('awt/index.js', PLUGINS).pathname)
  return Awt({headings: false, ...options})
}

/** A wiki, an index beside it, and a rendered page — the three the shadow compares. */
function site(t, {links, rendered, ambiguous = [], root = true}) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-shadow-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const wiki = join(dir, 'wiki')
  mkdirSync(wiki, {recursive: true})
  writeFileSync(join(wiki, 'one.md'), '# One\n')

  const index = join(dir, '.awt-index.json')
  writeFileSync(
    index,
    JSON.stringify({
      version: 1,
      notesDir: root ? wiki : join(dir, "gone"),
      slugs: ['one'],
      pages: {
        one: {
          path: 'one.md',
          title: 'One',
          address: 'one',
          links,
          unresolved: [],
          ambiguous: [],
          ambiguousSlugs: ambiguous,
          headings: [],
        },
      },
    }),
  )

  const page = [
    {
      type: 'root',
      children: rendered.map((slug) => ({
        type: 'element',
        tagName: 'a',
        properties: {'data-slug': slug},
        children: [],
      })),
    },
    {data: {slug: 'one'}},
  ]
  return {dir, wiki, index, content: [page]}
}

test('the shadow throws when the two resolvers disagree', async (t) => {
  const box = site(t, {links: ['two'], rendered: ['three']})
  const plugin = await shadow({index: box.index})

  await assert.rejects(() => plugin.emit({}, box.content), (error) => {
    assert.match(error.message, /disagree on 1 of 1 pages/)
    assert.match(error.message, /ours resolves, quartz does not: two/)
    assert.match(error.message, /quartz resolves, ours does not: three/)
    return true
  })
})

test('the shadow is quiet when they agree', async (t) => {
  const box = site(t, {links: ['two'], rendered: ['two']})
  const plugin = await shadow({index: box.index})
  assert.deepEqual(await plugin.emit({}, box.content), [])
})

/**
 * A build with no index used to go green: the check the plugin exists for had not
 * run, and nothing said so. An index that is merely out of date is worse still —
 * it reports disagreements that are not real and hides ones that are.
 */
test('no index at all is an error, not a shrug', async () => {
  const plugin = await shadow({index: '/nowhere/at/all.json'})
  await assert.rejects(() => plugin.emit({}, []), /no index at \/nowhere\/at\/all.json, so nothing here can run/)
})

test('an index older than the newest note is an error', async (t) => {
  const box = site(t, {links: ['two'], rendered: ['two']})
  const later = new Date(Date.now() + 10_000)
  utimesSync(join(box.wiki, 'one.md'), later, later)

  const plugin = await shadow({index: box.index})
  await assert.rejects(() => plugin.emit({}, box.content), /is older than the newest note/)
})

/**
 * `shadow: false` is the resolver switch: the comparison goes and nothing else
 * does. A missing or stale index is still an error, because the folder-note
 * addresses and the heading list are read from it whether or not it is compared.
 */
test('shadow: false skips the comparison and nothing else', async (t) => {
  const box = site(t, {links: ['two'], rendered: ['three']})
  assert.deepEqual(await (await shadow({index: box.index, shadow: false})).emit({}, box.content), [])
  await assert.rejects(() => shadow({index: '/nowhere.json', shadow: false}).then((p) => p.emit({}, [])), /no index/)
})

/**
 * bootstrap will not edit a `.gitignore` the project owns and tracks, so the only
 * thing standing between an adopting project and a committed hundreds-of-MB
 * node_modules is that it is told. A project on the old tooling's file ignores
 * neither that nor the index.
 */
test('an existing .gitignore is reported against rather than rewritten', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'awt-publish-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const file = join(dir, '.gitignore')

  assert.ok(gitignoreGaps(file).includes('.awt-index.json'), 'no file at all: everything is missing')

  writeFileSync(file, '# from the old tooling\n.quartz-src/\npublic/\nrelease/\n')
  const missing = gitignoreGaps(file)
  assert.ok(missing.includes('node_modules/'))
  assert.ok(missing.includes('.awt-index.json'))
  assert.ok(missing.includes('.quartz.config.yaml'), 'the derived config is never tracked')
  assert.ok(!missing.includes('public/'), 'what it already has is not reported')

  writeFileSync(file, `${missing.join('\n')}\npublic/\nrelease/\n.quartz-src/\n`)
  assert.deepEqual(gitignoreGaps(file), [])
})

/**
 * The one place the two resolvers differ ON PURPOSE. We call two matches an
 * authoring error at edit time (decision 7); Quartz resolves only on a unique
 * match and otherwise falls through silently to a root-relative slug — usually a
 * 404, occasionally a real page. Reading either as drift failed a build over a
 * difference the design put there, which is what `[[README]]` did on the first
 * real run against a 139-note wiki: four notes carried that basename, and the
 * fallthrough landed on the root one.
 */
test('an ambiguous link is a deliberate difference, not drift', async (t) => {
  const box = site(t, {links: [], rendered: ['readme'], ambiguous: ['readme']})
  assert.deepEqual(await (await shadow({index: box.index})).emit({}, box.content), [])

  // And the other way round, where the fallthrough slug is not a page: Quartz
  // marks it broken, we said nothing about it, and that is not drift either.
  const marked = site(t, {links: [], rendered: [], ambiguous: ['readme']})
  marked.content[0][0].children = [
    {type: 'element', tagName: 'a', properties: {'data-slug': 'readme', className: ['broken']}, children: []},
  ]
  assert.deepEqual(await (await shadow({index: marked.index})).emit({}, marked.content), [])
})

test('and a genuine disagreement still fails, with an ambiguous link in the same page', async (t) => {
  const box = site(t, {links: ['two'], rendered: ['readme', 'three'], ambiguous: ['readme']})
  await assert.rejects(() => shadow({index: box.index}).then((p) => p.emit({}, box.content)), (error) => {
    assert.match(error.message, /ours resolves, quartz does not: two/)
    assert.match(error.message, /quartz resolves, ours does not: three/)
    assert.doesNotMatch(error.message, /readme/)
    return true
  })
})

/**
 * Ports are a project's setting, not a thing to retype. `awt site serve` on its own has
 * to produce the same pair every run, and two wikis have to be servable at once —
 * a cross-wiki link at dev time needs both up.
 */
test('the socket is derived from the port, so two wikis a port apart can serve together', async () => {
  const {DEFAULT_PORT, wsPortFor} = await import('../index.js')

  assert.equal(DEFAULT_PORT, 8100)
  assert.equal(wsPortFor(8101), 8201)
  assert.equal(wsPortFor(8102), 8202)
})

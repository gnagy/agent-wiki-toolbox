/**
 * The release path, at the four functions that were absorbed with no test of
 * their own.
 *
 * `toFileUrls`, `offlineConfig`, `swap` and `verify` came across from
 * `quartz-wiki-tools` as code proven in use rather than code with a suite behind
 * it. That made them a gap rather than a defect, and a gap is where the next
 * absorption bug hides: every one of them fails quietly. A link rewritten to the
 * wrong target still renders, a plugin left on shows an empty panel, a swap that
 * loses the previous release loses it silently, and a release missing
 * `contentIndex.json` breaks a *different* wiki's build.
 *
 * These are unit tests against real temporary directories rather than mocks of
 * the filesystem, because what each of them is actually about is what is on disk
 * afterwards.
 *
 * `die` exits the process, so the tests that exercise a refusal replace
 * `process.exit` with a throw. That is the behaviour under test — reaching `die`
 * at all is the assertion — not a shape the code was bent into for testing.
 */
import assert from 'node:assert/strict'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import test, {after} from 'node:test'

import {offlineConfig, swap, toFileUrls, verify, verifyFileUrls} from '../lib/release.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const made = []

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'awt-release-'))
  made.push(dir)
  return dir
}

after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

function put(root, rel, body) {
  const p = join(root, rel)
  mkdirSync(dirname(p), {recursive: true})
  writeFileSync(p, body)
  return p
}

/** Replace process.exit with a throw, so a refusal stops rather than continues. */
function noExit(t) {
  const errors = []
  t.mock.method(console, 'error', (m) => errors.push(String(m)))
  t.mock.method(console, 'log', () => {})
  t.mock.method(process, 'exit', (code) => {
    throw new Error(`exit ${code}`)
  })
  return errors
}

// ------------------------------------------------------------------ toFileUrls

/**
 * One build, carrying every case the rewriter distinguishes, so the counts it
 * returns are checked against each other rather than one at a time.
 */
function handoffFixture() {
  const root = tmp()
  put(root, 'about.html', '<!doctype html><html><body><p>About</p></body></html>')
  put(root, 'folder/index.html', '<!doctype html><html><body><p>Folder</p></body></html>')
  put(root, 'spaced page.html', '<!doctype html><html><body><p>Spaced</p></body></html>')
  put(root, 'assets/style.css', 'body{}')
  put(root, 'chunk.js', 'export const x = 1')
  mkdirSync(join(root, 'empty'))
  put(root, 'alias.html', '<!doctype html><html><head><meta http-equiv="refresh" content="0; url=about"></head><body></body></html>')
  put(
    root,
    'index.html',
    [
      '<!doctype html><html><head>',
      '<link rel="modulepreload" href="chunk.js">',
      '<script src="chunk.js"></script>',
      '<script>console.log(1)</script>',
      '</head><body>',
      '<a href="about">extensionless</a>',
      '<a href="about#section">anchored</a>',
      '<a href="folder">a directory</a>',
      '<a href="assets/style.css">an exact file</a>',
      '<a href="https://example.com/x">external</a>',
      '<a href="//cdn.example.com/y">protocol relative</a>',
      '<a href="#top">an anchor</a>',
      '<a class="internal broken" href="unwritten">a placeholder</a>',
      '<a class="internal" href="gone">dangling</a>',
      '<img src="missing.png">',
      '<a href="spaced%20page">percent encoded</a>',
      '<span data-href="about">not a link attribute</span>',
      '</body></html>',
    ].join('\n'),
  )
  return root
}

test('toFileUrls resolves every form of internal link a browser cannot follow from disk', () => {
  const root = handoffFixture()
  const out = toFileUrls(root)
  const html = readFileSync(join(root, 'index.html'), 'utf8')

  assert.match(html, /<a href="about\.html">/, 'an extensionless link gains the extension')
  assert.match(html, /<a href="about\.html#section">/, 'and keeps its anchor')
  assert.match(html, /<a href="folder\/index\.html">/, 'a directory becomes its index file')
  assert.match(html, /<a href="spaced%20page\.html">/, 'a percent-encoded name resolves decoded and is written back encoded')
  assert.equal(out.rewritten, 5, 'four in the page, one in the alias stub')
})

test('toFileUrls leaves alone everything that is not its business', () => {
  const root = handoffFixture()
  toFileUrls(root)
  const html = readFileSync(join(root, 'index.html'), 'utf8')

  assert.match(html, /href="https:\/\/example\.com\/x"/, 'an absolute URL')
  assert.match(html, /href="\/\/cdn\.example\.com\/y"/, 'a protocol-relative URL')
  assert.match(html, /href="#top"/, 'a bare anchor')
  assert.match(html, /href="assets\/style\.css"/, 'a link that already names an exact file')
  // The negative lookbehind: an attribute merely ending in `href` is not one.
  assert.match(html, /data-href="about"/, 'data-href is not href')
})

test('toFileUrls neutralises an unresolvable link rather than failing on it', () => {
  const root = handoffFixture()
  const out = toFileUrls(root)
  const html = readFileSync(join(root, 'index.html'), 'utf8')

  assert.match(html, /data-unresolved-href="unwritten"/)
  assert.match(html, /data-unresolved-href="gone"/)
  assert.equal(out.neutralised, 2)
  // Quartz's own `broken` class is what separates a backlog from a defect, and
  // the split is trusted rather than re-decided here.
  assert.deepEqual(out.placeholders, ['unwritten'])
  assert.deepEqual(out.dangling, ['index.html -> gone'])
})

test('toFileUrls treats a missing src as a defect, and says which page wanted it', () => {
  const root = handoffFixture()
  const out = toFileUrls(root)

  assert.deepEqual(out.missingAssets, ['index.html -> missing.png'])
  // An asset the build should have emitted stays a visible broken reference
  // rather than being quietly neutralised the way a href is.
  assert.match(readFileSync(join(root, 'index.html'), 'utf8'), /<img src="missing\.png">/)
  assert.equal(out.neutralised, 2, 'the missing asset is not one of them')
})

test('toFileUrls rewrites the destination of a meta refresh, which is a link like any other', () => {
  const root = handoffFixture()
  toFileUrls(root)

  assert.match(readFileSync(join(root, 'alias.html'), 'utf8'), /content="0; url=about\.html"/)
})

test('toFileUrls strips every script, its preloads, and the chunks they were loading', () => {
  const root = handoffFixture()
  const out = toFileUrls(root)
  const html = readFileSync(join(root, 'index.html'), 'utf8')

  assert.doesNotMatch(html, /<script/i, 'inline and sourced scripts both go')
  assert.doesNotMatch(html, /modulepreload/i, 'a preload keeps its bundle alive as a referenced file')
  assert.equal(out.scripts, 3)
  assert.equal(out.removed, 1)
  assert.equal(existsSync(join(root, 'chunk.js')), false, 'unreachable weight, once nothing loads it')
  assert.equal(existsSync(join(root, 'empty')), false, 'and the directories left empty by that')
  assert.equal(out.pages, 5)
})

test('what toFileUrls leaves is what verifyFileUrls passes, apart from the asset it reported', () => {
  const root = handoffFixture()
  const before = verifyFileUrls(root)
  assert.ok(before.bad.length > 1, 'the build is full of references a browser cannot follow')

  toFileUrls(root)
  const after = verifyFileUrls(root)
  assert.deepEqual(after.bad, ['index.html -> missing.png'], 'the one thing it deliberately did not fix')
})

// ----------------------------------------------------------------------- swap

test('swap renames staging into place and keeps what was standing', () => {
  const root = tmp()
  const [staging, out, prev] = ['staging', 'release', '.release-prev'].map((d) => join(root, d))
  put(root, 'staging/index.html', 'new')
  put(root, 'release/index.html', 'old')

  assert.equal(swap(staging, out, prev), true, 'it reports that there was one')
  assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), 'new')
  assert.equal(readFileSync(join(prev, 'index.html'), 'utf8'), 'old', 'rollback is a rename, not a rebuild')
  assert.equal(existsSync(staging), false)
})

test('swap on a first release reports that nothing was standing', () => {
  const root = tmp()
  const [staging, out, prev] = ['staging', 'release', '.release-prev'].map((d) => join(root, d))
  put(root, 'staging/index.html', 'new')

  assert.equal(swap(staging, out, prev), false)
  assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), 'new')
  assert.equal(existsSync(prev), false)
})

test('swap drops the release before last, so only one is kept', () => {
  const root = tmp()
  const [staging, out, prev] = ['staging', 'release', '.release-prev'].map((d) => join(root, d))
  put(root, 'staging/index.html', 'new')
  put(root, 'release/index.html', 'old')
  put(root, '.release-prev/index.html', 'older')
  put(root, '.release-prev/gone.html', 'older still')

  swap(staging, out, prev)
  assert.equal(readFileSync(join(prev, 'index.html'), 'utf8'), 'old')
  assert.equal(existsSync(join(prev, 'gone.html')), false, 'the whole directory goes, not its overlapping files')
})

// --------------------------------------------------------------------- verify

test('verify passes a release that a dependent wiki can resolve against', (t) => {
  const logs = []
  t.mock.method(console, 'log', (m) => logs.push(String(m)))
  const root = tmp()
  put(root, 'index.html', '<html></html>')
  put(root, 'static/contentIndex.json', '{}')

  verify(root, false)
  assert.match(logs.join('\n'), /2 pages|1 pages/)
  assert.match(logs.join('\n'), /files/)
})

test('verify refuses to swap a release with no contentIndex.json', (t) => {
  const errors = noExit(t)
  const root = tmp()
  put(root, 'index.html', '<html></html>')

  assert.throws(() => verify(root, false), /exit 2/)
  const said = errors.join('\n')
  assert.match(said, /contentIndex\.json/, 'it names the file')
  assert.match(said, /Other wikis resolve links against it/, 'and why that is not this wiki-s problem to shrug at')
  assert.match(said, /standing release is untouched/, 'and that nothing was lost')
})

test('verify refuses a build with no index.html at all', (t) => {
  const errors = noExit(t)
  const root = tmp()
  put(root, 'static/contentIndex.json', '{}')

  assert.throws(() => verify(root, true), /exit 2/)
  assert.match(errors.join('\n'), /index\.html/)
})

test('verify asks a handoff copy for less, because it has no dependents', (t) => {
  const errors = noExit(t)
  const root = tmp()
  put(root, 'index.html', '<html></html>')

  // The same directory that fails the release check passes the offline one.
  verify(root, true)
  assert.throws(() => verify(root, false), /exit 2/)
  assert.match(errors.join('\n'), /contentIndex\.json/)
})

// -------------------------------------------------------------- offlineConfig

/** A Quartz clone as far as loadFromQuartz is concerned: it needs one package. */
function fakeQuartz() {
  const quartz = tmp()
  mkdirSync(join(quartz, 'node_modules'))
  symlinkSync(join(ROOT, 'node_modules', 'yaml'), join(quartz, 'node_modules', 'yaml'))
  return quartz
}

test("offlineConfig hands back the project's own file untouched when it has one", async (t) => {
  const logs = []
  t.mock.method(console, 'log', (m) => logs.push(String(m)))
  const site = tmp()
  put(site, 'quartz.offline.yaml', 'configuration: {pageTitle: Mine}\n')

  assert.equal(await offlineConfig(site, fakeQuartz()), 'quartz.offline.yaml')
  assert.equal(existsSync(join(site, '.quartz.offline.yaml')), false, 'nothing is generated beside it')
  assert.match(logs.join('\n'), /the project's own/)
  assert.equal(readFileSync(join(site, 'quartz.offline.yaml'), 'utf8'), 'configuration: {pageTitle: Mine}\n')
})

test('offlineConfig derives one that turns off everything needing a browser', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (m) => logs.push(String(m)))
  const site = tmp()
  put(
    site,
    'quartz.config.yaml',
    [
      'configuration:',
      '  pageTitle: Test wiki',
      '  enableSPA: true',
      'plugins:',
      '  - source: quartz/plugins/components/graph',
      '  - source: quartz/plugins/emitters/contentIndex',
      '  - source:',
      '      name: search',
      '  - source: quartz/plugins/components/darkmode',
      '    enabled: false',
      '',
    ].join('\n'),
  )

  const name = await offlineConfig(site, fakeQuartz())
  assert.equal(name, '.quartz.offline.yaml')

  const {parse} = await import('yaml')
  const written = readFileSync(join(site, name), 'utf8')
  const config = parse(written)

  assert.equal(config.configuration.enableSPA, false, 'the router would intercept clicks it cannot service')
  assert.equal(config.configuration.enablePopovers, false)
  assert.equal(config.configuration.pageTitle, 'Test wiki', 'everything else survives the round trip')
  assert.equal(config.plugins[0].enabled, false, 'a nested source name is read the same as a string one')
  assert.equal(config.plugins[1].enabled, undefined, 'a plugin that works offline is not touched')
  assert.equal(config.plugins[2].enabled, false)
  assert.match(written, /^# GENERATED by awt site publish --offline/, 'it says not to edit it')
  assert.match(logs.join('\n'), /graph, search off/, 'and reports what it turned off')
  assert.doesNotMatch(logs.join('\n'), /darkmode/, 'one already off is not claimed as this pass-s work')
})

test('offlineConfig rewrites its generated file rather than accumulating', async (t) => {
  t.mock.method(console, 'log', () => {})
  const site = tmp()
  const quartz = fakeQuartz()
  put(site, 'quartz.config.yaml', 'configuration: {pageTitle: One}\nplugins: []\n')
  await offlineConfig(site, quartz)

  put(site, 'quartz.config.yaml', 'configuration: {pageTitle: Two}\nplugins: []\n')
  await offlineConfig(site, quartz)

  const {parse} = await import('yaml')
  assert.equal(parse(readFileSync(join(site, '.quartz.offline.yaml'), 'utf8')).configuration.pageTitle, 'Two')
  assert.deepEqual(
    readdirSync(site).sort(),
    ['.quartz.offline.yaml', 'quartz.config.yaml'],
    'one generated file, not one per build',
  )
})

test('offlineConfig says where to look when the Quartz clone has no yaml', async (t) => {
  const errors = noExit(t)
  const site = tmp()
  put(site, 'quartz.config.yaml', 'configuration: {}\n')
  const quartz = tmp()
  mkdirSync(join(quartz, 'node_modules'))

  await assert.rejects(() => offlineConfig(site, quartz), /exit 2/)
  assert.match(errors.join('\n'), /awt site setup/, 'the fix, not just the symptom')
})

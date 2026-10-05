/**
 * The one directory awt generates into, and the file that makes it need no ignore line anywhere.
 *
 * What matters is not that the paths are spelled a certain way but what git does with them, so the
 * ignore test asks git, in a real repository.
 */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test, {after} from 'node:test'

import {BUILD, DERIVED, DEV, HANDOFF, INDEX, LEGACY, OFFLINE, PUBLISHED, cleanBuild, ensureBuildDir, ensureSiteDir, legacyPresent, publishedDir, removeLegacy} from '../lib/layout.js'

const made = []
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})
function site() {
  const dir = mkdtempSync(join(tmpdir(), 'awt-layout-'))
  made.push(dir)
  return dir
}
const put = (root, rel, text = 'x') => {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), {recursive: true})
  writeFileSync(file, text)
}

test('every generated path is under build/, and a published site is one directory per target', () => {
  for (const path of [INDEX, DERIVED, OFFLINE, DEV, PUBLISHED, HANDOFF]) assert.ok(path.startsWith(`${BUILD}/`), path)
  assert.equal(publishedDir('/s', 'localhost-8088-wikis'), '/s/build/published/localhost-8088-wikis')
  assert.equal(publishedDir('/s'), '/s/build/published/default', 'no target is `default`')
})

test('build/ is made with a file that ignores it, and an edited one is left alone', () => {
  const dir = site()
  assert.equal(ensureBuildDir(dir), join(dir, 'build'))
  const ignore = join(dir, 'build', '.gitignore')
  assert.match(readFileSync(ignore, 'utf8'), /^\*$/m)

  writeFileSync(ignore, '*\n!keep-me\n')
  ensureBuildDir(dir)
  assert.equal(readFileSync(ignore, 'utf8'), '*\n!keep-me\n', 'calling it before every write must not undo a person\'s edit')
})

test('git ignores everything in build/ with no line in any other file', () => {
  const dir = site()
  const git = (...args) => spawnSync('git', args, {cwd: dir, encoding: 'utf8'})
  git('init', '-q')
  writeFileSync(join(dir, 'package.json'), '{}')
  ensureBuildDir(dir)
  for (const rel of [INDEX, DERIVED, OFFLINE, `${DEV}/index.html`, `${PUBLISHED}/localhost-8088-wikis/index.html`, `${HANDOFF}/index.html`]) put(dir, rel)

  const status = git('status', '--porcelain', '--untracked-files=all').stdout.trim().split('\n')
  assert.deepEqual(status, ['?? package.json'], 'only the tracked kind of file shows; nothing generated does')
  assert.equal(git('check-ignore', '-q', join(BUILD, 'published', 'localhost-8088-wikis', 'index.html')).status, 0)
})

test('legacy names are reported and removed, and nothing else in the directory is', () => {
  const dir = site()
  for (const rel of ['.awt-index.json', '.quartz.config.yaml', 'public/index.html', 'release/static/x', 'releases/a/index.html', '.release-prev/x']) put(dir, rel)
  put(dir, 'package.json')
  put(dir, 'quartz.offline.yaml') // the project's own file, tracked, never generated
  put(dir, 'README.md')
  ensureBuildDir(dir)

  assert.deepEqual(legacyPresent(dir).sort(), ['.awt-index.json', '.quartz.config.yaml', '.release-prev', 'public', 'release', 'releases'])
  assert.deepEqual(removeLegacy(dir).sort(), ['.awt-index.json', '.quartz.config.yaml', '.release-prev', 'public', 'release', 'releases'])
  for (const kept of ['package.json', 'quartz.offline.yaml', 'README.md', 'build']) assert.ok(existsSync(join(dir, kept)), `${kept} is not awt's to remove`)
  assert.deepEqual(legacyPresent(dir), [])
  assert.ok(LEGACY.includes('.quartz.offline.yaml') && !LEGACY.includes('quartz.offline.yaml'), 'the generated config is legacy, the project\'s own is not')
})

test('a dangling symlink among the legacy names is found and removed, not followed', () => {
  const dir = site()
  symlinkSync('/does/not/exist', join(dir, 'public'))
  assert.deepEqual(legacyPresent(dir), ['public'])
  removeLegacy(dir)
  assert.deepEqual(legacyPresent(dir), [])
})

test('cleaning removes build/ whole and says whether there was one', () => {
  const dir = site()
  assert.equal(cleanBuild(dir), false)
  ensureBuildDir(dir)
  put(dir, `${PUBLISHED}/x/index.html`)
  assert.equal(cleanBuild(dir), true)
  assert.ok(!existsSync(join(dir, 'build')))
})

test('the plugin finds the index in build/ from the link Quartz reads its config through', async (t) => {
  const crossWikiLinks = (await import(new URL('../../../quartz-plugins/awt/index.js', import.meta.url).pathname)).default
  const root = site()
  const notes = join(root, 'notes')
  mkdirSync(notes, {recursive: true})
  writeFileSync(join(notes, 'a.md'), '# A\n')
  ensureBuildDir(root)
  writeFileSync(join(root, 'build', 'quartz.config.yaml'), 'configuration: {}\n')
  writeFileSync(join(root, 'build', 'awt-index.json'), JSON.stringify({version: 1, notesDir: notes, slugs: [], pages: {}}))
  mkdirSync(join(root, 'node_modules', 'quartz'), {recursive: true})
  symlinkSync('../../build/quartz.config.yaml', join(root, 'node_modules', 'quartz', 'quartz.config.yaml'))

  const here = process.cwd()
  process.chdir(join(root, 'node_modules', 'quartz'))
  t.after(() => process.chdir(here))
  // The default path, as a hand-wired config would have it, and the one awt writes: both are relative to
  // the site, so neither may come out as build/build/awt-index.json.
  for (const index of [undefined, './build/awt-index.json']) {
    const plugin = crossWikiLinks(index ? {index} : {})
    assert.doesNotThrow(() => plugin.markdownPlugins({argv: {}}), `index ${index ?? '(default)'}`)
  }

  // And a config beside package.json, from an older setup, still has the site as its own directory.
  const older = site()
  mkdirSync(join(older, 'notes'), {recursive: true})
  writeFileSync(join(older, 'quartz.config.yaml'), 'configuration: {}\n')
  writeFileSync(join(older, '.awt-index.json'), JSON.stringify({version: 1, notesDir: join(older, 'notes'), slugs: [], pages: {}}))
  mkdirSync(join(older, 'node_modules', 'quartz'), {recursive: true})
  symlinkSync('../../quartz.config.yaml', join(older, 'node_modules', 'quartz', 'quartz.config.yaml'))
  process.chdir(join(older, 'node_modules', 'quartz'))
  assert.doesNotThrow(() => crossWikiLinks({index: './.awt-index.json'}).markdownPlugins({argv: {}}))
})

test('a missing site directory is made by setup alone, and refused by everything that writes into build/', () => {
  const root = site()
  const missing = join(root, 'wiki', 'site')

  // `ensureBuildDir` is what a build, an index or a config write calls, and none of them may invent a site: a
  // failed attempt in a project that has none would otherwise leave a stub directory that looks like one.
  assert.throws(() => ensureBuildDir(missing), /no site directory at .*wiki\/site\. Run `awt site setup`/)
  assert.ok(!existsSync(missing), 'and it made nothing')

  assert.equal(ensureSiteDir(missing), true, 'setup makes it, parents included')
  assert.equal(ensureSiteDir(missing), false, 'and says when there was nothing to make')
  assert.doesNotThrow(() => ensureBuildDir(missing))
  assert.ok(existsSync(join(missing, 'build', '.gitignore')))
})

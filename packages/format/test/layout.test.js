/**
 * The layout is derived from one name ([[toolbox-decisions]] 38): `rootDir` in
 * the project config, `wiki/` when unsaid, and fixed names underneath. What these
 * tests pin is the part a reader cannot see from the code — which shapes still
 * resolve, and from where.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {anchorSchemas} from '../lib/config.js'
import {findProject, layoutFrom, resolveLayout} from '../lib/layout.js'

function project(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'awt-layout-')))
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), {recursive: true})
    if (source !== null) writeFileSync(join(dir, path), source)
  }
  return {dir, cleanup: () => rmSync(dir, {recursive: true, force: true})}
}

process.env.AWT_QUIET_LEGACY = '1'

test('the default home is wiki/ beside the config, with fixed names inside it', () => {
  const layout = layoutFrom({}, '/p/awt.config.mjs')
  assert.equal(layout.rootDir, '/p/wiki')
  assert.equal(layout.notesDir, '/p/wiki/notes')
  assert.equal(layout.siteDir, '/p/wiki/site')
  assert.equal(layout.schemasDir, '/p/wiki/schemas')
  assert.equal(layout.inboxDir, '/p/wiki/inbox')
  assert.equal(layout.legacy, false)
})

test('rootDir moves the home and everything under it, relative to the config', () => {
  const layout = layoutFrom({rootDir: './docs/kb'}, '/p/awt.config.mjs')
  assert.equal(layout.rootDir, '/p/docs/kb')
  assert.equal(layout.notesDir, '/p/docs/kb/notes')
  assert.equal(layout.siteDir, '/p/docs/kb/site')
})

test('every directory the layout reports ends in Dir, and none is called root', () => {
  const layout = layoutFrom({}, '/p/awt.config.mjs')
  const dirs = Object.keys(layout).filter((key) => key.endsWith('Dir'))
  assert.deepEqual(dirs.sort(), ['inboxDir', 'notesDir', 'projectDir', 'rootDir', 'schemasDir', 'siteDir'])
  assert.ok(!('root' in layout))
})

/**
 * A depended-on wiki has to keep building while its sibling migrates, so the old
 * shape is recognised rather than refused — but only where nothing says otherwise:
 * an explicit rootDir, or a wiki/ home already present, wins over docs/wiki.
 */
test('docs/wiki beside a config with no rootDir is the legacy layout', async (t) => {
  const box = project({'awt.config.mjs': 'export default {}\n', 'docs/wiki/index.md': '# W\n', 'src/deep/x.txt': ''})
  t.after(() => box.cleanup())

  const layout = await resolveLayout(join(box.dir, 'src/deep'))
  assert.equal(layout.legacy, true)
  assert.equal(layout.rootDir, null)
  assert.equal(layout.notesDir, join(box.dir, 'docs/wiki'))
  assert.equal(layout.siteDir, join(box.dir, 'site'))
  assert.equal(layout.schemasDir, join(box.dir, '.remark'))
  assert.equal(layout.inboxDir, join(box.dir, 'docs/wiki-inbox'))

  // A wiki/ home appearing beside it ends the legacy reading.
  mkdirSync(join(box.dir, 'wiki'))
  assert.equal((await resolveLayout(box.dir)).legacy, false)
})

test('an explicit rootDir is never read as legacy, whatever else is on disk', () => {
  const layout = layoutFrom({rootDir: 'wiki'}, '/p/awt.config.mjs')
  assert.equal(layout.legacy, false)
})

test('a project with no config but the old site marker is still found, as legacy', async (t) => {
  const box = project({'site/quartz.config.yaml': 'configuration: {}\n', 'docs/wiki/index.md': '# W\n'})
  t.after(() => box.cleanup())

  const found = await findProject(join(box.dir, 'docs/wiki'))
  assert.equal(found.projectDir, box.dir)
  assert.equal(found.configPath, null)
  const layout = await resolveLayout(join(box.dir, 'docs/wiki'))
  assert.equal(layout.legacy, true)
  assert.equal(layout.notesDir, join(box.dir, 'docs/wiki'))
})

test('a bare directory with no project around it is not a project', async (t) => {
  const box = project({'a.md': '# A\n'})
  t.after(() => box.cleanup())
  // The temp dir's own ancestors carry no awt config; if one ever does, this test
  // is the one that says so.
  assert.equal(await resolveLayout(box.dir), null)
})

/**
 * Under a rootDir layout the schema globs are read from the notes directory, so a
 * map says `meta/**` rather than spelling the layout out a second time. The schema
 * file itself stays relative to the config, like every other path in it.
 */
test('schema globs anchor to the notes directory when told to, and to the config otherwise', () => {
  const config = {schemas: {'./wiki/schemas/note.json': ['meta/**/*.md']}}
  const fromNotes = anchorSchemas(config, '/p/awt.config.mjs', '/p/wiki/notes', '/p/wiki/notes')
  assert.deepEqual(Object.values(fromNotes.schemas)[0], ['meta/**/*.md'])

  const fromConfig = anchorSchemas(config, '/p/awt.config.mjs', '/p/wiki/notes')
  assert.deepEqual(Object.values(fromConfig.schemas)[0], ['../../meta/**/*.md'], 'the config dir is the base')
})

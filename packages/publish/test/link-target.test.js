/**
 * Which registry address a cross-wiki link is written against, and who decides.
 *
 * `awt` derives the answer into the plugin's `target` option; a hand-wired config
 * has none and keeps asking `--serve`. When both are present they must agree, so a
 * config derived for a dev server cannot quietly build a release.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

const crossWikiLinks = (await import(new URL('../../../quartz-plugins/awt/index.js', import.meta.url).pathname)).default

/** A plugin over a registry with both addresses, and the url one reference becomes. */
function linkWith(t, {target, argv}) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-target-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  for (const name of ['dev', 'published']) {
    mkdirSync(join(dir, name), {recursive: true})
    writeFileSync(join(dir, name, 'contentIndex.json'), JSON.stringify({'meta/scope': {filePath: 'meta/scope.md'}}))
  }
  const index = join(dir, '.awt-index.json')
  writeFileSync(index, JSON.stringify({version: 1, notesDir: dir, slugs: [], pages: {}}))

  const plugin = crossWikiLinks({
    index,
    ...(target === undefined ? {} : {target}),
    registry: {
      vsf: {
        dev: 'http://localhost:8081',
        published: 'https://wiki.example.org/vsf',
        buildIndex: join(dir, 'dev', 'contentIndex.json'),
        publishedIndex: join(dir, 'published', 'contentIndex.json'),
      },
    },
  })
  const [transform] = plugin.markdownPlugins({argv})
  const node = {type: 'link', url: 'vsf:meta/scope.md', children: []}
  transform()({type: 'root', children: [node]}, {data: {filePath: 'one.md'}})
  return node.url
}

test('a derived target decides the address, and agrees with the flag it was derived beside', (t) => {
  assert.equal(linkWith(t, {target: 'dev', argv: {serve: true}}), 'http://localhost:8081/meta/scope')
  assert.equal(linkWith(t, {target: 'published', argv: {}}), 'https://wiki.example.org/vsf/meta/scope')
})

test('with no target the flag decides, as a hand-wired config always did', (t) => {
  assert.equal(linkWith(t, {argv: {serve: true}}), 'http://localhost:8081/meta/scope')
  assert.equal(linkWith(t, {argv: {}}), 'https://wiki.example.org/vsf/meta/scope')
})

test('a config derived for one build refuses to run as the other', (t) => {
  assert.throws(() => linkWith(t, {target: 'dev', argv: {}}), /derived config is for a dev build, but this build lacks --serve/)
  assert.throws(
    () => linkWith(t, {target: 'published', argv: {serve: true}}),
    /derived config is for a published build, but this build has --serve/,
  )
})

test('a target that is neither dev nor published is refused by name', (t) => {
  assert.throws(() => linkWith(t, {target: 'staging', argv: {}}), /target is "staging", expected "dev" or "published"/)
})

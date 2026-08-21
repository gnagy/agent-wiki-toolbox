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
import {readFileSync, readdirSync} from 'node:fs'
import test from 'node:test'

import {bootstrap, prerenderDiagrams, publish} from '../index.js'

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

test('every Quartz plugin declares a manifest its loader can read', () => {
  const names = readdirSync(PLUGINS)
  assert.deepEqual(names.sort(), ['quartz-cross-wiki', 'quartz-headings', 'quartz-links'])

  for (const name of names) {
    const manifest = JSON.parse(readFileSync(new URL(`${name}/package.json`, PLUGINS), 'utf8'))
    assert.ok(manifest.quartz, `${name} has no quartz manifest`)
    assert.ok(
      ['transformer', 'emitter', 'filter', 'pageType'].includes(manifest.quartz.category),
      `${name} declares category "${manifest.quartz.category}"`,
    )
    assert.ok(manifest.quartz.description?.length > 20, `${name} needs a description`)
    // A local plugin is symlinked into the Quartz tree, so a bare specifier here
    // would have to resolve from outside it. Zero dependencies is the contract.
    assert.deepEqual(manifest.dependencies ?? {}, {}, `${name} must stay dependency-free`)
  }
})

test('every Quartz plugin exports a default factory returning its category shape', async () => {
  const expected = {
    'quartz-links': 'emit',
    'quartz-headings': 'emit',
    'quartz-cross-wiki': 'markdownPlugins',
  }

  for (const [name, method] of Object.entries(expected)) {
    const module = await import(new URL(`${name}/index.js`, PLUGINS).pathname)
    assert.equal(typeof module.default, 'function', `${name} has no default export`)
    const instance = module.default({})
    assert.equal(typeof instance[method], 'function', `${name} instance has no ${method}()`)
    assert.ok(instance.name, `${name} instance has no name`)
  }
})

test('the shadow says nothing rather than throwing when there is no index', async () => {
  const {default: AwtLinks} = await import(new URL('quartz-links/index.js', PLUGINS).pathname)
  const plugin = AwtLinks({index: '/nowhere/at/all.json'})
  assert.deepEqual(await plugin.emit({}, []), [])
})

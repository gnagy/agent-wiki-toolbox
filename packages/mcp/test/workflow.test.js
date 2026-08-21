/**
 * The M6 acceptance test, and the one that decides whether Foam can be retired:
 * **can `skills/wiki-docs/SKILL.md`'s lookup workflow be performed end to end
 * against this surface?** Not "does it match Foam's twenty-five tools" — parity
 * with the skill, not parity with Foam ([[toolbox-decisions]] 24).
 *
 * Driven over a real stdio transport rather than by calling the handlers, because
 * the thing being tested is the server an agent talks to.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'

const SERVER = new URL('../bin/awt-mcp.mjs', import.meta.url).pathname

const NOTES = {
  'index.md': '# Wiki\n\nStart at [[conventions]] and [[shape]].\n',
  'meta/conventions.md':
    '---\ntitle: Conventions\ntype: note\narea: meta\ntags: [conventions, linking]\n---\n\n' +
    '# Conventions\n\n## Naming\n\nUnique basenames, always. The authority is `CONTRIBUTING.md`.\n',
  'design/shape.md':
    '---\ntitle: Shape\ntype: adr\narea: design\ntags: [linking]\ndescription: How it is shaped.\n---\n\n' +
    '# Shape\n\nSee [[conventions#naming]] and [[missing-note]].\n',
}

function wiki() {
  const dir = mkdtempSync(join(tmpdir(), 'awt-mcp-e2e-'))
  const root = join(dir, 'wiki')
  mkdirSync(root, {recursive: true})
  for (const [path, source] of Object.entries(NOTES)) {
    mkdirSync(join(root, path, '..'), {recursive: true})
    writeFileSync(join(root, path), source)
  }
  return {dir, root, cleanup: () => rmSync(dir, {recursive: true, force: true})}
}

async function connect(root, extraArgs = []) {
  const client = new Client({name: 'workflow-test', version: '0'})
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, '--workspace', root, ...extraArgs],
      env: {...process.env, XDG_CACHE_HOME: join(root, '..', 'cache')},
    }),
  )
  return client
}

const json = (result) => JSON.parse(result.content[0].text)

test('the wiki-docs lookup workflow runs end to end', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const client = await connect(box.root)
  t.after(() => client.close())

  // 1. Is the server up, and is this the wiki I mean?
  const info = json(await client.callTool({name: 'workspace_info', arguments: {}}))
  assert.equal(info.root, box.root)
  assert.equal(info.notes, 3)
  assert.equal(info.allowWrites, false)
  // …and the tag vocabulary, so a near-duplicate is visible before it is coined.
  assert.deepEqual(info.tags.map((entry) => entry.tag).sort(), ['conventions', 'linking'])

  // 2–3. `meta/interop.md` and `index.md` are files: the agent reads them itself,
  // which is exactly why neither has a tool here.

  // 4. Search for the topic.
  const found = json(await client.callTool({name: 'search', arguments: {query: 'basenames'}}))
  assert.deepEqual(found.results.map((entry) => entry.path), ['meta/conventions.md'])

  // 5. Widen to the neighbours.
  const around = json(
    await client.callTool({name: 'connections', arguments: {path: 'meta/conventions.md', depth: 1}}),
  )
  assert.deepEqual(around.backlinks.map((entry) => entry.path).sort(), ['design/shape.md', 'index.md'])

  // 6. Follow a link to its target — including whether the anchor is real, which
  // Foam could not answer at all.
  const target = json(await client.callTool({name: 'resolve', arguments: {target: 'conventions#naming'}}))
  assert.equal(target.path, 'meta/conventions.md')
  assert.equal(target.anchor.status, 'ok')

  // And the health of the whole graph, in one call rather than four.
  const health = json(await client.callTool({name: 'check', arguments: {}}))
  assert.deepEqual(health.placeholders.map((entry) => entry.target), ['missing-note'])
  assert.deepEqual(health.problems, [])
  assert.equal(health.healthy, true)
})

test('the surface is twelve tools, and every write is one of them', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const client = await connect(box.root)
  t.after(() => client.close())

  const {tools} = await client.listTools()
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'build_listing',
      'check',
      'connections',
      'delete',
      'merge_files',
      'move',
      'rename',
      'rename_tag',
      'resolve',
      'search',
      'split_by_heading',
      'workspace_info',
    ],
  )
  for (const tool of tools) assert.ok(tool.description?.length > 20, `${tool.name} needs a description`)
})

test('a read-only server refuses a write and says how to enable it', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const client = await connect(box.root)
  t.after(() => client.close())

  const refusal = json(
    await client.callTool({name: 'rename', arguments: {path: 'design/shape.md', name: 'form.md'}}),
  )
  assert.match(refusal.error, /--allow-writes/)
})

test('with writes allowed, a rename comes back in the structured shape', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const client = await connect(box.root, ['--allow-writes'])
  t.after(() => client.close())

  const report = json(
    await client.callTool({name: 'rename', arguments: {path: 'design/shape.md', name: 'form.md'}}),
  )
  assert.equal(report.ok, true)
  assert.deepEqual(report.created, ['design/form.md'])
  assert.deepEqual(report.changed, ['index.md'])

  const health = json(await client.callTool({name: 'check', arguments: {}}))
  assert.deepEqual(health.placeholders.map((entry) => entry.target), ['missing-note'])
})

test('a verb that refuses reports in the same shape as one that finished', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const client = await connect(box.root, ['--allow-writes'])
  t.after(() => client.close())

  const report = json(
    await client.callTool({
      name: 'split_by_heading',
      arguments: {path: 'design/shape.md', plan: [{heading: 'Nope', path: 'design/nope.md'}], source: 'keep'},
    }),
  )
  assert.equal(report.ok, false)
  assert.match(report.notes.join(' '), /no heading "Nope"/)
})

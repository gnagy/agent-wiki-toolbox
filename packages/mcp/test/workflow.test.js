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
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
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
  assert.equal(info.notesDir, box.root)
  assert.equal(info.rootDir, null, 'a bare wiki directory has no home around it')
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

test('the surface is fourteen tools with --allow-writes, and every write is one of them', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const client = await connect(box.root, ['--allow-writes'])
  t.after(() => client.close())

  const {tools} = await client.listTools()
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'build_listing',
      'check',
      'connections',
      'delete',
      'fmt',
      'frontmatter',
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

test('a read-only server lists only the tools that can succeed', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const client = await connect(box.root)
  t.after(() => client.close())

  const {tools} = await client.listTools()
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['check', 'connections', 'fmt', 'frontmatter', 'resolve', 'search', 'workspace_info'],
  )

  // A write is not there to call.
  const result = await client.callTool({name: 'rename', arguments: {path: 'design/shape.md', name: 'form.md'}})
  assert.equal(result.isError, true)
  assert.equal(readFileSync(join(box.root, 'design/shape.md'), 'utf8').length > 0, true, 'untouched')
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

test('move takes a plan of pairs, and the old single-note shape is refused by the schema', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const client = await connect(box.root, ['--allow-writes'])
  t.after(() => client.close())

  const report = json(
    await client.callTool({
      name: 'move',
      arguments: {
        pairs: [
          {from: 'design/shape.md', to: 'archive/shape.md'},
          {from: 'meta/conventions.md', to: 'archive/conventions.md'},
        ],
      },
    }),
  )
  assert.equal(report.ok, true)
  assert.deepEqual(report.created.sort(), ['archive/conventions.md', 'archive/shape.md'])
  assert.match(report.notes.join(' '), /removed the empty folder design\//)

  const old = await client.callTool({name: 'move', arguments: {from: 'archive/shape.md', to: 'shape.md'}})
  assert.equal(old.isError, true)
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

/**
 * Front matter has a read half and a write half in one tool, like `fmt` — so the
 * read is served by a mount that may not be written to, and the write is told it
 * is not, rather than quietly being handed the read.
 */
test('frontmatter reads on a read-only server and refuses to write there', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const client = await connect(box.root)
  t.after(() => client.close())

  const read = json(await client.callTool({name: 'frontmatter', arguments: {path: 'design/shape.md'}}))
  assert.equal(read.frontmatter.title, 'Shape')

  // `validate` writes nothing either, so a read-only mount answers it.
  const valid = json(
    await client.callTool({name: 'frontmatter', arguments: {path: 'design/shape.md', operation: 'validate'}}),
  )
  assert.deepEqual(valid.violations, [])

  const refused = json(
    await client.callTool({
      name: 'frontmatter',
      arguments: {path: 'design/shape.md', operation: 'replace', key: 'title', value: 'Form'},
    }),
  )
  assert.match(refused.error, /read-only/)
  assert.match(readFileSync(join(box.root, 'design/shape.md'), 'utf8'), /title: Shape/)
})

test('frontmatter writes one key over the surface, and leaves the body alone', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const client = await connect(box.root, ['--allow-writes'])
  t.after(() => client.close())

  const report = json(
    await client.callTool({
      name: 'frontmatter',
      arguments: {path: 'design/shape.md', operation: 'append', key: 'tags', value: 'mdast'},
    }),
  )
  assert.deepEqual(report.changed, ['design/shape.md'])

  const source = readFileSync(join(box.root, 'design/shape.md'), 'utf8')
  assert.match(source, /tags: \[linking, mdast\]/)
  // The other domain is untouched, wikilinks and all — which is the split doing
  // its job rather than a happy accident.
  assert.match(source, /See \[\[conventions#naming\]\] and \[\[missing-note\]\]\./)
})

/**
 * The gap `fmt` fills is not the write verbs — everything they write already goes
 * out through the serializer ([[toolbox-decisions]] 19). It is the prose an agent
 * writes with its own `Write` and `Edit`, which is most of what lands in a wiki,
 * and which had no route to the formatter except a shell and a translated path.
 */
test('fmt formats a note named the way every other tool names one', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  writeFileSync(join(box.root, 'meta/conventions.md'), '# Conventions\n\n* one\n* two\n')
  const client = await connect(box.root, ['--allow-writes'])
  t.after(() => client.close())

  // dryRun is the surface's name for what the CLI calls --check: it says the note
  // is unformatted and leaves it that way.
  const preview = json(
    await client.callTool({name: 'fmt', arguments: {paths: ['meta/conventions.md'], dryRun: true}}),
  )
  assert.equal(preview.ok, false)
  assert.match(preview.report, /conventions\.md/)
  assert.match(readFileSync(join(box.root, 'meta/conventions.md'), 'utf8'), /^\* one$/m)

  const done = json(await client.callTool({name: 'fmt', arguments: {paths: ['meta/conventions.md']}}))
  assert.equal(done.ok, true)
  assert.equal(readFileSync(join(box.root, 'meta/conventions.md'), 'utf8'), '# Conventions\n\n- one\n- two\n')
})

/**
 * A wikilink is the thing a plain remark pipeline escapes to `\[\[link]]`, which
 * still renders and silently takes every edge with it. The whole reason this tool
 * exists rather than the agent reaching for any other formatter.
 */
test('fmt leaves the wikilinks and embeds intact', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  writeFileSync(join(box.root, 'design/shape.md'), '# Shape\n\nSee [[conventions]] and ![[missing-note]].\n')
  const client = await connect(box.root, ['--allow-writes'])
  t.after(() => client.close())

  assert.equal(json(await client.callTool({name: 'fmt', arguments: {}})).ok, true)
  const after = readFileSync(join(box.root, 'design/shape.md'), 'utf8')
  assert.match(after, /\[\[conventions\]\]/)
  assert.match(after, /!\[\[missing-note\]\]/)

  // …and the graph still has the edge, which is the assertion a text diff cannot make.
  const health = json(await client.callTool({name: 'check', arguments: {}}))
  assert.deepEqual(health.problems, [])
  assert.deepEqual(health.placeholders.map((entry) => entry.target), ['missing-note'])
})

/**
 * fmt is the one write with a read half. Asking a wiki you may not write to
 * whether it is formatted is an ordinary read -- the same question `check`
 * answers about the link graph, which a read-only mount serves happily -- so the
 * check is available there and the write is not.
 */
test('a read-only server checks formatting but will not fix it', async (t) => {
  const box = wiki()
  t.after(() => box.cleanup())
  const unformatted = '# Conventions\n\n* one\n'
  writeFileSync(join(box.root, 'meta/conventions.md'), unformatted)
  const client = await connect(box.root)
  t.after(() => client.close())

  const checked = json(await client.callTool({name: 'fmt', arguments: {dryRun: true}}))
  assert.equal(checked.ok, false)
  assert.match(checked.report, /conventions\.md/)
  assert.equal(readFileSync(join(box.root, 'meta/conventions.md'), 'utf8'), unformatted, 'not touched')

  const refusal = json(await client.callTool({name: 'fmt', arguments: {}}))
  assert.match(refusal.error, /read-only/)
  assert.match(refusal.error, /--allow-writes/)
  assert.equal(readFileSync(join(box.root, 'meta/conventions.md'), 'utf8'), unformatted, 'still not touched')

  // And the tool list says so, rather than advertising what it cannot do.
  const {tools} = await client.listTools()
  const described = tools.find((tool) => tool.name === 'fmt').description
  assert.match(described, /read-only/)
})

/**
 * `awt mcp --allow-writes` with no path: the server finds the project's config from
 * its cwd — an agent harness starts it from the project root — and reports both
 * directories under distinct names, so an agent never infers one from the other.
 */
test('with no --workspace the server means the project layout, and reports rootDir beside notesDir', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'awt-mcp-layout-')))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  writeFileSync(join(dir, 'awt.config.mjs'), 'export default {}\n')
  mkdirSync(join(dir, 'wiki/notes'), {recursive: true})
  writeFileSync(join(dir, 'wiki/notes/index.md'), '# W\n')
  writeFileSync(join(dir, 'README.md'), '# not a note\n')

  const client = new Client({name: 'workflow-test', version: '0'})
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      cwd: dir,
      env: {...process.env, AWT_WORKSPACE: '', XDG_CACHE_HOME: join(dir, 'cache')},
    }),
  )
  t.after(() => client.close())

  const info = json(await client.callTool({name: 'workspace_info', arguments: {}}))
  assert.equal(info.notesDir, join(dir, 'wiki/notes'))
  assert.equal(info.rootDir, join(dir, 'wiki'))
  assert.equal(info.notes, 1)
  assert.ok(!('root' in info))
})

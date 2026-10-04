/**
 * `awt site host`: the plan for a target's server, and the container that runs it.
 *
 * The plan is data, so it is asserted as data. `docker` and the HTTP probe are stood in for, since what
 * matters here is which commands are run and what is made of the answers; the real thing was run
 * against real Docker and nginx when this was written.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import test, {after} from 'node:test'

import {containerName, down, landingPage, LABEL, planHost, probe, up, writeHost} from '../lib/host.js'
import {loadMachine} from '../lib/machine.js'

const made = []
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

function setup(files) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-host-'))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), {recursive: true})
    writeFileSync(join(dir, name), text)
  }
  return dir
}

const TARGETS = 'local:\n  base: http://localhost:8088/wikis\npublic:\n  base: https://example.org/docs\nroot:\n  base: http://localhost:9000\n'

/** A machine with two wikis whose site directories exist, one of them with a release for `local`. */
function machine() {
  const cfg = setup({'targets.yaml': TARGETS})
  const a = setup({'releases/localhost-8088-wikis/static/contentIndex.json': '{}', 'releases/localhost-8088-wikis/index.html': 'x'})
  const b = setup({})
  writeFileSync(
    join(cfg, 'overrides.d.yaml'),
    '',
  )
  mkdirSync(join(cfg, 'registry.d'))
  writeFileSync(
    join(cfg, 'registry.d', 'shelton.yaml'),
    `dios:\n  mount: shelton\n  name: dios\n  site: ${a}\nphoto-cli:\n  mount: shelton\n  name: photo-cli\n  site: ${b}\nnomount:\n  site: ${b}\n`,
  )
  mkdirSync(join(cfg, 'overrides.d'))
  writeFileSync(join(cfg, 'overrides.d', 'partner.yaml'), 'partner:\n  urls:\n    local: http://localhost:9999/docs/\n')
  return {m: loadMachine({dir: cfg}), cfg, a, b}
}

test('each wiki is mounted by its site directory and served from a path inside it', () => {
  const {m, a, b} = machine()
  const plan = planHost({machine: m, targetName: 'local', dir: '/h/host/local'})

  assert.equal(plan.port, 8088)
  assert.equal(plan.local, true)
  const dios = plan.wikis.find((w) => w.key === 'dios')
  assert.deepEqual(
    [dios.state, dios.path, dios.container, dios.release, dios.published],
    ['hosted', '/wikis/shelton/dios/', '/srv/shelton/dios', 'releases/localhost-8088-wikis', true],
  )
  assert.equal(plan.wikis.find((w) => w.key === 'photo-cli').published, false, 'a wiki with no release is still hosted, at the path it will have')

  const conf = plan.files[join('conf', 'default.conf')]
  assert.match(conf, /location \/wikis\/shelton\/dios\/ \{\n {8}alias \/srv\/shelton\/dios\/releases\/localhost-8088-wikis\/;/)
  assert.match(conf, /location \/wikis\/shelton\/photo-cli\/ \{\n {8}alias \/srv\/shelton\/photo-cli\/releases\/localhost-8088-wikis\/;/)
  assert.match(conf, /try_files \$uri \$uri\.html \$uri\/index\.html =404;/, 'extensionless addresses resolve')
  assert.match(conf, /location = \/wikis\/shelton\/dios \{ return 301 \/wikis\/shelton\/dios\/; \}/, 'a bookmark without the slash works')
  assert.match(conf, /absolute_redirect off;/, 'a redirect does not name the container\'s own port')
  assert.match(conf, /location = \/wikis\/ \{[^}]*root \/srv\/awt-host;\n\s+rewrite \^ \/index\.html break;/, 'the landing page is a root and a rewrite, not an alias on a file')

  // The site directory is what is mounted: a release replaced by a rename must stay visible.
  const volumes = plan.docker.args.filter((_, i, all) => all[i - 1] === '-v')
  assert.ok(volumes.includes(`${a}:/srv/shelton/dios:ro`))
  assert.ok(volumes.includes(`${b}:/srv/shelton/photo-cli:ro`))
  assert.ok(volumes.includes('/h/host/local/conf:/etc/nginx/conf.d:ro'), 'the config is mounted as a directory')
  assert.ok(volumes.includes('/h/host/local/www:/srv/awt-host:ro'))
  assert.ok(!volumes.some((v) => v.includes('/release')), 'no release directory is mounted, which a swap would leave behind')
})

test('the container is bound to this machine only, named and labelled for its target', () => {
  const {m} = machine()
  const plan = planHost({machine: m, targetName: 'local', dir: '/h', port: 9100})
  assert.equal(plan.docker.name, containerName('local'))
  const args = plan.docker.args
  assert.deepEqual(args.slice(0, 4), ['run', '-d', '--name', 'awt-host-local'])
  assert.ok(args.includes('127.0.0.1:9100:80'), 'published on loopback, on the port asked for')
  assert.equal(args[args.indexOf('--label') + 1], `${LABEL}=local`)
  assert.equal(args.at(-1), 'nginx:alpine')
})

test('what cannot be served is said, and a wiki hosted elsewhere is listed and not mounted', () => {
  const {m} = machine()
  const plan = planHost({machine: m, targetName: 'local', dir: '/h'})
  assert.deepEqual(plan.wikis.find((w) => w.key === 'partner'), {key: 'partner', mount: null, name: null, state: 'external', url: 'http://localhost:9999/docs/'})
  const skipped = plan.wikis.find((w) => w.key === 'nomount')
  assert.equal(skipped.state, 'skipped')
  assert.match(skipped.reason, /no mount and name/)
  assert.ok(!plan.files[join('conf', 'default.conf')].includes('partner'), 'nothing is served for it')
})

test('a base with no path serves at the root, and a target that is not local cannot be run', () => {
  const {m} = machine()
  const root = planHost({machine: m, targetName: 'root', dir: '/h'})
  assert.equal(root.port, 9000)
  const conf = root.files[join('conf', 'default.conf')]
  assert.match(conf, /location = \/ \{/)
  assert.match(conf, /location \/shelton\/dios\/ \{/)
  assert.ok(!conf.includes('location = ; '), 'no redirect for a base with no path')

  const remote = planHost({machine: m, targetName: 'public', dir: '/h'})
  assert.equal(remote.local, false, 'example.org is not a server this machine can be')
  assert.equal(remote.port, 443)

  assert.throws(() => planHost({machine: m, targetName: 'nope', dir: '/h'}), /no target "nope"; targets are local, public, root/)
})

test('the landing page lists every wiki and cannot be broken out of by what they are called', () => {
  const page = landingPage({
    targetName: 'local',
    base: 'http://localhost:8088/wikis',
    wikis: [{key: 'a', mount: 'm', name: '</script><b>', state: 'hosted', url: 'u', path: 'p'}],
  })
  assert.match(page, /const TARGET = "local"/)
  assert.ok(!page.includes('</script><b>'), 'a name with markup in it stays data')
  assert.match(page, /static\/awtRelease\.json/, 'the state is read from each release\'s own record')
})

test('writing the plan replaces generated files whole, and nothing else', () => {
  const dir = setup({'conf/default.conf': 'old', 'conf/mine.conf': 'keep'})
  const {m} = machine()
  const plan = planHost({machine: m, targetName: 'local', dir})
  const written = writeHost(plan)
  assert.equal(written.length, 2)
  assert.match(readFileSync(join(dir, 'conf', 'default.conf'), 'utf8'), /Generated by awt site host/)
  assert.equal(readFileSync(join(dir, 'conf', 'mine.conf'), 'utf8'), 'keep')
  assert.match(readFileSync(join(dir, 'www', 'index.html'), 'utf8'), /<title>Wikis<\/title>/)
})

/** A stand-in `docker` that records what it was asked and answers from a table. */
function fakeDocker({exists = null, running = 'true', label = 'local', fail = null} = {}) {
  const calls = []
  const run = (cmd, args) => {
    assert.equal(cmd, 'docker')
    calls.push(args)
    if (args[0] === 'version') return {status: fail === 'version' ? 1 : 0, stdout: '29.5.2\n', stderr: ''}
    if (args[0] === 'inspect') return exists ? {status: 0, stdout: `${running} ${label}\n`, stderr: ''} : {status: 1, stdout: '', stderr: 'no such object'}
    if (args[0] === 'rm') return {status: 0, stdout: '', stderr: ''}
    if (args[0] === 'run') return fail === 'run' ? {status: 125, stdout: '', stderr: 'port is already allocated\n'} : {status: 0, stdout: 'abc123def4567890\n', stderr: ''}
    throw new Error(`unexpected docker ${args.join(' ')}`)
  }
  return {run, calls}
}

test('up starts a container, replaces one that is ours, and refuses one that is not', () => {
  const {m} = machine()
  const plan = planHost({machine: m, targetName: 'local', dir: '/h'})

  const fresh = fakeDocker()
  assert.deepEqual(up(plan, {run: fresh.run}), {name: 'awt-host-local', id: 'abc123def456'})
  assert.deepEqual(fresh.calls.map((c) => c[0]), ['version', 'inspect', 'run'])

  const replaced = fakeDocker({exists: true})
  up(plan, {run: replaced.run})
  assert.deepEqual(replaced.calls.map((c) => c[0]), ['version', 'inspect', 'rm', 'run'], 'ours is removed before the new one starts')

  const stranger = fakeDocker({exists: true, label: '<no value>'})
  assert.throws(() => up(plan, {run: stranger.run}), /named awt-host-local exists and was not started by awt site host/)
  assert.ok(!stranger.calls.some((c) => c[0] === 'rm' || c[0] === 'run'), 'a container that is not ours is never removed')

  assert.throws(() => up(plan, {run: fakeDocker({fail: 'version'}).run}), /docker is not running/)
  assert.throws(() => up(plan, {run: fakeDocker({fail: 'run'}).run}), /docker run failed: port is already allocated/)
})

test('down removes our container, finds nothing to remove without complaint, and leaves a stranger', () => {
  assert.deepEqual(down('local', {run: fakeDocker({exists: true}).run}), {name: 'awt-host-local', removed: true})
  assert.deepEqual(down('local', {run: fakeDocker().run}), {name: 'awt-host-local', removed: false})
  assert.throws(() => down('local', {run: fakeDocker({exists: true, label: 'other'}).run}), /was not started by awt site host/)
})

test('the probe asks the server, waits for it to start, and explains a release it cannot see', async () => {
  const {m} = machine()
  const plan = planHost({machine: m, targetName: 'local', dir: '/h'})
  const answers = {
    'http://127.0.0.1:8088/wikis/': [0, 0, 200],
    'http://127.0.0.1:8088/wikis/shelton/dios/': [404],
    'http://127.0.0.1:8088/wikis/shelton/photo-cli/': [404],
  }
  const asked = []
  const get = async (url) => {
    asked.push(url)
    return answers[url].length > 1 ? answers[url].shift() : answers[url][0]
  }
  let clock = 0
  const result = await probe(plan, {get, wait: 5000, now: () => clock, sleep: async (ms) => void (clock += ms)})

  assert.equal(result.landing, 200, 'it waited out two refused connections')
  const dios = result.wikis.find((w) => w.key === 'dios')
  assert.equal(dios.serving, false)
  assert.match(dios.note, /its release exists at .*releases\/localhost-8088-wikis and the container does not see it; Docker may not share that path/)
  assert.equal(result.wikis.find((w) => w.key === 'photo-cli').note, 'no release for this target yet')
  assert.ok(!asked.some((u) => u.includes('partner')), 'a wiki hosted elsewhere is not asked for')
})

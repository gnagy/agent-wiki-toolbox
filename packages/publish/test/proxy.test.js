/**
 * `awt site proxy`, against a stand-in for `awt site serve`.
 *
 * The stand-in is a script the proxy runs exactly as it runs awt — the executable,
 * then `site serve --port N --ws-port M` in the project directory — so what is
 * tested is the proxy's side of that contract: which port it chose, what it
 * forwards, what it says when the wiki will not start, and when it stops one.
 * A project's `mode` file says which wiki to be: one that serves, or one that fails.
 */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import http from 'node:http'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {createProxy, defaultConfigFile, readProxyConfig} from '../lib/proxy.js'
import {serviceFor, serviceName} from '../lib/proxy-service.js'

const FAKE_SERVE = `
import fs from 'node:fs'
import http from 'node:http'
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
fs.appendFileSync('starts', args.join(' ') + '\\n')
if (fs.readFileSync('mode', 'utf8').trim() === 'fail') {
  console.error('boom: this wiki cannot be served')
  process.exit(3)
}
console.log('serving on ' + port)
http.createServer((request, response) => {
  if (request.url === '/folder') {
    response.writeHead(302, {location: '/folder/'})
    return response.end()
  }
  response.writeHead(200, {'content-type': 'text/plain'})
  response.end('page ' + request.url)
}).listen(port, '127.0.0.1')
`

function fixture(t, wikis, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'awt-proxy-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const serve = join(root, 'fake-serve.mjs')
  writeFileSync(serve, FAKE_SERVE)
  const entries = {}
  for (const [prefix, mode] of Object.entries(wikis)) {
    mkdirSync(join(root, prefix))
    writeFileSync(join(root, prefix, 'mode'), mode)
    entries[prefix] = {project: `./${prefix}`, title: `The ${prefix} wiki`}
  }
  const file = join(root, 'proxy.json')
  writeFileSync(file, JSON.stringify({port: 8090, wikis: entries, ...extra}))
  return {root, file, command: [process.execPath, serve]}
}

/** A proxy on a port of its own, and a way to ask it for a path. */
async function running(t, {file, command}) {
  const proxied = createProxy({config: readProxyConfig(file), command})
  const server = http.createServer((request, response) => proxied.handle(request, response))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    proxied.close()
    server.close()
  })
  const get = (path) =>
    new Promise((resolve, reject) => {
      http
        .get({host: '127.0.0.1', port: server.address().port, path}, (response) => {
          let body = ''
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body}))
        })
        .on('error', reject)
    })
  return {proxied, get}
}

async function until(check, ms = 10_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('the config resolves projects against its own directory and the home directory', (t) => {
  const {root, file} = fixture(t, {one: 'ok'})
  writeFileSync(file, JSON.stringify({wikis: {one: {project: './one'}, two: {project: '~/wikis/two', title: 'Two'}}}))
  const config = readProxyConfig(file)
  assert.equal(config.port, 8090)
  assert.equal(config.idleMinutes, 30)
  assert.deepEqual(config.wikis.one, {project: join(root, 'one'), title: 'one'})
  assert.deepEqual(config.wikis.two, {project: join(homedir(), 'wikis', 'two'), title: 'Two'})
})

test('a config it cannot use is refused whole, with every problem named', (t) => {
  const {file} = fixture(t, {})
  writeFileSync(file, JSON.stringify({port: 'x', wikis: {'Bad Prefix': {project: '.'}, fine: {}}}))
  assert.throws(() => readProxyConfig(file), (error) => {
    assert.match(error.message, /"Bad Prefix": a prefix is lowercase/)
    assert.match(error.message, /"fine": needs a "project"/)
    assert.match(error.message, /"port" must be a port number/)
    return true
  })
  assert.throws(() => readProxyConfig(join(file, '..', 'missing.json')), /cannot read the proxy config/)
})

test('the default config is under the user config directory', () => {
  assert.equal(defaultConfigFile({XDG_CONFIG_HOME: '/x'}, 'linux'), join('/x', 'awt', 'proxy.json'))
  assert.equal(defaultConfigFile({APPDATA: 'C:\\Roaming'}, 'win32'), join('C:\\Roaming', 'awt', 'proxy.json'))
})

test('the landing page lists every wiki, and a wiki not listed is a 404 that names the others', async (t) => {
  const setup = fixture(t, {alpha: 'ok', beta: 'ok'})
  const {get} = await running(t, setup)
  const landing = await get('/')
  assert.equal(landing.status, 200)
  assert.match(landing.body, /href="\/alpha\/">The alpha wiki/)
  assert.match(landing.body, /href="\/beta\/">The beta wiki/)
  assert.match(landing.body, /class="stopped"/)

  const missing = await get('/gamma/page')
  assert.equal(missing.status, 404)
  assert.match(missing.body, /"gamma" is not in this proxy's config/)
  assert.match(missing.body, /alpha/)

  const status = JSON.parse((await get('/_proxy/status.json')).body)
  assert.deepEqual(status.wikis.map((wiki) => [wiki.prefix, wiki.state]), [['alpha', 'stopped'], ['beta', 'stopped']])
})

test('a wiki starts on its first request, on ports the proxy chose, and is then forwarded to without its prefix', async (t) => {
  const setup = fixture(t, {alpha: 'ok'})
  const {get} = await running(t, setup)

  const bare = await get('/alpha')
  assert.equal(bare.status, 301)
  assert.equal(bare.headers.location, '/alpha/')

  const first = await get('/alpha/notes/one?x=1')
  assert.equal(first.status, 503)
  assert.match(first.body, /Starting The alpha wiki/)
  assert.match(first.body, /http-equiv="refresh"/)

  const page = await until(async () => {
    const answer = await get('/alpha/notes/one?x=1')
    return answer.status === 200 && answer
  })
  assert.equal(page.body, 'page /notes/one?x=1')

  // Quartz's trailing-slash redirect is absolute, so it gets the prefix back.
  const folder = await get('/alpha/folder')
  assert.equal(folder.status, 302)
  assert.equal(folder.headers.location, '/alpha/folder/')

  const starts = readFileSync(join(setup.root, 'alpha', 'starts'), 'utf8').trim().split('\n')
  assert.equal(starts.length, 1, 'started once, however many requests')
  assert.match(starts[0], /^site serve --port \d+ --ws-port \d+$/)
})

test('a wiki that exits shows its own output, and is not restarted on every request', async (t) => {
  const setup = fixture(t, {broken: 'fail'})
  const {get, proxied} = await running(t, setup)

  await get('/broken/')
  const failed = await until(async () => {
    const answer = await get('/broken/')
    return answer.status === 502 && answer
  })
  assert.match(failed.body, /The broken wiki is not running/)
  assert.match(failed.body, /exited with 3/)
  assert.match(failed.body, /boom: this wiki cannot be served/)
  assert.match(failed.body, /starts it again/)

  await get('/broken/')
  assert.equal(readFileSync(join(setup.root, 'broken', 'starts'), 'utf8').trim().split('\n').length, 1)
  assert.equal(proxied.status()[0].state, 'exited')
  assert.ok(proxied.status()[0].retryInSeconds > 0)

  const landing = await get('/')
  assert.match(landing.body, /class="exited"/)
})

test('a wiki nobody asks for is stopped after its idle time, and started again on the next request', async (t) => {
  // 0.002 minutes is 120 ms.
  const setup = fixture(t, {alpha: 'ok'}, {idleMinutes: 0.002})
  const {get, proxied} = await running(t, setup)
  await get('/alpha/')
  await until(async () => (await get('/alpha/')).status === 200)
  const {port} = proxied.status()[0]

  await until(() => proxied.status()[0].state === 'stopped')
  await until(
    () =>
      new Promise((resolve) => {
        http.get({host: '127.0.0.1', port, path: '/'}, () => resolve(false)).on('error', () => resolve(true))
      }),
  )

  await until(async () => (await get('/alpha/')).status === 200)
  assert.equal(readFileSync(join(setup.root, 'alpha', 'starts'), 'utf8').trim().split('\n').length, 2)
})

test('a missing project is an exited wiki that says so, not a crash', async (t) => {
  const setup = fixture(t, {alpha: 'ok'})
  rmSync(join(setup.root, 'alpha'), {recursive: true})
  const {get} = await running(t, setup)
  const answer = await get('/alpha/')
  assert.equal(answer.status, 502)
  assert.match(answer.body, /no project at/)
})

test('the service is named after its config, and runs this awt with the installing PATH', () => {
  const command = ['/opt/bun', '/opt/awt/packages/cli/bin/awt.mjs']
  const env = {PATH: '/opt/bin:/usr/bin', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'}
  const argv = [...command, 'site', 'proxy', '--config', '/home/me/.config/awt/work.json']

  assert.equal(serviceName('/x/proxy.json'), 'awt-proxy-proxy')
  assert.equal(serviceName('/x/My Work.json'), 'awt-proxy-my-work')

  const mac = serviceFor({platform: 'darwin', configFile: argv.at(-1), command, env, home: '/Users/me', uid: 501})
  assert.equal(mac.file, '/Users/me/Library/LaunchAgents/dev.awt.proxy.work.plist')
  for (const arg of argv) assert.ok(mac.content.includes(`<string>${arg}</string>`), arg)
  assert.match(mac.content, /<key>PATH<\/key><string>\/opt\/bin:\/usr\/bin<\/string>/)
  assert.match(mac.content, /<key>KeepAlive<\/key><true\/>/)
  assert.deepEqual(mac.install.at(-1).argv, ['launchctl', 'bootstrap', 'gui/501', mac.file])

  const linux = serviceFor({platform: 'linux', configFile: argv.at(-1), command, env, home: '/home/me'})
  assert.equal(linux.file, '/home/me/.config/systemd/user/awt-proxy-work.service')
  assert.match(linux.content, new RegExp(`^ExecStart=${argv.map((arg) => `"${arg}"`).join(' ')}$`, 'm'))
  assert.match(linux.content, /^Environment="PATH=\/opt\/bin:\/usr\/bin"$/m)
  assert.match(linux.content, /^Restart=always$/m)

  const windows = serviceFor({platform: 'win32', configFile: 'C:\\cfg\\work.json', command: ['C:\\bun.exe', 'C:\\awt\\awt.mjs'], env, home: 'C:\\Users\\me'})
  assert.equal(windows.file, 'C:\\Users\\me\\AppData\\Local\\awt\\awt-proxy-work.cmd')
  assert.match(windows.content, /"C:\\bun\.exe" "C:\\awt\\awt\.mjs" "site" "proxy" "--config" "C:\\cfg\\work\.json"/)
  assert.match(windows.content, /\r\ngoto loop\r\n/)
  assert.ok(windows.install.some(({argv: one}) => one.includes('ONLOGON')))

  assert.throws(() => serviceFor({platform: 'aix', configFile: '/x/proxy.json', command}), /no service install for aix/)
})

test('awt site proxy --install --dry-run shows the service and writes nothing', (t) => {
  const {file} = fixture(t, {alpha: 'ok'})
  const awt = new URL('../../cli/bin/awt.mjs', import.meta.url).pathname
  const run = (...args) => spawnSync(process.execPath, [awt, 'site', 'proxy', ...args], {encoding: 'utf8'})

  const both = run('--install', '--uninstall', '--config', file)
  assert.equal(both.status, 2)

  if (!['darwin', 'linux', 'win32'].includes(process.platform)) return
  const dry = run('--install', '--dry-run', '--config', file)
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /would write /)
  assert.match(dry.stdout, /would run: /)
  assert.ok(dry.stdout.includes(file), 'the service names the config it serves')
  const written = dry.stdout.match(/would write (.+)/)[1]
  assert.equal(existsSync(written), false, `${written} was written by a dry run`)
})

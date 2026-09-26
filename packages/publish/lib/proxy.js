/**
 * `awt site proxy` — one known port in front of several wikis, each at `/<prefix>/`.
 *
 * The proxy's lifecycle is its own. It holds a config listing the wikis, starts a wiki's
 * `awt site serve` on the first request for it, forwards to it with the prefix
 * stripped, and stops it again when nobody has asked for a while. Whatever happens
 * to a wiki, the proxy answers: a landing page at `/`, and a page saying why for a
 * wiki that is not in the config, still starting, or has exited.
 *
 * **Every link Quartz emits is relative**, so a page does not know which path it
 * is served under and an unmodified `awt site serve` works behind the prefix. The
 * one exception is the trailing-slash redirect, whose `Location` is absolute; it is
 * rewritten here.
 *
 * **The proxy chooses the ports.** It asks the system for two free ones on every
 * start, so `serve.port` in a project's config stops mattering here, and two
 * projects that declared the same one stop colliding. Quartz's hot-reload script
 * dials its socket port directly, bypassing the proxy, which is fine on one machine
 * and means a page left open across a restart has to be refreshed by hand.
 *
 * **Stage 1 of two.** Keeping a Quartz dev server resident per open wiki is the
 * cost of needing nothing from awt; serving built output is the stage after.
 */

import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { parseArgs } from "node:util"

/** The port a proxy listens on when its config does not say. */
export const DEFAULT_PROXY_PORT = 8090

/** Minutes a wiki may go unrequested before its server is stopped. */
export const DEFAULT_IDLE_MINUTES = 30

/** A prefix is typed in every URL, so it is kept to what needs no escaping. */
const PREFIX = /^[a-z0-9][a-z0-9-]*$/

/** Lines of a wiki's own output kept for its error page. */
const LOG_LINES = 60

/** The first retry after an exit, doubling up to the cap and reset once a start succeeds. */
const BACKOFF_MS = 10_000
const BACKOFF_CAP_MS = 5 * 60_000

/**
 * Where a proxy's config lives when none is named: the user's config directory,
 * which is `%APPDATA%` on Windows and `$XDG_CONFIG_HOME` or `~/.config` elsewhere.
 */
export function defaultConfigFile(env = process.env, platform = process.platform) {
  const base =
    platform === "win32"
      ? env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "awt", "proxy.json")
}

/**
 * The config: which wikis, at which prefixes, on which port. Read once at startup
 * and validated whole, and explicit rather than looked up, so a proxy serves the
 * same wikis every time it starts. Not `--index`, which would collide with
 * `awt site index` and its unrelated link-graph index.
 *
 *     {
 *       "port": 8090,
 *       "idleMinutes": 30,
 *       "wikis": {
 *         "aisandbox": {"project": "/Users/me/Dev/AiSandbox", "title": "AiSandbox wiki"}
 *       }
 *     }
 *
 * A relative `project` resolves against the config file's directory, and a
 * leading `~` is the home directory, as it would be in a shell.
 */
export function readProxyConfig(file) {
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`cannot read the proxy config ${file}: ${error.message}`)
  }
  const problems = []
  const wikis = {}
  if (!data || typeof data !== "object" || !data.wikis || typeof data.wikis !== "object") {
    problems.push('it needs a "wikis" object, prefix to {project, title}')
  } else {
    for (const [prefix, entry] of Object.entries(data.wikis)) {
      if (!PREFIX.test(prefix)) problems.push(`"${prefix}": a prefix is lowercase letters, digits and hyphens`)
      else if (!entry || typeof entry.project !== "string" || !entry.project) problems.push(`"${prefix}": needs a "project" path`)
      else
        wikis[prefix] = {
          project: path.resolve(path.dirname(file), home(entry.project)),
          title: typeof entry.title === "string" && entry.title ? entry.title : prefix,
        }
    }
  }
  const port = data?.port ?? DEFAULT_PROXY_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`"port" must be a port number, got ${JSON.stringify(port)}`)
  const idleMinutes = data?.idleMinutes ?? DEFAULT_IDLE_MINUTES
  if (typeof idleMinutes !== "number" || idleMinutes <= 0) problems.push(`"idleMinutes" must be a positive number`)
  if (problems.length) throw new Error(`the proxy config ${file} is not usable:\n  ${problems.join("\n  ")}`)
  return { port, idleMinutes, wikis }
}

const home = (file) => (file === "~" || /^~[/\\]/.test(file) ? path.join(os.homedir(), file.slice(1)) : file)

/** A port nothing is listening on, from the system. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function answers(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end()
      resolve(true)
    })
    socket.on("error", () => resolve(false))
  })
}

/**
 * Stop a wiki's awt and the Quartz it started. On macOS and Linux awt forwards
 * SIGTERM to Quartz. Windows has no signal to forward, and killing awt alone would
 * leave Quartz holding both ports, so the whole tree goes.
 */
function end(child) {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
  } else {
    child.kill("SIGTERM")
  }
}

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

const STYLE = `body{font:15px/1.45 system-ui,sans-serif;margin:2rem;color:#1f2328;background:#fff}
h1{font-size:1.4rem}td,th{padding:.35rem .9rem .35rem 0;text-align:left;vertical-align:top}
code,pre{font:12px/1.4 ui-monospace,monospace;color:#57606a}pre{white-space:pre-wrap;background:#f6f8fa;padding:1rem}
.up{color:#1a7f37}.starting{color:#9a6700}.exited{color:#cf222e}.stopped{color:#6e7781}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}code,pre{color:#8d96a0}pre{background:#161b22}}`

function html(response, status, title, body, { refresh = false } = {}) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  response.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      (refresh ? `<meta http-equiv="refresh" content="2">` : "") +
      `<title>${escape(title)}</title><style>${STYLE}</style><h1>${escape(title)}</h1>${body}`,
  )
}

/**
 * The proxy itself, without the listening: a request handler plus the wikis it
 * supervises. `command` is how to run awt — the executable and the arguments that
 * come before `site serve` — so it runs the same awt the proxy is part of on every
 * platform, rather than an `awt` found on a PATH a service may not have.
 */
export function createProxy({ config, command, log = () => {}, clock = Date.now }) {
  const wikis = new Map()
  const idleMs = config.idleMinutes * 60_000

  const stateOf = (prefix) => wikis.get(prefix)?.state ?? "stopped"

  async function start(prefix) {
    const previous = wikis.get(prefix)
    const wiki = {
      state: "starting",
      since: clock(),
      last: clock(),
      lines: [],
      failures: previous?.failures ?? 0,
    }
    wikis.set(prefix, wiki)
    const { project } = config.wikis[prefix]
    try {
      wiki.port = await freePort()
      wiki.wsPort = await freePort()
    } catch (error) {
      return exited(prefix, wiki, `no free port: ${error.message}`)
    }
    if (!fs.existsSync(project)) return exited(prefix, wiki, `no project at ${project}`)

    const [executable, ...leading] = command
    const args = [...leading, "site", "serve", "--port", String(wiki.port), "--ws-port", String(wiki.wsPort)]
    log(`${prefix}: starting in ${project} on ${wiki.port}`)
    const child = spawn(executable, args, { cwd: project, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    wiki.child = child
    const keep = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        // Quartz warns once per note outside git; it drowns the lines that say what broke.
        if (line.trim() && !line.includes("isn't yet tracked by git")) wiki.lines.push(line)
      }
      wiki.lines.splice(0, Math.max(0, wiki.lines.length - LOG_LINES))
    }
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    child.on("error", (error) => exited(prefix, wiki, `could not run awt: ${error.message}`))
    child.on("exit", (code, signal) => {
      if (wiki.state === "stopped") return
      exited(prefix, wiki, `awt site serve exited with ${code ?? signal}`)
    })

    const poll = setInterval(async () => {
      if (wiki.state !== "starting") return clearInterval(poll)
      if (await answers(wiki.port)) {
        clearInterval(poll)
        if (wiki.state !== "starting") return
        wiki.state = "up"
        wiki.failures = 0
        log(`${prefix}: up after ${Math.round((clock() - wiki.since) / 1000)} s`)
      }
    }, 250)
    poll.unref?.()
  }

  function exited(prefix, wiki, reason) {
    wiki.state = "exited"
    wiki.reason = reason
    wiki.child = null
    wiki.failures += 1
    wiki.retryAt = clock() + Math.min(BACKOFF_MS * 2 ** (wiki.failures - 1), BACKOFF_CAP_MS)
    log(`${prefix}: ${reason}`)
  }

  function stop(prefix, why) {
    const wiki = wikis.get(prefix)
    if (!wiki?.child) return
    wiki.state = "stopped"
    end(wiki.child)
    wiki.child = null
    log(`${prefix}: stopped, ${why}`)
  }

  const sweep = setInterval(() => {
    for (const [prefix, wiki] of wikis) {
      if (wiki.state === "up" && clock() - wiki.last > idleMs) stop(prefix, "idle")
    }
  }, Math.min(idleMs, 30_000))
  sweep.unref?.()

  function status() {
    return Object.entries(config.wikis).map(([prefix, { project, title }]) => {
      const wiki = wikis.get(prefix)
      return {
        prefix,
        title,
        project,
        state: stateOf(prefix),
        ...(wiki?.state === "up" ? { port: wiki.port, idleSeconds: Math.round((clock() - wiki.last) / 1000) } : {}),
        ...(wiki?.state === "exited" ? { reason: wiki.reason, retryInSeconds: Math.max(0, Math.round((wiki.retryAt - clock()) / 1000)) } : {}),
      }
    })
  }

  function landing(response) {
    const rows = status().map((wiki) => {
      const detail =
        wiki.state === "up" ? `idle ${wiki.idleSeconds} s` : wiki.state === "exited" ? escape(wiki.reason) : ""
      return (
        `<tr><td><a href="/${wiki.prefix}/">${escape(wiki.title)}</a></td><td><code>/${wiki.prefix}/</code></td>` +
        `<td class="${wiki.state}">${wiki.state}</td><td>${detail}</td><td><code>${escape(wiki.project)}</code></td></tr>`
      )
    })
    const body = rows.length
      ? `<table><tr><th>Wiki</th><th>Path</th><th>State</th><th></th><th>Project</th></tr>${rows.join("")}</table>`
      : "<p>The config lists no wikis.</p>"
    html(response, 200, `Wikis on :${config.port}`, `${body}<p><code>Following a link starts a stopped wiki.</code></p>`)
  }

  function forward(request, response, prefix, wiki, rest) {
    const upstream = http.request(
      { host: "127.0.0.1", port: wiki.port, path: rest, method: request.method, headers: request.headers },
      (answer) => {
        const headers = { ...answer.headers }
        if (typeof headers.location === "string" && headers.location.startsWith("/")) {
          headers.location = `/${prefix}${headers.location}`
        }
        response.writeHead(answer.statusCode ?? 502, headers)
        answer.pipe(response)
      },
    )
    upstream.on("error", (error) =>
      html(response, 502, `${config.wikis[prefix].title} is not answering`, `<pre>${escape(error.message)}</pre>`),
    )
    request.pipe(upstream)
  }

  async function handle(request, response) {
    const { pathname, search } = new URL(request.url ?? "/", "http://proxy")
    const [, name = "", ...tail] = pathname.split("/")
    if (name === "") return landing(response)
    if (name === "_proxy" && tail.join("/") === "status.json") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      return response.end(JSON.stringify({ port: config.port, wikis: status() }, null, 1))
    }
    const entry = config.wikis[name]
    if (!entry) {
      const known = Object.keys(config.wikis).map((one) => `<a href="/${one}/">${one}</a>`).join(", ")
      return html(response, 404, "No such wiki", `<p>"${escape(name)}" is not in this proxy's config. Known: ${known || "none"}.</p>`)
    }
    // `/aisandbox` alone gets the slash, so the page's relative links resolve under the prefix.
    if (tail.length === 0) {
      response.writeHead(301, { location: `/${name}/${search}` })
      return response.end()
    }

    let wiki = wikis.get(name)
    if (!wiki || wiki.state === "stopped" || (wiki.state === "exited" && clock() >= wiki.retryAt)) {
      await start(name)
      wiki = wikis.get(name)
    }
    wiki.last = clock()

    if (wiki.state === "starting") {
      const seconds = Math.round((clock() - wiki.since) / 1000)
      return html(
        response,
        503,
        `Starting ${entry.title}…`,
        `<p>${seconds} s so far. This page reloads itself.</p><pre>${escape(wiki.lines.slice(-8).join("\n"))}</pre>`,
        { refresh: true },
      )
    }
    if (wiki.state === "exited") {
      const retry = Math.max(0, Math.round((wiki.retryAt - clock()) / 1000))
      return html(
        response,
        502,
        `${entry.title} is not running`,
        `<p>${escape(wiki.reason)}. The next request after ${retry} s starts it again.</p>` +
          `<p><code>${escape(entry.project)}</code></p><pre>${escape(wiki.lines.slice(-25).join("\n"))}</pre>`,
      )
    }
    forward(request, response, name, wiki, `/${tail.join("/")}${search}`)
  }

  function close() {
    clearInterval(sweep)
    for (const prefix of wikis.keys()) stop(prefix, "the proxy is shutting down")
  }

  return { handle, status, close }
}

/** `awt site proxy` as a process: read the config, listen, and stop every wiki on the way out. */
export async function proxy(argv = process.argv.slice(2), { command }) {
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: "string" }, port: { type: "string" } },
    allowPositionals: false,
  })
  const file = path.resolve(values.config ?? defaultConfigFile())
  let config
  try {
    config = readProxyConfig(file)
  } catch (error) {
    console.error(error.message)
    return 1
  }
  if (values.port !== undefined) {
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`--port must be a port number, got "${values.port}"`)
      return 1
    }
    config.port = port
  }

  const stamp = () => new Date().toTimeString().slice(0, 8)
  const proxied = createProxy({ config, command, log: (line) => console.log(`${stamp()} ${line}`) })
  const server = http.createServer((request, response) => {
    proxied.handle(request, response).catch((error) => {
      if (!response.headersSent) html(response, 500, "Proxy error", `<pre>${escape(error.stack ?? error)}</pre>`)
      else response.destroy(error)
    })
  })

  return await new Promise((resolve) => {
    server.on("error", (error) => {
      console.error(error.code === "EADDRINUSE" ? `port ${config.port} is already in use` : error.message)
      resolve(1)
    })
    server.listen(config.port, "127.0.0.1", () => {
      console.log(`config: ${file}\nwikis: ${Object.keys(config.wikis).join(", ") || "none"}\nproxy on http://localhost:${config.port}/`)
    })
    const shutdown = () => {
      proxied.close()
      server.close(() => resolve(0))
      setTimeout(() => resolve(0), 2000).unref()
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, shutdown)
  })
}

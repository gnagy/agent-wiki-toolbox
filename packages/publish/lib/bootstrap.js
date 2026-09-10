/**
 * Set up (or re-pin) the Quartz clone a wiki site builds from.
 *
 * Quartz is never vendored into a project: the site directory holds config, and
 * the renderer is cloned beside it at a PINNED COMMIT. Quartz publishes no
 * usable release — its newest GitHub release is from 2023 and its lone v5 tag is
 * hundreds of commits behind the branch and does not build — so a project pins a
 * commit SHA on `v5` and re-runs the link graph check on every bump.
 *
 * The pin is one line in `<site>/quartz.pin`, tracked in the project repo. It
 * lives there rather than in this script because each project bumps on its own
 * schedule.
 *
 * Usage, from anywhere inside a project (the site is `<rootDir>/site`, found
 * through awt.config.mjs by `awt`; the legacy `site/` beside `docs/wiki` still resolves):
 *     awt site setup                  # clone or re-pin, then install
 *     awt site setup --site path      # explicit path, resolved against cwd
 *     awt site setup --force          # discard and re-clone
 *
 * With no --site it walks up for the legacy `site/quartz.config.yaml` marker —
 * `awt site setup` always passes --site, resolved from the project config.
 *
 * Idempotent: safe to re-run, and re-running is how a Quartz bump or a newly
 * installed version of these tools is applied. Needs `git`, `node` and `npm`.
 */

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"

import { requireProjectRoot } from "./project-root.js"

/** The toolbox root: packages/publish/lib -> packages/publish -> packages -> root. */
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const PLUGINS = [
  ["awt-links", "quartz-links"],
  ["awt-cross-wiki", "quartz-cross-wiki"],
  ["awt-headings", "quartz-headings"],
  ["awt-folder-notes", "quartz-folder-notes"],
]

const REPO_URL = "https://github.com/jackyzha0/quartz.git"
const BRANCH = "v5"

// npm exports npm_config_* into child environments and npm_config_local_prefix
// breaks a nested npx, so every child here runs with them stripped.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("NPM_")),
)

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", env: CLEAN_ENV, ...opts })
}

function must(cmd, args, what, opts = {}) {
  const r = run(cmd, args, opts)
  if (r.status !== 0) {
    console.error(`${what} failed:\n${((r.stdout ?? "") + (r.stderr ?? "")).trimEnd()}`)
    process.exit(1)
  }
  return (r.stdout ?? "").trim()
}

function die(msg) {
  console.error(msg)
  process.exit(2)
}

function readPin(site) {
  const pinFile = path.join(site, "quartz.pin")
  if (!fs.existsSync(pinFile)) {
    die(
      `no ${pinFile}. Create it with the Quartz commit to pin, e.g.\n` +
        `    echo 075afd3f712da0088a07f5284a7b3aba37dd61b6 > ${pinFile}\n` +
        "Pick a commit on the v5 branch; there is no usable release to pin instead.",
    )
  }
  for (const raw of fs.readFileSync(pinFile, "utf8").split("\n")) {
    const line = raw.split("#")[0].trim()
    if (line) return line
  }
  die(`${pinFile} is empty`)
}

// What bootstrap adds to a site directory is machine-local and large — a Quartz
// clone with its own node_modules, the build output, and a symlink to this
// machine's install. Written before the clone rather than after, so the tree is
// never untracked-and-huge in a `git status`; one `git add -A` in a project that
// has nothing to do with publishing would otherwise commit ~300 MB.
const GITIGNORE = `# Quartz itself is cloned at the commit in quartz.pin, never vendored; see
# README.md here. Nothing of it belongs in this repo, including its node_modules
# (~250 MB, entirely separate from the project's own).
.quartz-src/

# Build output. Disposable: rebuild it with the serve command in README.md.
public/

# The last published build: the release itself (nothing about a release enters
# git), plus awt site publish's staging directory and the release it replaced.
release/
.release-staging/
.release-prev/

# The handoff copy built by awt site publish --offline, and the config it derives
# to build it with. Both are regenerated on demand; quartz.offline.yaml, if the
# project writes one to take that over, IS tracked.
handoff/
.handoff-staging/
.handoff-prev/
.quartz.offline.yaml

# Symlinks to the Quartz plugins installed on this machine, created by
# \`awt site setup\`, and the index they read. Machine-local by definition,
# and regenerated rather than authored.
awt-links
awt-cross-wiki
awt-headings
awt-folder-notes
.awt-index.json
`

// The lines that must be there, as opposed to the comments explaining them. A
// project adopting `awt` with a .gitignore from the old tooling has none of these.
const GITIGNORE_PATHS = GITIGNORE.split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))

/**
 * Which of the lines this bootstrap needs are missing from a project's own
 * `.gitignore`. Everything, when there is no file yet.
 */
export function gitignoreGaps(file) {
  if (!fs.existsSync(file)) return GITIGNORE_PATHS
  const have = new Set(
    fs.readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean),
  )
  return GITIGNORE_PATHS.filter((line) => !have.has(line))
}

function writeGitignore(site) {
  const file = path.join(site, ".gitignore")
  const shown = path.relative(process.cwd(), file)

  // Never overwrite: the project owns this file once it exists, and it is tracked.
  // But leaving it alone silently is not the same thing — a project adopting awt
  // with a .gitignore from the old tooling ignores none of the plugin symlinks or
  // the index, and finds out by committing them. Say what is missing instead.
  if (fs.existsSync(file)) {
    const missing = gitignoreGaps(file)
    if (missing.length === 0) return
    console.log(
      `\n${shown} exists and was left alone. It does not ignore\n` +
        `${missing.length} thing${missing.length === 1 ? "" : "s"} this bootstrap creates. Append:\n\n` +
        missing.map((line) => `    ${line}`).join("\n"),
    )
    return
  }

  fs.writeFileSync(file, GITIGNORE)
  console.log(`wrote ${shown}; commit it`)
}

function relink(linkPath, target) {
  if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
    fs.rmSync(linkPath, { recursive: true, force: true })
  }
  fs.symlinkSync(target, linkPath)
}

export function bootstrap(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      // No default: an absent --site means "find the project", which is not the
      // same as "look for ./site". parseArgs cannot tell a default from a value.
      site: { type: "string" },
      force: { type: "boolean", default: false },
    },
  })

  const site = values.site
    ? path.resolve(values.site)
    : path.join(requireProjectRoot(die), "site")
  if (!fs.existsSync(site) || !fs.statSync(site).isDirectory()) die(`no site directory at ${site}`)
  if (!fs.existsSync(path.join(site, "quartz.config.yaml")))
    die(`no ${path.join(site, "quartz.config.yaml")}; a site directory needs its Quartz config`)

  const pin = readPin(site)
  const src = path.join(site, ".quartz-src")

  writeGitignore(site)

  if (values.force && fs.existsSync(src)) {
    console.log(`removing ${src}`)
    fs.rmSync(src, { recursive: true, force: true })
  }

  if (!fs.existsSync(src)) {
    console.log(`cloning Quartz ${BRANCH} into ${path.relative(process.cwd(), src)} ...`)
    must("git", ["clone", "--quiet", "--branch", BRANCH, REPO_URL, src], "clone")
  } else {
    must("git", ["-C", src, "fetch", "--quiet", "origin", BRANCH], "fetch")
  }

  const current = must("git", ["-C", src, "rev-parse", "HEAD"], "rev-parse")
  if (!current.startsWith(pin) && current !== pin) {
    console.log(`checking out ${pin.slice(0, 12)} ...`)
    must("git", ["-C", src, "checkout", "--quiet", pin], `checkout ${pin}`)
  } else {
    console.log(`already at ${pin.slice(0, 12)}`)
  }

  // Quartz reads quartz.config.yaml AND ./package.json from its own working
  // directory, so the config has to be reachable from inside the clone while
  // still living in site/ where it is tracked and reviewable.
  relink(path.join(src, "quartz.config.yaml"), "../quartz.config.yaml")

  // Point the project at THIS installation of the tools. The config names
  // relative paths (`../awt-links`, `../awt-cross-wiki`, `../awt-headings`), so it
  // stays machine-independent and carries no version; this symlink is what binds it to the copy installed on
  // this machine. Gitignored, recreated on every bootstrap.
  for (const [linkName, pluginDir] of PLUGINS) {
    relink(path.join(site, linkName), path.join(HERE, "quartz-plugins", pluginDir))
    console.log(`${linkName} -> ${path.join(HERE, "quartz-plugins", pluginDir)}`)
  }

  // Quartz NEVER re-resolves an installed plugin: if .quartz/plugins/<name>
  // exists it returns early without comparing the installed version to the
  // configured one. So changing what a project should use is a silent no-op
  // until this directory goes. Clearing it here makes re-running bootstrap the
  // one ritual that means "take the current tooling".
  const cache = path.join(src, ".quartz", "plugins")
  if (fs.existsSync(cache)) {
    fs.rmSync(cache, { recursive: true, force: true })
    console.log("cleared the plugin cache")
  }

  console.log("installing dependencies (this takes a few minutes on a cold cache) ...")
  const i = run("npm", ["install", "--no-audit", "--no-fund"], { cwd: src, stdio: "ignore" })
  if (i.status !== 0) die("npm install failed")

  console.log("\nready. Next:\n    awt site serve       dev server\n    awt site publish     release build into site/release")
  return 0
}

/**
 * Ensure, or explicitly set up, the Quartz install a wiki site builds from.
 *
 * Quartz is never vendored: `site/package.json` names it as a pinned git
 * dependency (`github:jackyzha0/quartz#<sha>`), and `bun install` fetches it
 * into `site/node_modules/quartz` — shared with every other project on the
 * machine pinned to the same commit, through bun's own content-addressed
 * install cache. Quartz publishes no usable release — its newest GitHub
 * release is from 2023 and its lone v5 tag is hundreds of commits behind the
 * branch and does not build — so a commit SHA on `v5` is the only pinnable
 * artifact, same as before this changed.
 *
 * Two different things live here:
 *
 *   ensureQuartz()   the safe part — no decision left to make. Called by
 *                     `serve` and `publish` so neither ever runs against
 *                     missing or half-installed dependencies. Refuses only
 *                     when `site/package.json` doesn't exist: writing that
 *                     file the first time is a project decision, not a
 *                     materialization of one already made.
 *
 *   bootstrap()      the deliberate part — `awt site setup`. Creates the site
 *                     directory when the project has none yet, writes
 *                     `site/package.json` (first time, or to accept a newer
 *                     pin the toolbox now ships, or under --force), the
 *                     `.gitignore`, then calls ensureQuartz for the rest.
 *
 * The config Quartz reads is not the project's to write: `site-config.js`
 * derives it before every build from the pinned install's own default and the
 * project's `site` declaration in awt.config.mjs, and the one symlink wired here
 * points the install at that derived file. The four per-project plugin symlinks
 * this used to write are gone with the four plugins; the one plugin is named by
 * absolute path in the derived config and Quartz links it itself.
 *
 * The pin itself lives at this repo's own root (`quartz.pin`, beside
 * `mise.toml`), not per project — every wiki this machine builds shares it,
 * tested together as part of releasing this toolbox rather than bumped
 * independently per project. See
 * wiki/notes/projects/agent-wiki-toolbox/design/wiki-publishing-decisions.md
 * decision 20, and .../analysis/quartz-install-sharing.md for the evidence,
 * in the AiSandbox workspace wiki this was designed in.
 *
 * Usage, from anywhere inside a project (the site is `<rootDir>/site`, found
 * through awt.config.mjs by `awt`; the legacy `site/` beside `docs/wiki` still
 * resolves):
 *     awt site setup                  # bootstrap, or accept a new pin
 *     awt site setup --site path      # explicit path, resolved against cwd
 *     awt site setup --force          # discard node_modules and reinstall
 *
 * Needs `bun` on PATH — by the time any of this runs, `awt` itself already
 * has, since the plugin's own binary requires it.
 */

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"

import { narrateTo, say } from "./narrate.js"
import { requireProjectRoot } from "./project-root.js"
import { DERIVED_CONFIG } from "./site-config.js"

/** The toolbox root: packages/publish/lib -> packages/publish -> packages -> root. */
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/** What the four retired plugins were linked as, under site/node_modules and Quartz's cache. */
const OLD_LINKS = ["awt-links", "awt-cross-wiki", "awt-headings", "awt-folder-notes"]

const REPO = "jackyzha0/quartz"

// Found reactively, against one real build, by running `bun pm untrusted`
// after the fact rather than enumerated from a clean install. Treat this as
// incomplete until someone verifies it from scratch — see
// quartz-install-sharing.md, "what's not yet closed".
const TRUSTED_DEPS = ["@parcel/watcher", "sharp", "esbuild"]

function die(message) {
  console.error(message)
  process.exit(2)
}

function readToolboxPin() {
  const pinFile = path.join(HERE, "quartz.pin")
  if (!fs.existsSync(pinFile)) {
    die(`no ${pinFile}. The toolbox itself is missing its Quartz pin — an install defect, not a project one.`)
  }
  for (const raw of fs.readFileSync(pinFile, "utf8").split("\n")) {
    const line = raw.split("#")[0].trim()
    if (line) return line
  }
  die(`${pinFile} is empty`)
}

/** The commit a project's package.json currently names, or null if it names none yet. */
function readProjectPin(site) {
  const pkgFile = path.join(site, "package.json")
  if (!fs.existsSync(pkgFile)) return null
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
  const dep = pkg.dependencies?.quartz ?? ""
  const match = /#([0-9a-f]{7,40})$/.exec(dep)
  return match ? match[1] : null
}

function writePackageJson(site, pin) {
  const file = path.join(site, "package.json")
  const pkg = {
    name: "site",
    private: true,
    dependencies: { quartz: `github:${REPO}#${pin}` },
    trustedDependencies: TRUSTED_DEPS,
  }
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  warnIfIgnored(site, file)
}

/**
 * The pin is only a pin if it is tracked, and a project's root .gitignore can
 * swallow a `package.json` anywhere in the tree (a framework's generated-files
 * rule, say). `git status` then shows nothing, and the next clone has no site to
 * set up. Asked of git itself, since only git knows which rule wins.
 */
function warnIfIgnored(site, file) {
  const asked = spawnSync("git", ["check-ignore", "-q", file], { cwd: site, stdio: "ignore" })
  if (asked.status !== 0) return
  say(
    `\n⚠ ${path.relative(process.cwd(), file)} is ignored by a .gitignore above it, so it will not be tracked.\n` +
      `  It is the Quartz pin. Add a negation for it (e.g. !/${path.relative(path.dirname(site), file)}\n` +
      "  after the rule that ignores it), or git add -f it; either way, check it is tracked.",
  )
}

// What bootstrap adds to a site directory is machine-local — Quartz and its
// dependencies under node_modules/, the build output, and the symlinks this
// file wires up. Written before the install rather than after, so the tree is
// never untracked-and-huge in a `git status`; one `git add -A` in a project
// that has nothing to do with publishing would otherwise commit hundreds of MB.
const GITIGNORE = `# Quartz and its dependencies are a bun-installed git dependency of
# package.json here, never vendored; see README.md and SETUP.md in the toolbox
# repo. package.json and bun.lock ARE tracked — they are the pin.
node_modules/

# Build output. Disposable: rebuild it with the serve command in README.md.
public/

# The last published build: the release itself (nothing about a release enters
# git), plus awt site publish's staging directory and the release it replaced.
release/
.release-staging/
.release-prev/

# The config Quartz reads, derived by awt before every build from the pinned
# install's own default and the site declaration in awt.config.mjs. A project
# that takes it over tracks quartz.config.yaml beside it instead.
.quartz.config.yaml

# The handoff copy built by awt site publish --offline, and the config it derives
# to build it with. Both are regenerated on demand; quartz.offline.yaml, if the
# project writes one to take that over, IS tracked.
handoff/
.handoff-staging/
.handoff-prev/
.quartz.offline.yaml

# The link-graph index the Quartz plugins read, regenerated before every build.
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

  // Never overwrite: the project owns this file once it exists, and it is
  // tracked. But leaving it alone silently is not the same thing — a project
  // adopting awt with a .gitignore from the old tooling ignores none of
  // node_modules, and finds out by committing hundreds of MB. Say what is
  // missing instead.
  if (fs.existsSync(file)) {
    const missing = gitignoreGaps(file)
    if (missing.length === 0) return "complete"
    say(
      `\n${shown} exists and was left alone. It does not ignore\n` +
        `${missing.length} thing${missing.length === 1 ? "" : "s"} this bootstrap creates. Append:\n\n` +
        missing.map((line) => `    ${line}`).join("\n"),
    )
    return "incomplete"
  }

  fs.writeFileSync(file, GITIGNORE)
  say(`wrote ${shown}; commit it`)
  return "written"
}

function relink(linkPath, target) {
  if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
    fs.rmSync(linkPath, { recursive: true, force: true })
  }
  fs.symlinkSync(target, linkPath)
}

/** Where Quartz actually lives once bun has installed it. */
export function quartzDir(site) {
  return path.join(site, "node_modules", "quartz")
}

function wireSymlinks(site) {
  const quartz = quartzDir(site)

  // Quartz reads quartz.config.yaml AND ./package.json from its own working
  // directory, so the config has to be reachable from inside node_modules/quartz.
  // What it reaches is the derived file, rewritten before every build; the
  // project's own tracked file, when it has one, is that derivation's base.
  relink(path.join(quartz, "quartz.config.yaml"), `../../${DERIVED_CONFIG}`)

  // The four plugins this toolbox used to link per project are one plugin now,
  // named by absolute path in the derived config; Quartz symlinks a local source
  // into .quartz/plugins itself and re-links it by real path on every build. What
  // is left of the old wiring is removed so nothing stale can be read by mistake.
  for (const name of OLD_LINKS) {
    fs.rmSync(path.join(site, "node_modules", name), { recursive: true, force: true })
    fs.rmSync(path.join(quartz, ".quartz", "plugins", name), { recursive: true, force: true })
  }
}

function bunInstall(site) {
  // Heuristic, not a guarantee: a first install for this project is the
  // common case that is actually slow (network, no warm bun cache yet for
  // this commit on this machine). A node_modules/quartz already present
  // means bun is verifying an existing tree, which is fast — narrating that
  // every time `serve` starts would be noise for no reason.
  const firstInstall = !fs.existsSync(quartzDir(site))
  if (firstInstall) {
    say("installing Quartz (this can take a few minutes on a cold cache) ...")
  }
  const result = spawnSync("bun", ["install", "--silent"], {
    cwd: site,
    stdio: ["ignore", "ignore", "inherit"],
  })
  if (result.status !== 0) die("bun install failed")
}

/**
 * Ensure this site's Quartz install is present, wired, and current with what
 * is already committed — the safe part, with no project decision left to
 * make. `serve` and `publish` call this instead of refusing outright when
 * something is merely missing or stale.
 *
 * Refuses via the caller's own `die`, so each CLI keeps its own exit code —
 * same convention as `requireProjectRoot`.
 */
export function ensureQuartz(site, die) {
  if (!fs.existsSync(path.join(site, "package.json"))) {
    die(
      `no ${path.join(site, "package.json")}; this project's Quartz install has never been set up.\n` +
        "Run `awt site setup` first.",
    )
  }

  const toolboxPin = readToolboxPin()
  const projectPin = readProjectPin(site)
  if (projectPin && projectPin !== toolboxPin) {
    say(
      `note: this project is pinned to Quartz ${projectPin.slice(0, 12)}; the toolbox now ships ` +
        `${toolboxPin.slice(0, 12)}. Run \`awt site setup\` to accept the update.`,
    )
  }

  bunInstall(site)
  wireSymlinks(site)
}

export function bootstrap(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      // No default: an absent --site means "find the project", which is not the
      // same as "look for ./site". parseArgs cannot tell a default from a value.
      site: { type: "string" },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  })
  // Setting up installs Quartz, so it narrates for minutes on a cold cache.
  // Under --json that goes to stderr and stdout carries the one document.
  if (values.json) narrateTo(process.stderr)

  // The project's own site directory is created when it is not there yet: with
  // the config derived, an empty directory is all a new wiki's site starts as.
  // A directory named outright has to exist, since a typo would otherwise be
  // created rather than refused.
  const site = values.site
    ? path.resolve(values.site)
    : path.join(requireProjectRoot(die), "site")
  if (values.site && (!fs.existsSync(site) || !fs.statSync(site).isDirectory())) die(`no site directory at ${site}`)
  if (!fs.existsSync(site)) {
    fs.mkdirSync(site, { recursive: true })
    say(`created ${path.relative(process.cwd(), site)}`)
  }

  const pin = readToolboxPin()
  const gitignore = writeGitignore(site)

  if (values.force) {
    const nodeModules = path.join(site, "node_modules")
    if (fs.existsSync(nodeModules)) {
      say(`removing ${nodeModules}`)
      fs.rmSync(nodeModules, { recursive: true, force: true })
    }
  }

  // Writing package.json is the one deliberate act in here: the first time,
  // it is what "this project builds with Quartz" means; after that, it is
  // accepting a pin the toolbox has since moved past. Neither happens from
  // ensureQuartz, on purpose — see that function's own comment.
  const existingPin = readProjectPin(site)
  let pinAction = "unchanged"
  if (!existingPin) {
    writePackageJson(site, pin)
    pinAction = "written"
  } else if (existingPin !== pin || values.force) {
    writePackageJson(site, pin)
    if (existingPin !== pin) say(`updated the Quartz pin: ${existingPin.slice(0, 12)} -> ${pin.slice(0, 12)}`)
    pinAction = "updated"
  }

  ensureQuartz(site, die)

  say("\nready. Next:\n    awt site serve       dev server\n    awt site publish     release build into site/release")
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, site, pin, pinAction, gitignore }, null, 1)}\n`,
    )
  }
  return 0
}

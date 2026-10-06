/**
 * What `awt site publish --if-stale` needs to decide whether to build: whether a release for the
 * target exists, whether any note is newer than the moment its build began, and a lock so two
 * triggers do not build into the same release at once.
 *
 * The comparison is against the release's own record, not the link index. `awt site serve` re-emits
 * the index on every save, so an index newer than the notes says nothing about whether a release was
 * built from them; the record is written only by a publish.
 */
import fs from "node:fs"
import path from "node:path"

import { BUILD, ensureBuildDir } from "./layout.js"

export const LOCK = ".publish.lock"

/** A build takes seconds. A lock this old belongs to a process that died holding it. */
export const LOCK_STALE_MS = 5 * 60 * 1000

/** The newest modification time among the `.md` files under `wiki`, in ms, or 0 for none. */
export function newestNote(wiki) {
  let newest = 0
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue
      const f = path.join(dir, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.name.endsWith(".md")) {
        try {
          newest = Math.max(newest, fs.statSync(f).mtimeMs)
        } catch {
          // gone between the listing and the stat: it is not newer than anything
        }
      }
    }
  }
  walk(wiki)
  return newest
}

/** When the release at `out` began building, from its record, or null if it has no readable one. */
export function builtAt(out, recordFile) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(out, recordFile), "utf8"))
    const at = Date.parse(record.builtAt)
    return Number.isNaN(at) ? null : at
  } catch {
    return null
  }
}

/**
 * `unbuilt`: no release for this target, which `--if-stale` never makes a first of.
 * `fresh`: no note is newer than the release's build.
 * `stale`: at least one is.
 */
export function staleness({ wiki, out, recordFile }) {
  const at = builtAt(out, recordFile)
  if (at === null) return { state: "unbuilt", builtAt: null, newest: 0 }
  const newest = newestNote(wiki)
  return { state: newest > at ? "stale" : "fresh", builtAt: at, newest }
}

/**
 * Take the publish lock for `site`, or return null if another publish holds it. A directory, because
 * making one fails if it exists, atomically, on every platform this runs on. The result releases it.
 */
export function takeLock(site, { now = Date.now() } = {}) {
  ensureBuildDir(site)
  const dir = path.join(site, BUILD, LOCK)
  const make = () => {
    try {
      fs.mkdirSync(dir)
      return true
    } catch (e) {
      if (e.code === "EEXIST") return false
      throw e
    }
  }
  if (!make()) {
    let held
    try {
      held = fs.statSync(dir).mtimeMs
    } catch {
      return null
    }
    if (now - held < LOCK_STALE_MS) return null
    fs.rmSync(dir, { recursive: true, force: true })
    if (!make()) return null
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    fs.rmSync(dir, { recursive: true, force: true })
  }
  // `die` ends the process with process.exit, which a `finally` does not survive.
  process.once("exit", release)
  return release
}

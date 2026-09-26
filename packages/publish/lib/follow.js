/**
 * Keeping the index current while a dev server runs.
 *
 * `awt site serve` emits the index once before Quartz starts, and the awt
 * plugin refuses to compare a build against an index older than the notes. So
 * without this the first edit made every rebuild fail, and the server went on
 * serving the page as it was before the edit.
 *
 * **Two watchers react to the same save, and neither can be ordered before the
 * other.** Quartz's waits for the write to settle (250 ms) and then debounces
 * (100 ms); this one fires sooner, but reading the wiki can take longer than
 * that head start. So the ordering is not won here. It is settled in the
 * plugin, which, when the server was started by this command, waits for an
 * index that covers the notes instead of throwing — `FOLLOWING` below is how it
 * knows. What this side owes it is an index that is eventually current, and an
 * mtime that never overstates what it covers: `emit` stamps the file with the
 * time it *started* reading, so an edit that lands mid-read leaves it stale and
 * the follow-up emit is waited for.
 *
 * **What counts as a change is what the plugin's staleness check can see**: any
 * entry outside a dot-directory. A note's mtime moves on an edit, and a
 * directory's moves when something in it is added, removed or renamed — which
 * covers a deleted note, whose own mtime is gone with it. A dot-*file* counts
 * too, because creating one (an editor's swap file) moves its directory's mtime
 * all the same; skipping it would leave the plugin waiting for an emit that
 * never comes. Inside `.obsidian/` and its kind nothing the check reads moves.
 */
import fs from "node:fs"

/** Set in the dev server's environment: "an index is on its way, wait for it". */
export const FOLLOWING = "AWT_INDEX_FOLLOWS"

/** Whether a changed path, relative to the notes, is one the index could depend on. */
export function counts(relative) {
  if (!relative) return true
  const segments = relative.split(/[\\/]/)
  return !segments.slice(0, -1).some((segment) => segment.startsWith(".") || segment === "node_modules")
}

/**
 * Watch `notesDir` and call `emit` after each burst of changes, never two at
 * once: a change during an emit schedules exactly one more. `emit` may throw;
 * the error is reported and the watch goes on, because the next save may fix
 * whatever broke. Returns a function that stops watching.
 */
export function followNotes(notesDir, emit, {settle = 50, report = console.error} = {}) {
  let timer = null
  let running = false
  let again = false
  let closed = false

  const run = async () => {
    timer = null
    if (closed) return
    if (running) {
      again = true
      return
    }
    running = true
    try {
      await emit()
    } catch (error) {
      report(`awt: could not re-emit the index: ${error?.message ?? error}`)
    } finally {
      running = false
    }
    if (again && !closed) {
      again = false
      schedule()
    }
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, settle)
  }

  const watcher = fs.watch(notesDir, {recursive: true}, (_event, filename) => {
    if (counts(filename ? String(filename) : "")) schedule()
  })
  watcher.on("error", (error) => report(`awt: stopped watching ${notesDir}: ${error.message}`))

  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    watcher.close()
  }
}

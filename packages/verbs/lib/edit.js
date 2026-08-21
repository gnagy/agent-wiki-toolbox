/**
 * The one write path (toolbox decision 19), with the concurrency model of
 * decision 20 built into it.
 *
 * **Nothing is locked and nothing blocks.** Several agents edit one wiki at once,
 * and the toolbox is deliberately not the only writer — so every file is re-hashed
 * against what we read immediately before it is written, and a file that moved
 * under us is **skipped and reported, never overwritten**. The gap that matters is
 * read-to-write — seconds or minutes while an agent thinks — and that is the one
 * this closes; the microseconds between the final hash and the `rename()` remain.
 *
 * A verb can therefore finish partially, which is why every verb has to be
 * re-runnable: re-running is how a partial completion is finished.
 */
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import process from 'node:process'

const hash = (source) => createHash('sha256').update(source).digest('hex')

/**
 * A batch of file operations that are staged in memory and applied at the end. The
 * batch is not a transaction — it cannot be, without the lock decision 20 refuses —
 * so what it guarantees is per-file: each file is either written from the bytes we
 * read, or left alone and named in the report.
 */
export function createEdit(root) {
  const loaded = new Map()
  const pending = new Map()

  function absolute(path) {
    return join(root, path)
  }

  function load(path) {
    if (loaded.has(path)) return loaded.get(path)
    const source = readFileSync(absolute(path), 'utf8')
    const entry = {source, hash: hash(source)}
    loaded.set(path, entry)
    return entry
  }

  return {
    root,
    load,

    exists(path) {
      return existsSync(absolute(path))
    },

    /**
     * What a verb should read: the staged content if this file has already been
     * edited in this batch, the bytes on disk otherwise. A verb that rewrites one
     * file twice — `mergeFiles` repointing links to two different sources — would
     * otherwise parse the original the second time and throw away the first edit.
     */
    current(path) {
      return pending.get(path)?.source ?? load(path).source
    },

    /** Replace a file's contents. `source` must already be serialized output. */
    update(path, source) {
      load(path)
      pending.set(path, {kind: 'update', path, source})
    },

    /** Write a file that does not exist yet. */
    create(path, source) {
      pending.set(path, {kind: 'create', path, source})
    },

    remove(path) {
      load(path)
      pending.set(path, {kind: 'remove', path})
    },

    /** Move a file without rewriting it: content the verb did not change is not re-serialized. */
    move(from, to) {
      load(from)
      pending.set(from, {kind: 'move', path: from, to})
    },

    /**
     * Apply everything. Returns what happened, in the shape every verb reports.
     */
    commit({dryRun = false} = {}) {
      const changed = []
      const created = []
      const deleted = []
      const skipped = []

      for (const operation of pending.values()) {
        const {kind, path} = operation
        const expected = loaded.get(path)

        // The re-hash. A file whose bytes moved since we read them belongs to
        // whoever moved them.
        if (expected && kind !== 'create') {
          let current
          try {
            current = readFileSync(absolute(path), 'utf8')
          } catch {
            skipped.push({path, reason: 'gone'})
            continue
          }
          if (hash(current) !== expected.hash) {
            skipped.push({path, reason: 'changed on disk since it was read'})
            continue
          }
        }

        if (kind === 'create' && existsSync(absolute(path))) {
          const current = readFileSync(absolute(path), 'utf8')
          // Re-running a partial completion must finish it, not fail on the half
          // that already succeeded.
          if (current === operation.source) continue
          skipped.push({path, reason: 'already exists with different content'})
          continue
        }

        if (kind === 'move' && existsSync(absolute(operation.to))) {
          skipped.push({path, reason: `${operation.to} already exists`})
          continue
        }

        if (dryRun) {
          if (kind === 'create') created.push(path)
          else if (kind === 'remove') deleted.push(path)
          else if (kind === 'move') created.push(operation.to)
          else changed.push(path)
          continue
        }

        switch (kind) {
          case 'update':
            writeAtomically(absolute(path), operation.source)
            changed.push(path)
            break
          case 'create':
            writeAtomically(absolute(path), operation.source)
            created.push(path)
            break
          case 'remove':
            rmSync(absolute(path))
            deleted.push(path)
            break
          case 'move':
            mkdirSync(dirname(absolute(operation.to)), {recursive: true})
            renameSync(absolute(path), absolute(operation.to))
            deleted.push(path)
            created.push(operation.to)
            break
        }
      }

      return {changed, created, deleted, skipped}
    },
  }
}

/** Temp-and-rename, so no reader ever sees a half-written note. */
function writeAtomically(file, source) {
  mkdirSync(dirname(file), {recursive: true})
  const temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, source)
    renameSync(temporary, file)
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary)
    throw error
  }
}

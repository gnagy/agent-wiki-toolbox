/**
 * `frontmatter` — one command over a note's front matter, read and write.
 *
 * **Front matter and the markdown body are separate domains**, not one document
 * addressed two ways. They have different parsers, different serialisers,
 * different addresses — a key against a node path — and, decisively, unrelated
 * hazards: nothing that can go wrong here resembles escaping a `[[link]]` into
 * prose. So this is its own verb rather than a `metadata` argument riding along on
 * whatever else is being written. Two orthogonal commands compose into every case
 * such an argument would have served.
 *
 * The cost is recorded rather than hidden: "rewrite this section and mark it
 * stable" is two calls, and the second can fail after the first landed. The two
 * do not interfere — editing a key moves no heading — so that is a half-landing
 * and never a wrong edit.
 *
 * Three axes, since front matter has no hierarchy: the operation, the scope it
 * acts at, and the key it names.
 *
 *     read    block     the whole block as data
 *     read    content   one key's value
 *     replace content   set a key's value
 *     replace marker    rename a key, leaving the value where it is
 *     replace block     replace the block wholesale — derived front matter only
 *     delete  content   drop a key
 *     append  content   add to a sequence-valued key
 *     prepend content   the same, at the front
 *
 * **Block scope is the destructive one and says so.** Every other operation goes
 * through `editFrontmatter`, which mutates the author's YAML in place and keeps
 * comments, quoting and flow sequences; block scope is `setFrontmatter`, which
 * reserialises from data and discards all three. That line — an author's front
 * matter against one the toolbox derived — is inherited from `syntax`, not drawn
 * here, and `derived: true` is what a caller has to say out loud before crossing
 * it. Without the flag the operation is refused, so reaching for the wrong scope
 * cannot reformat somebody's note.
 *
 * **Every write is checked against the schema for that path before it lands**,
 * which turns `wiki/schemas/` from an after-the-fact report by `awt fmt --dry-run`
 * into a refusal. It is the same plugin over the same globs — see
 * `frontmatterViolations` — so the verb and the formatter cannot disagree.
 *
 * Failures are coded rather than inferred, because a caller that has to match on
 * prose is a caller that breaks when the prose improves.
 */
import {editFrontmatter, getFrontmatter, sequenceItems, setFrontmatter} from '@agent-wiki-toolbox/syntax'
import {frontmatterViolations, layoutFrom, loadProjectConfig} from '@agent-wiki-toolbox/format'

import {createContext, finish, parseNote, refuse, resolveNotePath, serialize} from './context.js'

const VERB = 'frontmatter'

/** The coded failures. A caller matches on these, never on the sentence beside them. */
export const FRONTMATTER_CODES = {
  KEY_NOT_FOUND: 'FRONTMATTER_KEY_NOT_FOUND',
  KEY_COLLISION: 'FRONTMATTER_KEY_COLLISION',
  NOT_A_SEQUENCE: 'FRONTMATTER_NOT_A_SEQUENCE',
  SCHEMA_VIOLATION: 'FRONTMATTER_SCHEMA_VIOLATION',
  ABSENT: 'FRONTMATTER_ABSENT',
}

const OPERATIONS = new Set(['read', 'replace', 'delete', 'append', 'prepend'])
const SCOPES = new Set(['block', 'content', 'marker'])

/** The pairs the table above allows, and nothing else. */
const ALLOWED = new Set([
  'read/block',
  'read/content',
  'replace/content',
  'replace/marker',
  'replace/block',
  'delete/content',
  'append/content',
  'prepend/content',
])

const fail = (code, message) => refuse(VERB, message, {code})

/**
 * Read or write one note's front matter.
 *
 * `path` is workspace-relative. `operation` and `scope` are the two axes above;
 * `scope` defaults to `content` when a key was named and `block` when none was,
 * which is a convenience of the surface rather than a semantics — every call can
 * state it.
 *
 * `key` names the field, `value` is what to write (for `replace/marker` it is the
 * key's new name), and `derived` is the acknowledgement block scope requires.
 *
 * Returns the verb report every other verb returns, plus `frontmatter` on a read:
 * the whole block for block scope, the one value for content scope.
 */
export async function frontmatter(
  notesDir,
  {path, operation = 'read', scope, key, value, derived = false, workspace, dryRun} = {},
) {
  if (!path) throw refuse(VERB, 'frontmatter needs a path')
  if (!OPERATIONS.has(operation)) {
    throw refuse(VERB, `no such operation "${operation}"; it is one of ${[...OPERATIONS].join(', ')}`)
  }

  const at = scope ?? (key === undefined ? 'block' : 'content')
  if (!SCOPES.has(at)) throw refuse(VERB, `no such scope "${at}"; it is one of ${[...SCOPES].join(', ')}`)
  if (!ALLOWED.has(`${operation}/${at}`)) {
    throw refuse(VERB, `${operation} does not apply at ${at} scope; see the operation table on this verb`)
  }
  if (at !== 'block' && !key) throw refuse(VERB, `${operation} at ${at} scope needs a key`)

  const context = createContext(notesDir, {workspace, dryRun})
  const notePath = resolveNotePath(notesDir, context.workspace, path)
  const notes = []
  if (notePath !== path) notes.push(`read ${path} as ${notePath}`)

  // The same refusal `deleteNote` and `mergeFiles` make about a note that is not
  // there: a verb that reports `ok` for a path nobody has is a verb whose verdict
  // line cannot be read.
  if (!context.edit.exists(notePath)) throw refuse(VERB, `no note at ${notePath}`)

  const tree = parseNote(context, notePath)

  if (operation === 'read') return read(context, tree, {path: notePath, scope: at, key, notes})

  // A write is staged, checked against the schema, and only then committed.
  const staged = apply(tree, {operation, scope: at, key, value, derived})
  if (!staged) {
    // Nothing to do is not a failure and not a write: the note already says what
    // the caller asked for. Reported so a caller can tell it from a change.
    notes.push('front matter already says that; nothing written')
    return finish(VERB, context, {notes})
  }

  const source = serialize(tree)
  const violations = await schemaCheck(notesDir, notePath, source)
  if (violations.length > 0) {
    throw fail(
      FRONTMATTER_CODES.SCHEMA_VIOLATION,
      `the schema for ${notePath} refuses this: ${violations.join('; ')}`,
    )
  }

  context.edit.update(notePath, source)
  return finish(VERB, context, {notes})
}

/** The read half. It writes nothing, so it does not go through the edit batch. */
function read(context, tree, {path, scope, key, notes}) {
  const data = getFrontmatter(tree)

  if (scope === 'block') {
    // A note with no block is answered rather than refused: "there is none" is the
    // true answer to "what does it hold", and null says it without a caller having
    // to catch anything.
    if (data === undefined) notes.push(`${path} has no front matter`)
    return {...finish(VERB, context, {notes}), frontmatter: data ?? null}
  }

  // Asked for one key, though, a missing block is a failed lookup like any other,
  // and the code says which kind it was.
  if (data === undefined) throw fail(FRONTMATTER_CODES.ABSENT, `${path} has no front matter`)
  if (!(key in data)) throw fail(FRONTMATTER_CODES.KEY_NOT_FOUND, `${path} has no ${key}`)
  return {...finish(VERB, context, {notes}), frontmatter: data[key]}
}

/**
 * Stage the edit on the tree. Returns whether anything changed; throws the coded
 * refusal when the note cannot carry the operation at all.
 *
 * The callback distinguishes the two ways an edit does not happen: returning
 * `false` is `editFrontmatter`'s "nothing to do" and reports as a no-op, while a
 * coded refusal is thrown through it and reaches the caller as a failure. A
 * condition that is really a refusal must never be reported as the first.
 */
function apply(tree, {operation, scope, key, value, derived}) {
  if (scope === 'block') {
    // `setFrontmatter` reserialises, so this is the one operation that can lose an
    // author's comments and quoting. The flag is the caller saying the block is
    // the toolbox's to write.
    if (!derived) {
      throw refuse(
        VERB,
        'replacing the block wholesale reserialises it, losing comments, quoting and flow sequences. ' +
          'Pass derived: true if this front matter is the toolbox\'s to write; edit a key instead if it is not.',
      )
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw refuse(VERB, 'replacing the block takes an object')
    }
    const before = getFrontmatter(tree)
    setFrontmatter(tree, value)
    return JSON.stringify(before) !== JSON.stringify(value)
  }

  // Everything below edits the author's YAML in place. A note with no block has
  // nothing to edit, and inventing one is block scope's job.
  const first = tree.children[0]
  if (!first || first.type !== 'yaml') {
    throw fail(
      FRONTMATTER_CODES.ABSENT,
      'this note has no front matter. A block is only ever created by replacing one at block scope, ' +
        'which is derived front matter.',
    )
  }

  return editFrontmatter(tree, (document) => {
    const has = document.has(key)

    if (operation === 'replace' && scope === 'content') {
      // Creating a key is a legitimate set — adding `status` to a note that had
      // none — so a missing key is not a failure here, unlike everywhere else.
      document.set(key, value)
      return
    }

    if (operation === 'replace' && scope === 'marker') {
      if (!has) throw fail(FRONTMATTER_CODES.KEY_NOT_FOUND, `no ${key} to rename`)
      if (typeof value !== 'string' || !value) throw refuse(VERB, 'renaming a key needs the new name')
      if (value === key) return false
      if (document.has(value)) {
        throw fail(FRONTMATTER_CODES.KEY_COLLISION, `${value} is already there; renaming ${key} onto it would lose it`)
      }
      // Through the pair rather than get-set-delete: the value node keeps its own
      // style and its position in the block, so renaming a key is a one-word diff
      // rather than a field that jumped to the bottom reformatted.
      const pair = document.contents.items.find((item) => item.key?.value === key)
      pair.key.value = value
      return
    }

    if (operation === 'delete') {
      if (!has) throw fail(FRONTMATTER_CODES.KEY_NOT_FOUND, `no ${key} to delete`)
      document.delete(key)
      return
    }

    // append / prepend. Not string concatenation and not a special case: `tags`
    // and `sources` are sequences, and `sequenceItems` exists already because
    // `renameTag` needed it.
    if (!has) throw fail(FRONTMATTER_CODES.KEY_NOT_FOUND, `no ${key} to add to`)
    const items = sequenceItems(document, key)
    if (!items) {
      throw fail(FRONTMATTER_CODES.NOT_A_SEQUENCE, `${key} is not a sequence, so there is nothing to add to`)
    }
    const node = document.createNode(value)
    if (operation === 'append') items.items.push(node)
    else items.items.unshift(node)
  })
}

/**
 * What the schema for this path says about the bytes about to be written.
 *
 * The config is found from the notes directory, never from the cwd: this verb is
 * called from a server started wherever the agent happened to be, and from a CLI
 * run from anywhere inside the project.
 */
async function schemaCheck(notesDir, path, source) {
  const {config, filepath} = await loadProjectConfig(notesDir)
  if (!config.schemas || !filepath) return []
  const layout = layoutFrom(config, filepath)
  return frontmatterViolations(source, {
    path,
    config,
    configPath: filepath,
    globBase: layout && !layout.legacy ? layout.notesDir : undefined,
    cwd: notesDir,
  })
}

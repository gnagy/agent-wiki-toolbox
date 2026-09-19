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
 *     append  content   add to a sequence-valued key, creating it if absent
 *     prepend content   the same, at the front
 *     validate block    whether the note satisfies its schema, writing nothing
 *     schema   block    which schema claims this path, and what it says
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
 * **Every write is checked against the schema for that path, and the check
 * reports rather than refuses.** It is the same plugin over the same globs — see
 * `frontmatterViolations` — so the verb and the formatter cannot disagree, and it
 * runs before the bytes land instead of after. What it does not do is stop the
 * write.
 *
 * Every refusal this toolbox makes is about **ambiguity** — which note a stem
 * meant — or about **destruction** — a target that already exists. A schema
 * violation is neither: the caller was unambiguous, the verb knows exactly what to
 * write, and nothing is lost. And a single write is not the unit a schema applies
 * to. Renaming a field across a wiki passes through a state where the old key is
 * gone, the new one is not declared, and `additionalProperties: false` rejects the
 * note — so a refusing verb refuses the edit that was on its way to making things
 * valid. A backfill of a newly-required field has the same shape. A migration is a
 * path through states and one write can only see one of them.
 *
 * So the violation comes back in `violations`, at the moment it is created, and
 * the caller decides. Nothing becomes silent: `validate` answers the same question
 * on demand, and `wiki-docs-stop.sh` asks it of everything a session wrote before
 * the session ends — which covers the routes in that are not this verb.
 *
 * Failures are coded rather than inferred, because a caller that has to match on
 * prose is a caller that breaks when the prose improves.
 */
import {editFrontmatter, getFrontmatter, sequenceItems, setFrontmatter} from '@agent-wiki-toolbox/syntax'
import {
  frontmatterViolations,
  layoutFrom,
  loadProjectConfig,
  readSchema,
  resolveSchemaFor,
} from '@agent-wiki-toolbox/format'

import {createContext, finish, parseNote, refuse, resolveNotePath, serialize} from './context.js'

const VERB = 'frontmatter'

/** The coded failures. A caller matches on these, never on the sentence beside them. */
export const FRONTMATTER_CODES = {
  KEY_NOT_FOUND: 'FRONTMATTER_KEY_NOT_FOUND',
  KEY_COLLISION: 'FRONTMATTER_KEY_COLLISION',
  NOT_A_SEQUENCE: 'FRONTMATTER_NOT_A_SEQUENCE',
  // Reported, never thrown: a violation is an answer the caller acts on, not the
  // verb declining to act. It is kept in the register because `validate` and the
  // write path both name it, and a caller matches on the name either way.
  SCHEMA_VIOLATION: 'FRONTMATTER_SCHEMA_VIOLATION',
  ABSENT: 'FRONTMATTER_ABSENT',
}

const OPERATIONS = new Set(['read', 'validate', 'schema', 'replace', 'delete', 'append', 'prepend'])
const SCOPES = new Set(['block', 'content', 'marker'])

/** The pairs the table above allows, and nothing else. */
const ALLOWED = new Set([
  'read/block',
  // Validation is asked of the note, because a note is what a schema is handed.
  // There is no per-key form: JSON Schema's answer to "is this valid" is about the
  // object, and a key-shaped one would be this verb inventing a second semantics.
  'validate/block',
  // And `schema` is asked of the *path*, which is why it is the one operation here
  // that does not need the note to exist.
  'schema/block',
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
 * Returns the verb report every other verb returns, plus `frontmatter` on a read —
 * the whole block for block scope, the one value for content scope — and
 * `violations` wherever the schema had something to say: on a `validate`, always,
 * and on a write, only when the result does not satisfy the schema. A write
 * carrying violations still landed; `ok` says whether the verb did what it was
 * asked, and on `validate` it is the answer to the question.
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

  // **`schema` is a question about the path, not about the note**, so it is
  // answered for a path nothing has written yet — which is the case it exists for:
  // an agent about to write a note asks what the schema requires before it writes,
  // rather than copying a neighbour and inheriting whatever that got wrong.
  if (operation === 'schema') {
    return whichSchema(notesDir, context, {path: notePath, notes})
  }

  // The same refusal `deleteNote` and `mergeFiles` make about a note that is not
  // there: a verb that reports `ok` for a path nobody has is a verb whose verdict
  // line cannot be read.
  if (!context.edit.exists(notePath)) throw refuse(VERB, `no note at ${notePath}`)

  const tree = parseNote(context, notePath)

  if (operation === 'read') return read(context, tree, {path: notePath, scope: at, key, notes})

  if (operation === 'validate') {
    // The note as it stands, not as it would stand: this writes nothing and
    // serialises only to hand the checker bytes.
    const source = serialize(tree)
    const violations = await schemaCheck(notesDir, notePath, source)
    // **Which schema, as well as whether it passed.** No violations means two
    // unrelated things — the note satisfies its schema, or no schema claims the
    // path at all — and answering both with `valid` is how a note outside the
    // vocabulary goes unnoticed forever: `awt fmt --dry-run` counts it as a file
    // that checked out fine and the Stop pass says nothing either. The resolver
    // separates them, so a caller has three answers rather than two.
    const schema = await schemaFor(notesDir, notePath, source)
    const report = finish(VERB, context, {notes})
    // `ok` answers the question that was asked. For a write it is "did the verb do
    // it"; for a question it is the answer, which is what gives the CLI an exit
    // code worth branching on and `awt check` its precedent. An unclaimed path is
    // not a failure — nothing is wrong with it — so `ok` stays true and `schema`
    // is what says it was never checked.
    return {...report, ok: report.ok && violations.length === 0, schema, violations}
  }

  const staged = apply(tree, {operation, scope: at, key, value, derived, notes})
  if (!staged) {
    // Nothing to do is not a failure and not a write: the note already says what
    // the caller asked for. Reported so a caller can tell it from a change.
    notes.push('front matter already says that; nothing written')
    return finish(VERB, context, {notes})
  }

  const source = serialize(tree)
  // Checked before the write and reported beside it. The write lands either way —
  // see the note at the top of this file for why a schema is not a thing one write
  // can be refused for.
  const violations = await schemaCheck(notesDir, notePath, source)
  if (violations.length > 0) {
    notes.push(
      `written, and the schema for ${notePath} does not accept the result: ${violations.join('; ')}`,
    )
  }

  context.edit.update(notePath, source)
  const report = finish(VERB, context, {notes})
  return violations.length > 0 ? {...report, violations, code: FRONTMATTER_CODES.SCHEMA_VIOLATION} : report
}

/**
 * Which schema claims this path, and what it says.
 *
 * The schema itself, not a summary of it. A reduction to fields, enums and types
 * would be partial by nature — JSON Schema expresses more than any summary can
 * carry — and it would be a second opinion about what a schema means, which is the
 * fault the whole front-matter half is built to avoid. **Matching a path to a
 * schema is the only part a caller cannot do**, because it needs the config and
 * the matching rule; reading JSON Schema, a caller is already better at than a
 * summary would be.
 *
 * **An empty answer means no schema claims the path, and that is all it means.**
 * It does not suggest where the note should have gone. Reporting the declared
 * globs so a caller could see it aimed wrong would be placement enforcement
 * wearing a schema question's clothes.
 */
async function whichSchema(notesDir, context, {path, notes}) {
  // The note's own bytes when there are any, because a local `$schema:` beats the
  // globs — and nothing when there are not, which is correct for a path that does
  // not exist yet.
  const source = context.edit.exists(path) ? context.edit.current(path) : undefined
  const schema = await schemaFor(notesDir, path, source)
  if (!schema) notes.push(`no schema claims ${path}`)
  return {...finish(VERB, context, {notes}), schema, schemaContent: schema ? readSchema(schema) : null}
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
function apply(tree, {operation, scope, key, value, derived, notes}) {
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
    //
    // **Lenient about absence, strict about type.** A key that is not there is
    // created as a one-item sequence, because adding the first tag to a note that
    // has none is the same intent as adding the second — and the report says
    // `created` rather than `appended`, so a mistyped key name is visible instead
    // of inferred from silence. A key holding a scalar is a different failure
    // entirely, and collapsing the two would turn that typo into a field quietly
    // created beside the one that was meant.
    if (!has) {
      document.set(key, [value])
      notes?.push(`${key} was not there; created it holding this one item rather than appending to it`)
      return
    }
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
 * Which schema would be applied to this path, absolute, or null. Same config
 * lookup as the check, so the two cannot disagree about which file is in play.
 */
export async function schemaFor(notesDir, path, source) {
  const {config, filepath} = await loadProjectConfig(notesDir)
  if (!config.schemas || !filepath) return null
  const layout = layoutFrom(config, filepath)
  return resolveSchemaFor(path, {
    config,
    configPath: filepath,
    globBase: layout && !layout.legacy ? layout.notesDir : undefined,
    cwd: notesDir,
    source,
  })
}

/**
 * What the schema for this path says about the bytes about to be written.
 *
 * The config is found from the notes directory, never from the cwd: this verb is
 * called from a server started wherever the agent happened to be, and from a CLI
 * run from anywhere inside the project.
 */
export async function schemaCheck(notesDir, path, source) {
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

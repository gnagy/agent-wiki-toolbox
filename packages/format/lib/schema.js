/**
 * The front-matter schema, asked about one note rather than reported over a tree.
 *
 * `awt fmt --dry-run` already answers this — the same globs, the same schemas, the
 * same plugin — but only after the bytes are on disk. A verb that writes front
 * matter has to ask *before* it lands, so this exposes the question on its own.
 *
 * **It runs the plugin rather than reimplementing it.** A second validator would
 * be a second opinion: a note the verb accepted and `awt fmt --dry-run` then
 * rejected is exactly the confusion the refusal exists to remove, and the only way
 * to be sure the two agree is for them to be one thing. So this builds the check
 * processor, hands it the serialized note under the path the globs are matched
 * against, and keeps the messages the schema rule raised.
 *
 * It also answers **which** schema would be applied, which is the half a caller
 * cannot do for itself: the matching needs the config and the plugin's rule, while
 * reading the schema it names needs neither. See `resolveSchemaFor`.
 *
 * Nothing here reaches `core`: it is handed a path and a string, and the only
 * files it opens are the schemas themselves.
 */
import {existsSync, readFileSync} from 'node:fs'
import {dirname, isAbsolute, join, normalize, relative, resolve as resolvePath} from 'node:path'
import process from 'node:process'

import {minimatch} from 'minimatch'
import {parse as parseYaml} from 'yaml'
import {VFile} from 'vfile'

import {anchorSchemas} from './config.js'
import {buildProcessor} from './processor.js'

/** The rule id `remark-lint-frontmatter-schema` reports under. */
const RULE = 'frontmatter-schema'

/**
 * What the schema for `path` says about `source`, as a list of reasons. Empty when
 * it is clean — and empty when no schema claims the path, which is the ordinary
 * case for a wiki that declares none.
 *
 * `path` is workspace-relative, because that is what the globs are written
 * against and what `cwd` is set to. `config` and `configPath` come from
 * `loadProjectConfig`; `globBase` is the notes directory under a `rootDir` layout
 * and the config's own directory otherwise — the same rule `runFormat` follows,
 * and for the same reason.
 */
export async function frontmatterViolations(source, {path, config = {}, configPath = null, globBase, cwd} = {}) {
  if (!config.schemas || !configPath) return []

  const anchored = anchorSchemas(config, configPath, cwd, globBase ?? undefined)
  const processor = buildProcessor({schemas: anchored.schemas}, 'check')
  const file = new VFile({path, value: source, cwd})

  try {
    await processor.process(file)
  } catch {
    // A processor that threw has said nothing about the schema, and a verb must
    // not read silence as approval — but neither is a broken pipeline a
    // violation of the note's. The messages collected so far are what we have.
  }

  // Only this rule. The check processor also carries the formatting check and the
  // link validator, and neither is this verb's business: refusing a `status: stable`
  // because a table two screens down is unaligned would be a verb reporting
  // somebody else's finding as its own.
  return file.messages.filter((message) => message.ruleId === RULE).map((message) => message.reason)
}

/**
 * Which schema would be applied to `path`, as an absolute path — or null when no
 * schema claims it, which is all that answer means.
 *
 * **This duplicates the matching rule, and that is deliberate rather than
 * accidental.** `remark-lint-frontmatter-schema` matches schemas to paths inside
 * its rule function and exports only the plugin, so there is no matching API to
 * call. The alternative considered and rejected was its `embed` option, which
 * takes a schema object and skips matching: it is a processor-level setting and
 * the whole-wiki run builds one processor for every file, so one schema object
 * cannot serve files that need different schemas. Using `embed` for a single note
 * and globs for the wiki would put the divergence back, relocated — and it would
 * move the loading and `$ref` bundling here too.
 *
 * So the rule is copied, and `schema-agreement.test.js` pins this to what the
 * plugin actually selects rather than to anyone's reading of it. Two behaviours
 * are worth naming, because getting either wrong means this names one file while
 * the check uses another and nothing fails:
 *
 * - **Last match wins.** The plugin loops every schema and every glob and
 *   overwrites the winner, so a later entry beats an earlier one.
 * - **A note's own `$schema:` beats the globs**, outright, and is looked for
 *   first — relative to the note's own directory, falling back to the remark root.
 *
 * `source` is the note's bytes, for that second rule. A path that does not exist
 * yet has no front matter to read, so the globs are the whole answer and omitting
 * it is correct; for a note that does exist the caller passes what it holds.
 *
 * The other inputs are `frontmatterViolations`', so the two ask with the same
 * coordinates and cannot drift apart on the arguments.
 */
export function resolveSchemaFor(path, {config = {}, configPath = null, globBase, cwd, source} = {}) {
  if (!path || !config.schemas || !configPath) return null

  // **`cwd` anchors the globs; `process.cwd()` anchors the note.** They are
  // different bases and that is the plugin's doing, not a choice available here:
  // it is handed a vfile whose `path` is workspace-relative and measures it from
  // wherever the process was started, while `anchorSchemas` writes the globs
  // against the run's cwd and the schema keys against `process.cwd()` precisely so
  // the plugin's own joins land. Using one base for both looks tidier and names
  // the wrong file.
  const remarkCwd = remarkRoot(path)

  // The local association, which wins outright when it is there.
  const declared = declaredSchema(source)
  if (declared) {
    // Resolved against the note's own directory first — read from `process.cwd()`,
    // which is what makes this form depend on where the run started — and against
    // the remark root when nothing is there.
    const fromNote = join(dirname(path), declared)
    return resolvePath(existsSync(fromNote) ? fromNote : join(remarkCwd, declared))
  }

  const anchored = anchorSchemas(config, configPath, cwd ?? process.cwd(), globBase ?? undefined)
  const notePath = relative(remarkCwd, resolvePath(process.cwd(), path))

  let winner = null
  for (const [schemaPath, globs] of Object.entries(anchored.schemas ?? {})) {
    if (!Array.isArray(globs)) continue
    for (const glob of globs) {
      // Last match wins: no `break`, and the assignment is not guarded.
      if (typeof glob === 'string' && minimatch(notePath, normalize(glob))) {
        winner = join(remarkCwd, schemaPath)
      }
    }
  }

  return winner && resolvePath(winner)
}

/** The `$schema` a note declares for itself, or null. Never throws on bad YAML. */
function declaredSchema(source) {
  if (typeof source !== 'string') return null
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (!match) return null
  try {
    const data = parseYaml(match[1])
    return data && typeof data.$schema === 'string' ? data.$schema : null
  } catch {
    return null
  }
}

/**
 * The directory the plugin measures paths against: the nearest `.remarkrc` above
 * the note, and `process.cwd()` when there is none.
 *
 * `awt` ships its remark config in code so a project needs no `.remarkrc`, which
 * makes this the cwd in practice — but a project that adds one moves the base
 * under both the plugin and this, and they have to move together.
 */
const REMARK_CONFIG = [
  '.remarkrc',
  '.remarkrc.json',
  '.remarkrc.yaml',
  '.remarkrc.yml',
  '.remarkrc.mjs',
  '.remarkrc.js',
  '.remarkrc.cjs',
]

function remarkRoot(notePath) {
  let dir = dirname(isAbsolute(notePath) ? notePath : resolvePath(process.cwd(), notePath))
  for (;;) {
    if (REMARK_CONFIG.some((name) => existsSync(join(dir, name)))) return dir
    const parent = dirname(dir)
    if (parent === dir) return process.cwd()
    dir = parent
  }
}

/**
 * The schema at `schemaPath`, parsed, or null when it is not there or not JSON.
 *
 * What is on disk, with its `$ref`s as written. The checker bundles those before
 * validating; a caller reading the schema to find out what a path requires is
 * being handed the file, and resolving references on its behalf would be this
 * summarising a schema — which is the thing the plan says not to do.
 */
export function readSchema(schemaPath) {
  if (!schemaPath) return null
  try {
    return JSON.parse(readFileSync(schemaPath, 'utf8'))
  } catch {
    return null
  }
}

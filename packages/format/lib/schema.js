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
 * Nothing here reaches `core`: it is handed a path and a string.
 */
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

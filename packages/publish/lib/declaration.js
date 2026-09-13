/**
 * The project's `site` declaration, as `cli` hands it over.
 *
 * `publish` may not reach `format`, which owns config discovery, so the CLI
 * reads awt.config.mjs and passes `site` in as one JSON argument — the same
 * arrangement as `--configPort`, with a document instead of a number.
 */
export function readDeclaration(json, die) {
  if (!json) return {}
  try {
    const value = JSON.parse(json)
    if (value && typeof value === "object" && !Array.isArray(value)) return value
  } catch {
    // fall through
  }
  die("--site-config must be a JSON object; `awt site` passes it from awt.config.mjs")
}

/**
 * Lift a project's own settings out of the Quartz config it used to track.
 *
 * Before the toolbox derived the config, every wiki tracked a full
 * `site/quartz.config.yaml`: Quartz's default plus the four `../awt-*` entries
 * plus a handful of the project's own values. `awt site migrate` reads that file
 * and pulls the project's values out as the `site` declaration awt.config.mjs
 * carries now. This is the extraction, pure over the parsed config; the command
 * in `cli` does the reading and writing around it.
 *
 * What is lifted is exactly what four real configs were found to differ in:
 * the title, a base URL that was not localhost, the wiki's prefix and registry
 * from the cross-wiki entry, the note-properties field list, and the footer
 * links. Anything else a project changed in its file is not carried, and the
 * command says so, because the alternative — a diff against Quartz's default,
 * merged forever — is the override mechanism this deliberately does not build
 * until a project asks for it.
 */

/** The links Quartz's own default ships with. */
const STOCK_FOOTER = {
  GitHub: "https://github.com/jackyzha0/quartz",
  "Discord Community": "https://discord.gg/cRFFHYye7t",
}

function sourceOf(entry) {
  const source = entry?.source
  return typeof source === "string" ? source : (source?.repo ?? source?.name ?? "")
}

function entryNamed(config, name) {
  return (config?.plugins ?? []).find((entry) => sourceOf(entry).split("/").pop() === name)
}

/**
 * `{declaration, notes}`: the `site` object to declare, and one line per thing
 * worth telling the person running the migration.
 */
export function extractDeclaration(config) {
  const declaration = {}
  const notes = []
  const configuration = config?.configuration ?? {}

  if (typeof configuration.pageTitle === "string" && configuration.pageTitle.trim()) {
    declaration.title = configuration.pageTitle.trim()
  }

  const baseUrl = String(configuration.baseUrl ?? "").trim()
  if (baseUrl && !/^(https?:\/\/)?(localhost|127\.0\.0\.1)\b/.test(baseUrl)) {
    declaration.baseUrl = baseUrl.replace(/^https?:\/\//, "")
  }

  const crossWiki = entryNamed(config, "awt-cross-wiki")
  if (crossWiki?.options) {
    const { self, registry } = crossWiki.options
    if (self) declaration.self = self
    const others = Object.fromEntries(Object.entries(registry ?? {}).filter(([prefix]) => prefix !== self))
    if (Object.keys(others).length) declaration.registry = others
    if (self && registry?.[self]) notes.push(`the registry entry for "${self}" itself is derived now and was not carried`)
  }

  const properties = entryNamed(config, "note-properties")
  if (Array.isArray(properties?.options?.includedProperties)) {
    declaration.properties = [...properties.options.includedProperties]
  }

  // Quartz's stock footer links were in every config because nobody changed
  // them; they are not a project's choice and are not carried as one.
  const footer = entryNamed(config, "footer")
  const links = footer?.options?.links
  if (links && typeof links === "object") {
    const stock = JSON.stringify(links) === JSON.stringify(STOCK_FOOTER)
    if (stock) notes.push("the footer held Quartz's stock links; declare site.footer to set your own")
    else declaration.footer = { ...links }
  }

  const shadow = entryNamed(config, "awt-links")
  if (shadow && shadow.enabled === false) {
    notes.push("the shadow was off in this project; it is on for every wiki now, which is what the resolver switch needs")
  }
  if (shadow?.options?.failOnDisagreement === false) {
    notes.push("failOnDisagreement: false has no equivalent; a disagreement fails the build everywhere now")
  }

  return { declaration, notes }
}

/**
 * The declaration as a JavaScript object literal, indented for insertion into
 * `export default { … }`. JSON is valid JavaScript, and keys stay quoted where
 * they need to be.
 */
export function renderDeclaration(declaration, indent = "  ") {
  const body = JSON.stringify(declaration, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : indent + line))
    .join("\n")
  return `${indent}site: ${body},`
}

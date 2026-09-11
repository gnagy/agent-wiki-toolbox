/**
 * Where a command's running commentary goes.
 *
 * `--json` means stdout carries one document and nothing else. These two commands
 * narrate as they work — a release build says what it is doing for a couple of
 * minutes before it says what it did — so under `--json` the commentary moves to
 * **stderr** rather than being suppressed. It is still what a person watching
 * needs, and `awt site publish --json | jq` still parses.
 *
 * One module-level stream, because one command runs per process. Routing it per
 * call would mean threading a flag through `verify`, `swap`, `toFileUrls` and the
 * offline pass, none of which have anything to say about output format.
 */
let stream = process.stdout

/** Send the commentary somewhere other than stdout, for the rest of this process. */
export function narrateTo(target) {
  stream = target
}

/** One line of commentary. No argument is a blank line, as `console.log()` was. */
export function say(line = "") {
  stream.write(`${line}\n`)
}

/** Part of a line, for the `building ... ok` that finishes on the next call. */
export function sayPart(text) {
  stream.write(text)
}

#!/usr/bin/env bun
/**
 * `awt`: one binary, everything a subcommand. `awt --help` is generated from the
 * command table, and so is the one group's own help.
 *
 * Dispatch is two levels deep at most. A group is a namespace, not an alias — the
 * flat `awt serve` is gone rather than kept working — and its options are declared
 * once on the group and inherited by its subcommands, which is what `WORKSPACE_OPTION`
 * being spread into fourteen entries was doing by copy-paste.
 *
 * **An inherited option comes after the full path**: `awt site publish --wiki x`,
 * never `awt site --wiki x publish`. Accepting both means parsing options before
 * knowing which command's option map to parse against, which is where a
 * hand-rolled dispatcher earns its bugs.
 */
import {parseArgs} from 'node:util'
import process from 'node:process'

import {COMMANDS, COMMON_OPTIONS, GROUPS, SECTIONS, commandPath, optionsFor, version} from '../lib/commands.js'

const flat = new Map(COMMANDS.filter((command) => !command.group).map((command) => [command.name, command]))
const groups = new Map(GROUPS.map((group) => [group.name, group]))
const membersOf = (name) => COMMANDS.filter((command) => command.group === name)

/**
 * The command list, in sections.
 *
 * Seventeen commands used to be listed in no order at all, with `index` between
 * `check` and `search`, and the common-options block carried a prose footnote
 * saying three of them took different flags. A section heading says both, and a
 * group is one line however many subcommands it has.
 */
function overview() {
  const entries = []
  for (const section of SECTIONS) {
    const inSection = COMMANDS.filter((command) => command.section === section)
    if (inSection.length === 0) continue
    const seen = new Set()
    const rows = []
    for (const command of inSection) {
      if (!command.group) {
        rows.push([command.name, command.summary, null])
        continue
      }
      if (seen.has(command.group)) continue
      seen.add(command.group)
      const group = groups.get(command.group)
      rows.push([group.name, group.summary, membersOf(group.name).map((one) => one.name).join(' · ')])
    }
    entries.push([section, rows])
  }
  const width = Math.max(...entries.flatMap(([, rows]) => rows.map(([name]) => name.length)))
  return [
    'awt: one toolbox for a wikilinked markdown wiki. The link graph, structural',
    '     edits that rewrite links, formatting, and the site build.',
    '',
    'Usage',
    '  awt <command> [options]',
    '  awt <command> --help',
    '',
    'Commands',
    ...entries.flatMap(([section, rows]) => [
      `  ${section}`,
      ...rows.flatMap(([name, summary, members]) => {
        const lines = [`    ${name.padEnd(width)}  ${summary}`]
        if (members) lines.push(`    ${''.padEnd(width)}  ${members}`)
        return lines
      }),
      '',
    ]),
    'Common options',
    ...COMMON_OPTIONS.flatMap(option),
    "  -h, --help           this, or a command's usage",
    '  -v, --version        what is installed',
    '',
  ].join('\n')
}

/** One `Common options` entry, the same shape wherever it is printed. */
function option({flags, text, note}) {
  const lines = [`  ${flags.padEnd(19)}  ${text}`]
  if (note) lines.push(`  ${''.padEnd(19)}  ${note}`)
  return lines
}

/** A group's own help: what it is, what is under it, and the options it hands down. */
function groupUsage(group) {
  const members = membersOf(group.name)
  const width = Math.max(...members.map((command) => command.name.length))
  return [
    `${group.name}: ${group.summary}`,
    '',
    'Usage',
    `  awt ${group.name} <command> [options]`,
    '',
    'Commands',
    ...members.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    'Group options, taken by every command above that can act on them',
    ...Object.keys(group.options).flatMap((name) => option({flags: `    --${name} PATH`, text: group.text[name]})),
    '',
  ].join('\n')
}

/**
 * A command's own help: what is particular to it, then whichever of the common
 * options it actually declares.
 *
 * The second half is **generated from that command's option map**, so a usage line
 * can be read as complete. Hand-written into the usage strings, the common options
 * went three ways at once — `--workspace` shown by four of the fourteen commands
 * that take it, `--json` by four of eleven, `--dry-run` by none of seven — and a
 * reader who took a usage line at its word concluded `search` has no `-w`.
 */
function usage(command) {
  const declared = Object.keys(optionsFor(command))
  const common = COMMON_OPTIONS.filter((entry) => declared.includes(entry.name))
  const group = groups.get(command.group)
  const inherited = group
    ? Object.keys(group.options).filter((name) => !command.declines?.includes(name))
    : []
  return [
    `${commandPath(command).join(' ')}: ${command.summary}`,
    '',
    'Usage',
    `  ${command.usage}`,
    // What a usage line cannot carry: how --offline differs from a release, what
    // .release-prev is for, where the ports come from. It used to live in the
    // publish package's own --help, which nothing could reach — awt intercepts
    // --help, and only `cli` ships a binary — so it drifted where no one saw it.
    ...(command.notes?.length ? ['', ...command.notes.map((line) => (line ? `  ${line}` : ''))] : []),
    ...(inherited.length
      ? ['', `From the ${group.name} group`, ...inherited.flatMap((name) => option({flags: `    --${name} PATH`, text: group.text[name]}))]
      : []),
    ...(common.length ? ['', 'Common options', ...common.flatMap(option)] : []),
    '',
  ].join('\n')
}

/**
 * What to say when `parseArgs` refuses an option.
 *
 * Node's own text for an unknown one ends in advice about `--`: place a positional
 * starting with a dash at the end, *as in `-- "-w"`*. That is advice for someone
 * with a **file** called `-w`, and it is the one message a person who typed
 * `-w` meaning the workspace is guaranteed to be shown — following it looks for a
 * file by that name. `-w` is on every command that works on a wiki, so being
 * refused it is a real question about this command, and this answers that instead.
 * Every other option keeps Node's wording, which is right for a typo.
 */
function parseErrorMessage(error, command) {
  const [, flag] = /Unknown option '([^']+)'/.exec(error.message) ?? []
  if (flag !== '-w' && flag !== '--workspace') return error.message

  const declared = Object.keys(optionsFor(command)).map((option) => `--${option}`)
  const path = commandPath(command).join(' ')
  if (declared.includes('--wiki')) {
    return `${path} takes --wiki and --site, not -w/--workspace.`
  }
  return `${path} does not take -w/--workspace.` + (declared.length ? ` It takes ${declared.join(', ')}.` : '')
}

const argv = process.argv.slice(2)
const [name, ...afterName] = argv

if (!name || name === '--help' || name === '-h') {
  process.stdout.write(overview())
  process.exit(name ? 0 : 1)
}
if (name === '--version' || name === '-v') {
  process.stdout.write(`${version()}\n`)
  process.exit(0)
}

let command = flat.get(name)
let rest = afterName

const group = groups.get(name)
if (group) {
  const [sub, ...afterSub] = afterName
  if (!sub || sub === '--help' || sub === '-h') {
    // Bare `awt site` lists what is under it and exits non-zero, the way bare
    // `awt` does. Asked for by --help, the same text is an answer, so exit 0.
    process.stdout.write(groupUsage(group))
    process.exit(sub ? 0 : 1)
  }
  command = membersOf(name).find((entry) => entry.name === sub)
  if (!command) {
    const hint = sub.startsWith('-')
      ? `\n  Options come after the command: awt ${name} <command> ${sub} …\n`
      : '\n'
    process.stderr.write(`awt ${name}: no such command "${sub}"${hint}\n${groupUsage(group)}`)
    process.exit(2)
  }
  rest = afterSub
}

if (!command) {
  process.stderr.write(`awt: no such command "${name}"\n\n${overview()}`)
  process.exit(2)
}

const path = commandPath(command).join(' ')
if (rest.includes('--help') || rest.includes('-h')) {
  process.stdout.write(usage(command))
  process.exit(0)
}

let parsed
try {
  parsed = parseArgs({args: rest, allowPositionals: true, options: optionsFor(command)})
} catch (error) {
  process.stderr.write(`awt ${path}: ${parseErrorMessage(error, command)}\n\n${usage(command)}`)
  process.exit(2)
}

try {
  const code = await command.run(parsed)
  if (code !== null) process.exitCode = code ?? 0
} catch (error) {
  process.stderr.write(`awt ${path}: ${error.message}\n`)
  process.exitCode = 1
}

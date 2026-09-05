#!/usr/bin/env node
/**
 * `awt`: one binary, everything a subcommand. `awt --help` is generated from the
 * command table.
 */
import {parseArgs} from 'node:util'
import process from 'node:process'

import {COMMANDS, COMMON_OPTIONS, version} from '../lib/commands.js'

const byName = new Map(COMMANDS.map((command) => [command.name, command]))

function overview() {
  const width = Math.max(...COMMANDS.map((command) => command.name.length))
  return [
    'awt: one toolbox for a wikilinked markdown wiki. The link graph, structural',
    '     edits that rewrite links, formatting, and the site build.',
    '',
    'Usage',
    '  awt <command> [options]',
    '  awt <command> --help',
    '',
    'Commands',
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    'Common options',
    ...COMMON_OPTIONS.flatMap(option),
    '  -h, --help           this, or a command\'s usage',
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
  const declared = Object.keys(command.options ?? {})
  const common = COMMON_OPTIONS.filter((entry) => declared.includes(entry.name))
  return [
    `${command.name}: ${command.summary}`,
    '',
    'Usage',
    `  ${command.usage}`,
    // What a usage line cannot carry: how --offline differs from a release, what
    // .release-prev is for, where the ports come from. It used to live in the
    // publish package's own --help, which nothing could reach — awt intercepts
    // --help, and only `cli` ships a binary — so it drifted where no one saw it.
    ...(command.notes?.length ? ['', ...command.notes.map((line) => (line ? `  ${line}` : ''))] : []),
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

  const declared = Object.keys(command.options ?? {}).map((option) => `--${option}`)
  if (declared.includes('--wiki')) {
    return `${command.name} takes --wiki and --site, not -w/--workspace.`
  }
  return (
    `${command.name} does not take -w/--workspace.` +
    (declared.length ? ` It takes ${declared.join(', ')}.` : '')
  )
}

const [name, ...rest] = process.argv.slice(2)

if (!name || name === '--help' || name === '-h') {
  process.stdout.write(overview())
  process.exit(name ? 0 : 1)
}
if (name === '--version' || name === '-v') {
  process.stdout.write(`${version()}\n`)
  process.exit(0)
}

const command = byName.get(name)
if (!command) {
  process.stderr.write(`awt: no such command "${name}"\n\n${overview()}`)
  process.exit(2)
}
if (rest.includes('--help') || rest.includes('-h')) {
  process.stdout.write(usage(command))
  process.exit(0)
}

let parsed
try {
  parsed = parseArgs({args: rest, allowPositionals: true, options: command.options ?? {}})
} catch (error) {
  process.stderr.write(`awt ${name}: ${parseErrorMessage(error, command)}\n\n${usage(command)}`)
  process.exit(2)
}

try {
  const code = await command.run(parsed)
  if (code !== null) process.exitCode = code ?? 0
} catch (error) {
  process.stderr.write(`awt ${name}: ${error.message}\n`)
  process.exitCode = 1
}

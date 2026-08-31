#!/usr/bin/env node
/**
 * `awt` — one binary, everything a subcommand ([[toolbox-decisions]] 22 and 26).
 *
 * `awt --help` lists every operation, generated from the command table, so the
 * acceptance test for this milestone holds by construction rather than by anyone
 * remembering to update a help string.
 */
import {parseArgs} from 'node:util'
import process from 'node:process'

import {COMMANDS, version} from '../lib/commands.js'

const byName = new Map(COMMANDS.map((command) => [command.name, command]))

function overview() {
  const width = Math.max(...COMMANDS.map((command) => command.name.length))
  return [
    'awt — one toolbox for a wikilinked markdown wiki: the link graph, structural',
    '      edits that keep it intact, formatting, and the build that renders it.',
    '',
    'Usage',
    '  awt <command> [options]',
    '  awt <command> --help',
    '',
    'Commands',
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    'Common options',
    `  -w, --workspace DIR  the wiki to work on (default: $AWT_WORKSPACE, else the current directory).`,
    '                       publish, serve and bootstrap-quartz name a wiki and a site separately',
    '      --json           structured output, for a program rather than a person',
    '      --dry-run        on a verb: report what it would do, write nothing',
    '  -h, --help           this, or a command\'s usage',
    '  -v, --version        what is installed',
    '',
  ].join('\n')
}

function usage(command) {
  return [`${command.name} — ${command.summary}`, '', 'Usage', `  ${command.usage}`, ''].join('\n')
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
    return `${command.name} takes --wiki, not -w/--workspace — it works on a wiki and the site built from it, so it names the two separately.`
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

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
    `  -w, --workspace DIR  the wiki to work on (default: $AWT_WORKSPACE, else the current directory)`,
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
  process.stderr.write(`awt ${name}: ${error.message}\n\n${usage(command)}`)
  process.exit(2)
}

try {
  const code = await command.run(parsed)
  if (code !== null) process.exitCode = code ?? 0
} catch (error) {
  process.stderr.write(`awt ${name}: ${error.message}\n`)
  process.exitCode = 1
}

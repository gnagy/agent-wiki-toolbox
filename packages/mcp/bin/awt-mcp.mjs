#!/usr/bin/env node
/**
 * Run the MCP server over stdio.
 *
 *   awt mcp [--allow-writes]                 # the notes come from awt.config.mjs
 *   awt mcp --workspace path [--allow-writes]
 *
 * Nothing is watched and nothing is held open: every call reloads the index, which
 * is a few `stat`s warm. The server may be started before the wiki has any notes.
 */
import {parseArgs} from 'node:util'
import {resolve} from 'node:path'
import process from 'node:process'

import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {resolveLayout} from '@agent-wiki-toolbox/format'

import {createServer} from '../index.js'

const {values} = parseArgs({
  options: {
    workspace: {type: 'string'},
    'allow-writes': {type: 'boolean', default: false},
    name: {type: 'string'},
  },
})

// `--workspace` and `$AWT_WORKSPACE` name the notes outright. With neither, the
// project's own config says where they are.
const explicit = values.workspace ?? process.env.AWT_WORKSPACE
const layout = explicit ? null : await resolveLayout(process.cwd(), {quiet: true})
const server = createServer({
  notesDir: explicit ? resolve(explicit) : (layout?.notesDir ?? process.cwd()),
  rootDir: layout?.rootDir ?? null,
  schemaGlobBase: layout && !layout.legacy ? layout.notesDir : null,
  allowWrites: values['allow-writes'],
  name: values.name,
})

await server.connect(new StdioServerTransport())

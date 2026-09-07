#!/usr/bin/env bun
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

import {createServer, projectTarget} from '../index.js'

const {values} = parseArgs({
  options: {
    workspace: {type: 'string'},
    'allow-writes': {type: 'boolean', default: false},
    name: {type: 'string'},
  },
})

// `--workspace` and `$AWT_WORKSPACE` name the notes outright. With neither, the
// project's own config says where they are -- asked per call, so a wiki created
// after the server started is found, and a directory with no project is refused
// rather than served as an empty wiki.
const explicit = values.workspace ?? process.env.AWT_WORKSPACE
const server = createServer({
  ...(explicit ? {notesDir: resolve(explicit)} : {resolveTarget: () => projectTarget()}),
  allowWrites: values['allow-writes'],
  name: values.name,
})

await server.connect(new StdioServerTransport())

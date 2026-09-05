/**
 * Formatting, on the agent's surface. The write verbs serialise what they write;
 * this covers prose written with other tools. Paths are workspace-relative, like
 * every other tool here.
 */
import {collectStream, loadProjectConfig, runFormat} from '@agent-wiki-toolbox/format'

export async function fmt(notesDir, {paths = [], check = false, globBase = null} = {}) {
  // From the notes directory, never from the cwd: the server's cwd is wherever the
  // agent was started, which has nothing to do with the wiki it was pointed at.
  const {config, filepath} = await loadProjectConfig(notesDir)
  const report = collectStream()

  const result = await runFormat({
    files: paths,
    config,
    configPath: filepath,
    globBase: globBase ?? undefined,
    cwd: notesDir,
    mode: check ? 'check' : 'format',
    color: false,
    streamError: report,
  })

  return {
    ok: result.code === 0,
    mode: check ? 'check' : 'format',
    files: result.files,
    problems: result.problems,
    paths: paths.length ? paths : ['.'],
    config: filepath,
    // Whatever the engine had to say: unformatted files in `check` mode, schema
    // violations, a path that is not there. Empty when everything was clean.
    report: report.text().trimEnd() || null,
  }
}

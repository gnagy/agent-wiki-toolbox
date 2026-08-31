/**
 * Formatting, on the agent's surface.
 *
 * It looks like an exception to the rule that decided this list — *a tool earns its
 * place only if it answers something that cannot be answered by opening a file* —
 * and it is not. Formatting a note is exactly what `Read` and `Write` cannot do:
 * the serialisation is a whole toolchain, and an agent reproducing it by hand is
 * how a wiki ends up with hand-aligned tables that drift on the next edit.
 *
 * **The write verbs are not the gap.** Everything they write goes out through the
 * serializer already ([[toolbox-decisions]] 19). The gap is the prose an agent
 * writes with its own `Write` and `Edit`, which is most of what lands in a wiki and
 * the one path no verb sees.
 *
 * Paths are workspace-relative, like every other tool here, and that is the point
 * rather than a detail: an agent holding `meta/conventions.md` had to know where
 * the wiki sat on disk before it could shell out to `awt fmt`, and a path it has to
 * translate by hand is a path it eventually gets wrong or skips.
 */
import {collectStream, loadProjectConfig, runFormat} from '@agent-wiki-toolbox/format'

export async function fmt(root, {paths = [], check = false} = {}) {
  // From the wiki root, never from the cwd: the server's cwd is wherever the agent
  // was started, which has nothing to do with the wiki it was pointed at.
  const {config, filepath} = await loadProjectConfig(root)
  const report = collectStream()

  const result = await runFormat({
    files: paths,
    config,
    cwd: root,
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

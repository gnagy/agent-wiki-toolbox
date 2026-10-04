/**
 * What the atlas says about a path, as far as a mount goes.
 *
 * The atlas catalogs the workspaces on a machine and the project each belongs to, and `atlas here
 * <path>` answers with every placement around a path, outermost first. It does not list wikis, and its
 * entries carry no mount; what it can give is the project of the outermost workspace that names one,
 * which is what a project's wikis are grouped under (`shelton` for both `shelton-dios` and
 * `photo-cli`, whose own workspaces name none). Nothing here needs the atlas: no `atlas` on the PATH,
 * a machine with no catalog and a path nothing is cataloged at all answer `null`.
 */
import { spawnSync } from "node:child_process"

import { SEGMENT } from "./target.js"

/** The project of the outermost cataloged workspace around `dir` that names one, or null. */
export function atlasProject(dir, { run = spawnSync } = {}) {
  const result = run("atlas", ["here", dir], { encoding: "utf8" })
  if (result.error || result.status !== 0) return null
  const rows = String(result.stdout)
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cells) => cells.length >= 3 && cells[0] === "workspace")
  const named = rows.find((cells) => cells[2] && cells[2] !== "-")
  return named && SEGMENT.test(named[2]) ? named[2] : null
}

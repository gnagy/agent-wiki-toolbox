# Other wikis

Reference file for the `wiki-docs` skill: mounting another project's wiki read-only, referring
into it, and an optional convention for sending it a message. Which wikis a project mounts is
project knowledge.

## Mounts

A mount is a second `awt mcp` server over another project's notes, started without
`--allow-writes`, as an `.mcp.json` entry: `awt mcp -w ../other/wiki/notes --name other`. It
serves the five read tools and `fmt` in `dryRun` only; the seven write verbs are not listed.
`workspace_info` reports `notesDir` and `allowWrites` for each server.

Mounts run one way, down the dependency: the project that already depends on the other mounts
it, and the depended-on project does not mount back. Two wikis mounting each other is a cycle.
Where neither depends on the other, the sibling checkout can be read with ordinary file tools.

## What holds across wikis

1. **A mounted wiki is read-only.** Changes to it are made in its own repository.
2. **Wikilinks do not cross wikis.** An unresolved `[[…]]` is a placeholder in this graph. A
   reference into another wiki is a markdown link whose destination carries a wiki prefix in place
   of a scheme, with the full path, since basenames repeat across wikis:

   ```markdown
   [conventions](otherwiki:meta/conventions.md)
   ```

   `resolve` reports it as `crossWiki`, `check` counts it apart from placeholders, and nothing in the
   graph or the editor resolves it; a rendered site can. The target wiki is not told it is referenced.
3. **Front matter is a vocabulary per wiki.** The same field name can carry different values in
   each. A shared JSON schema holds a vocabulary that wikis share. A fact copied from another wiki
   has a home in OKF's `sources`, with `resource` naming where it came from.

## Messages, optional

A convention that has run between a small number of projects. Nothing in the toolbox reads or
enforces it; it applies only where a project says it does.

- **The receiver opts in** with a `meta/interop.md` note declaring, under *Inbound*, where its
  inbox is and what it accepts, and under *Outbound*, which wikis it mounts. No note, no inbox.

- **The inbox is outside the notes**, `wiki/inbox/` by default, so the graph does not index a
  message. It is not gitignored: an unhandled message is an untracked file, visible in
  `git status` without a commit or push.

- **A message is one file**, `YYYY-MM-DD-<sender>-<slug>.md`:

  ```markdown
  ---
  from: <sending wiki>
  date: <YYYY-MM-DD>
  inbox: <path to the sender's own inbox, as the receiver can reach it>
  about: <uri in the receiving wiki, if it concerns an existing note>
  evidence: <wiki>:<uri>          # where the reasoning lives
  ---

  What is claimed, what would settle it, and what is wanted back, if anything.
  ```

- **Resolving one** means folding it into a note, citing `evidence` under `sources`, then
  deleting the file. Re-read it immediately before folding; senders amend in place.

- **A reply**, when wanted, goes into the inbox the message declared, with `evidence` pointing at
  the note where the decision lives. One round trip is the maximum.

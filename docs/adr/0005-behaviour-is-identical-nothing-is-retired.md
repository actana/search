# Behaviour is identical; nothing is retired

Nothing a user, an agent, a block, an MCP tool, a skill, an app-SDK method, a
connector or a v1 API caller can observe changes in this split. Same ids, same
names, same signatures, **same ranking**. The v1 tag+vector path and the shared
`embedding` table move across as they are. No mode is dropped, no default is
tuned, no "while we're in here" improvement rides along.

This is a constraint on the work, not a description of it. The whole risk of
extracting a retrieval engine is that retrieval quality moves, because a
ranking change is invisible until someone's results get worse and there is no
way to tell a deliberate improvement from an accident that shipped with a
refactor. So the first commits of `packages/search` are a lift: the same files,
under recognisable names, with their tests, with only their imports rewritten.

A **fixture suite** is the evidence. A corpus and a set of queries with their
expected top-5 are captured against Studio before anything moves, copied into
this repo byte for byte, and run against the lifted engine. It is the artefact
that turns "behaviour is identical" from an intention into a check.

## Considered Options

- **Improve while lifting (rejected).** Every known wart is visible while the
  code is in your hands, and fixing one is cheap right up until a user asks why
  an answer changed. Then the cost is an archaeology exercise across a 27,000
  line move.
- **Freeze behaviour but reorganise the files (rejected).** Tempting, and it
  destroys the one review technique that scales to a lift this size: diffing the
  moved file against the original. File names are kept recognisable for exactly
  this reason.
- **Retire the v1 tag+vector path during the move (rejected).** It is the older
  of the two retrieval modes and it has callers. Splitting the service and
  removing a mode at the same time means a caller that breaks cannot tell which
  change broke it.

## Consequences

- Ranking, chunking, clustering and keyword logic change only in a pull request
  that is *about* changing them, with an ADR and fixture evidence.
- Lifted modules keep their names. Where one reached a Studio-only concept — an
  agent, a workspace, an ACL check, a crew token, a connector — the branch is
  cut and the cut is marked in place with a `// lifted:` comment saying what
  went and why. A reviewer can find every one of them with a grep.
- Modules that are *entirely* Studio's do not come: the connector sync engine,
  the agent attachment and its auth, the workflow-executor half of tokenization,
  the inference half of the model catalog.
- The fixture suite runs in-process first and over the REST API afterwards. Both
  must produce the same top-5 as Studio did.
- Studio keeps running its in-process engine for unpaired workspaces until the
  data migration has settled in production. Retirement is a separate, later,
  deliberately gated commit.

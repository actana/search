# Issue tracker: GitHub, plus the in-repo board

Issues and specs (you may know a spec as a PRD) for this repo live as GitHub
issues on `actana/search`. Use the `gh` CLI for all operations.

The **extraction board** is different and deliberately so: the tasks that build
this repo out of Studio live as markdown files under `tasks/`, mirroring the
Studio-side board. That board is a fixed sequence written up front, not a
backlog, and it moves by moving a file.

## The in-repo board

- `tasks/todo/` — not started.
- `tasks/in-progress/` — exactly one task at a time. Move the file here when
  you start it.
- `tasks/done/` — completed. Move the file here and append a one-line
  **Outcome** at the bottom.

`tasks/README.md` holds the ground rules; the Studio-side board holds the
settled decisions that bind both repos.

## GitHub conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate `--label` and `--state` filters.
- **Comment**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run
inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external
PRs as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a GitHub issue — unless the work is part of the extraction sequence, in
which case it is a file under `tasks/`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`, or read the task file under `tasks/`.

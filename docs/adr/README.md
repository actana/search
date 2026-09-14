# Architecture decisions

Numbered, immutable-once-landed records of why the system is shaped the way it
is. If a change contradicts one, say so in the pull request rather than routing
around it. The index with one-line summaries is in
[`../../README.md`](../../README.md#architecture-decisions).

New ADRs take the next free number and follow the existing shape — context, the
considered options, the numbered decisions, consequences.

**Append a clause, never shift one.** Decisions are cited by number from code
comments, from task files and from the Studio-side board; renumbering is the
change that looks tidy and invalidates every reference at once.

The first six were written from plan 14 (`actana.ai/plans/14-actana-search/`)
and record the split itself. They are the decisions a reader needs before any
of the code makes sense.

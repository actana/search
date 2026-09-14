# `actana-search`

The command line for an [actana/search](../../README.md) instance: mint a
pairing code on it, spend one from another machine, register a model endpoint,
and use the knowledge bases it holds.

```bash
actana-search --help
```

## Two machines, one command

Every verb belongs to one end of a pairing, and the help says which.

**On the instance** — these reach it through its admin Unix domain socket at
`$SEARCH_STATE_DIR/admin.sock`, mode 0600 inside a 0700 directory. That socket
has no authentication of its own: reaching it *is* the credential
([ADR 0008](../../docs/adr/0008-the-pairing-code-is-copied-from-control.md) D6),
which is why these only work as the user the service runs as, on the machine the
service runs on. There is deliberately no `--host`.

| | |
|---|---|
| `pair new [--label <n>] [--scope <s>] [--kbs <a,b>] [--ttl <d>]` | mint a one-time code and print it |
| `pair ls [--json]` | pending codes, and the clients already paired |
| `pair revoke <id>` | unpair a client, or cancel a pending code |
| `endpoint add --kind <k> --provider <p> --model <m> --key-stdin` | register a model endpoint with a literal key |
| `endpoint ls [--client <id>] [--json]` | the endpoints this instance knows |

**On a paired machine** — these build an mTLS client from the credential
`pair redeem` stored and go through [`@actana/search`](../sdk/README.md). No
consumer reads a table and there is no second HTTP client in this package.

| | |
|---|---|
| `pair redeem <address> <ticket> [--fingerprint <fp>] [--profile <n>]` | spend a code and store the credential |
| `status [--json]` | is this credential good, and what does it grant |
| `kb ls` / `kb create <name>` / `kb rm <id>` | the knowledge bases |
| `ingest <kb> <file>` | put a document in |
| `query <kb> "<text>" [--top-k <n>] [--keyword-weight <0..1>]` | ask |

### Global flags

| | |
|---|---|
| `--profile <name>` | which stored credential to use. Default: the last paired |
| `--admin-socket <path>` | overrides `SEARCH_ADMIN_SOCKET` and `$SEARCH_STATE_DIR/admin.sock` |
| `--json` | machine-readable output. Every listing honours it |
| `--verbose` | explain the steps, on stderr |
| `-h, --help` | the help; `<noun> --help` for a noun's own |
| `-V, --version` | the protocol version this build speaks |

## Pairing, end to end

On the instance:

```console
$ actana-search pair new --label laptop
Ticket         q7v2k9x4:7K4M-2QPX
CA fingerprint AA:BB:CC:…
Expires        15/09/2026, 12:05:00 (in 5m)
Scope          admin
Endpoint       https://search.internal:7443
Session        q7v2k9x4
```

Read out **both** the ticket and the fingerprint. The client checks the
fingerprint against the certificate the instance presents *before* it sends the
code — that is what makes the first dial verifiable when the client has nothing
pinned yet.

The code is printed once. The instance stores a keyed digest of it, so nothing —
`pair ls` included — can print it again. A lost code is re-minted, not
recovered.

On the machine being paired:

```console
$ actana-search pair redeem search.internal:7443 q7v2k9x4:7K4M-2QPX \
    --fingerprint AA:BB:CC:…
Paired with https://search.internal:7443.
Profile        default
$ actana-search status
```

A private key is generated locally and never sent. What comes back is written to
`~/.actana-search/cli.json`, mode 0600 in a 0700 directory, as a **profile** —
one per instance this machine has paired with, with the most recent as the
default. Pass `--profile` to pair a second instance, or to pick between them.

Omitting `--fingerprint` is not "skip the check": the command refuses with
`fingerprint-unconfirmed` and exits 13, having sent nothing.

## Registering a model endpoint

A knowledge base is bound to an embedding endpoint (required) and an inference
endpoint (optional — without one, keyword extraction is skipped rather than
failed). A standalone instance holds those keys itself, sealed under
`SEARCH_ENCRYPTION_KEY`:

```bash
echo -n "$OPENAI_API_KEY" | actana-search endpoint add \
  --kind embedding --provider openai \
  --model text-embedding-3-small --dimensions 1536 --key-stdin
```

**`--key-stdin` is the only way to pass a key**, and it is a flag rather than a
value on purpose: an API key given as an argument is in `ps`, in the shell
history, and in every process listing on the machine for as long as the command
runs. A pipe is in none of them. There is no `--key`.

The key is sealed on the instance and is never printed back — `endpoint ls`
reports whether a row has one, not what it is.

When a paired client mirrors its own catalog instead (`PUT /v1/endpoints`), its
endpoints appear as `mirrored` and have no key on this side at all: the instance
asks that client's resolver for one per job and forgets it within a minute
([ADR 0004](../../docs/adr/0004-model-endpoints-flow-both-ways.md)). There is
nothing to add by hand.

## Exit codes

| | |
|---|---|
| `0` | it worked |
| `1` | it did not work — the instance refused, a file was unreadable |
| `2` | the command line was wrong |
| `3` | the verb exists and this build cannot do it yet |
| `10`–`21` | `pair redeem` failures, one per reason — see `src/exit-codes.ts` |

`13` (no fingerprint given) and `14` (the fingerprint did not match) both mean
**the code was not sent**. `14` is the loud one: either something is answering
for that address that is not the instance you were told about, or the instance
has been re-issued and your fingerprint is stale.

## What this build cannot do yet

`kb`, `ingest` and `query` call the SDK's typed namespaces, which throw
`not-implemented` until the REST surface lands (TASK-004). The wiring is here
already — profile, client, arguments, output, exit codes — so they start working
when the branches merge, without being touched. Until then they exit `3` with a
sentence saying so. `pair`, `endpoint` and `status` work now.

## Notes

- **Nothing this command prints is a provider key**, and nothing it accepts as an
  argument is one.
- The only runtime dependency is `@actana/search`. Flag parsing, table
  formatting and the admin-socket client are ~400 lines of this package, which
  keeps an install one package deep.
- Node 24. The `bin` shim is plain JavaScript; the TypeScript behind it runs
  under Node's own type stripping, the same way the service does.

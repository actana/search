# The pairing code is copied from Control, and will be lifted into a package

Search's mTLS pairing — the short-code session, the pre-auth gate, the CA and
its CSR signing, the revocation sweep, the client-side handshake — is a **copy**
of actana/control's, file for file, with names changed and storage adapted. It
is not an implementation of the same design. Where Control's code could be taken
unchanged it was taken unchanged, comments included, and every copied file says
at the top which Control file it came from.

[ADR 0003](0003-the-paired-client-is-the-identity.md) already settled *that*
Search would use Control's mechanism. This records what the copy costs, what
must not drift while it exists, and how it ends.

## Context

Search is the **second** user of a pairing handshake that Control has had in
production since its own ADR 0034. Two users is what turns code into a library —
but the lift is a Control-side change to a running product, and doing it first
would have meant designing a package API against one real user and one
hypothetical one. Copying first and extracting afterwards leaves one design
conversation informed by two real users, and in the meantime leaves two copies
rather than three implementations.

The alternative considered and rejected was writing a pairing flow shaped for
Search. ADR 0003 gives the reason: a second implementation of a pre-auth
credential exchange is a second place for it to be wrong, and the failure mode
is not a bad error message.

## Decisions

**D1 — The copy is a copy, and it is marked.** Every file carries a banner
naming its Control origin and the ADR 0034 clause it implements. Where the logic
is identical the comments are Control's too, because a comment that explains why
a check is in a particular order is part of the check. A reviewer comparing the
two should be able to diff them.

**D2 — The wire is byte-identical to Control's, and that is the constraint every
other decision bends around.** `POST /v1/pair/redeem`; request
`{ sessionId, code, client: { label?, platform? }, csr }`; 200 body
`{ endpoint, caCert, clientCert, bearer }`. The type names carry `Search` where
Control's carry `Core`, the JSON does not change, and the failure vocabulary the
SDK throws is Control's string for string. A Studio sidecar built against
`@actana/sdk`'s pairing posts the same bytes at Search.

Two values differ, and neither is a field:

  * **`endpoint` is `https://`, not `wss://`.** A Core's transport is a
    WebSocket; Search's is the HTTPS server the pairing route already answers
    on. The registration blob's decoder refuses the other scheme in both repos,
    for the same reason — a downgraded endpoint is a credential that pins
    nothing.
  * **`bearer` is inert.** Search authenticates on the certificate and reads no
    bearer anywhere (ADR 0003). It is minted with the same computation over the
    same secret and returned because the body is Control's and dropping a field
    is a wire change made in passing. `packages/shared/src/pairing/bearer.ts`
    says so at the code that mints it. The secret is not idle: it keys the
    pairing code digest, which is what stops a copy of `search.pairing_code`
    being a list of enumerable code hashes.

**D3 — Storage is adapted, and the adaptation is the one part that is not a
copy.** Control keeps sessions and paired clients in one JSON file that a daemon
and a one-shot CLI both open. Search keeps them in Postgres
(`search.pairing_code`, `search.paired_client`), because Search may be more than
one process and a code redeemed against one of them must be spent for all of
them. The CA, the server key and the instance secret stay on disk under
`SEARCH_STATE_DIR` (default `~/.actana-search`), which is Control's state-path
pattern.

The swap **strengthens** ADR 0034 D6 rather than weakening it: `consume` is one
conditional `UPDATE … WHERE consumed_at IS NULL … RETURNING`, so two concurrent
redemptions are decided by Postgres instead of by whose `writeFileSync` landed
last. Control's own header concedes that its file store can lose a write across
processes, and that a lost revocation stamp fails open. Here it cannot.

**D4 — The pre-auth surface stays exactly one route wide, and Search's predicate
is *narrower* than Control's.** Control's `isPairingPath` names the `/v1/pair/`
prefix because every route under it is the redeem route. Search adds
`GET /v1/pair/status`, which is authenticated, so the predicate is an exact
pathname. Read as a prefix it would have made `status` reachable without a
certificate — a second pre-auth route acquired by accident, which is what ADR
0034 D2 exists to prevent. `preauth-gate.test.ts` holds this as a named case.

**D5 — There is a second open route, and it is `GET /v1/health`.** This is an
addition to Control's set and is recorded rather than smuggled. It grants
nothing, mutates nothing, reads no client, and answers `{ ok, schemaVersion }` —
which is what a caller learns by dialling the port and reading the certificate
anyway. A health check that needed a credential is a health check the thing that
restarts the process cannot run. The distinction is kept in the names:
`isPairingPath` is the pre-auth surface and stays one route wide; `isOpenPath` is
the wider question the gate asks, and its whole membership is enumerated in a
test. **A third entry is a change to this decision.**

**D6 — Minting moves from a CLI into the service, and what guards it is the
filesystem.** On a Core, `actana pair new` opens the same `pairing.json` the
daemon reads, so the thing standing between an attacker and a pairing code is a
file mode. Search's sessions are in Postgres and its code digest is keyed by a
secret in the state directory, so a CLI doing the same would need the database
credentials *and* the state directory — a second process holding the keys to the
instance. The mint therefore happens in the process that already holds both, and
`packages/search/src/api/admin-server.ts` exposes it on a **Unix domain socket at
`$SEARCH_STATE_DIR/admin.sock`, mode 0600**, inside a directory this process
creates 0700. That is the same guarantee Control has, expressed the same way:
this surface has no authentication of its own, reaching it **is** the credential,
and the filesystem is what decides who can.

> **Amended after review.** The first implementation was a loopback TCP port,
> and it was wrong twice. *Any* process on the host could reach it, containers
> sharing the network namespace included — "loopback" is a weaker claim than it
> sounds in the deployment this product actually has. And a browser tab could
> drive it: the body parser accepted any content type, so a page on any origin
> could `fetch` a simple `POST` at `127.0.0.1:7444` with no preflight and mint a
> code — or, since the response is unreadable cross-origin and irrelevant,
> `POST /admin/pair/revoke` and unpair everything. Both are closed by the socket.
> A loopback port survives as **opt-in** (`SEARCH_ADMIN_PORT`, unset by default)
> for a platform with no Unix sockets, still loopback-only, and hardened against
> the second case: a strict `content-type: application/json`, which is not a
> CORS-simple type and is therefore preflighted into a request this server never
> answers, and an outright refusal of any request carrying `Origin` — which no
> CLI sends and every browser does. The CLI in TASK-005 talks to the socket.

**D7 — Scopes ride on the session, never on the request.** A Search pairing
grants `read`, `write` or `admin` plus an optional list of KB ids (ADR 0003), and
the grant is decided by the operator who minted the code. It is copied onto
`paired_client` at redemption. Nothing a redeeming client sends reaches it — the
same rule the certificate subject already follows in Control.

**D8 — TASK-015 is the exit, and it is named here so the copy has an end.** Once
this is proven in Search, the pairing and certificate code is lifted out of
Control into its own package and both repositories consume it. What it lifts is
the pure half — the code alphabet and its draw, the session rules, the digest,
the audit shape, the certificate helpers, the CSR encoder, the pre-auth gate,
the rate limiter, the wire types — behind a store port that a JSON file and a
Postgres table both satisfy. **Until then, a change to any of it here is a
change that has to be made in Control too, or explained in this record.**

## Consequences

Search pairs the way Control pairs, with the same defences in the same order,
and a reviewer who knows one knows the other. That is the point.

The costs are the ordinary costs of a copy and are named rather than mitigated.
A security fix in Control's pairing does not reach Search on its own; somebody
has to carry it, and until TASK-015 that is a person rather than a build. Two
copies can drift in ways no test in either repository would catch, because
neither one compiles against the other. And a field that is inert here (`bearer`)
is live there, so the two are already not quite the same program — which is
exactly the kind of small divergence a shared package would have refused to
allow.

The mitigations are small and deliberate: the banners, so a reader always knows
where a file came from; the wire types in one import-free module the server and
the client both import, so the two halves *inside* this repository cannot drift;
and the invariant names carried over verbatim from Control's tests, so a
side-by-side comparison of the two suites is a comparison of the same list.

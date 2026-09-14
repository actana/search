# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub:
[**Security → Report a vulnerability**](https://github.com/actana/search/security/advisories/new).
This opens a private advisory visible only to you and the maintainers.

Please include: what you found, the version or commit, how to reproduce it, and
what an attacker gets out of it. A proof of concept helps but is not required
to file.

We aim to acknowledge a report within **3 working days** and to have an
assessment back to you within **10**. Fixes ship in a normal release; the
advisory is published once a fixed version is available, crediting you unless
you would rather stay anonymous.

## Supported versions

Only the **latest release** is supported. There are no backport branches — if
you are on an older tag, the fix is to upgrade.

A **beta** is not a release. The open train is installable and none of it is a
supported version. Report what you find on one anyway: it is the cheapest place
to fix a problem.

## What is in scope

- The **core** — the HTTPS API, the pre-auth gate and its single
  unauthenticated route (`POST /v1/pair/redeem`), the short-code pairing
  session, certificate issuance and revocation, and the scope check applied to
  every other route.
- **Data isolation between paired clients.** A paired client reaching a
  knowledge base, document, chunk, keyword or endpoint belonging to another
  paired client is a vulnerability, not a bug.
- **Credential handling** — the sealing of provider keys with
  `SEARCH_ENCRYPTION_KEY`, and the wired-mode resolver path where Search holds
  a key only for the life of one job and never writes it down.
- **Ingestion of hostile input.** Parsers run on files an attacker may control.
  XXE, zip-bombs, path traversal out of an archive and parser-driven resource
  exhaustion are all in scope.
- The **published SDK** (`@actana/search`) and the CLI.

## What is out of scope

- **A Search instance deliberately started without TLS material**, or with a
  CA and client certificates the operator has copied between machines. The
  certificate is the identity; an operator who shares it has shared the
  identity.
- **The model providers themselves.** Report those to their own vendors.
- **Resource consumption proportional to a request an authorised client made.**
  A paired client with `write` scope can ask for a large ingest; that is the
  product working.
- Findings from automated scanners with no demonstrated impact.

## Dependencies

The dependency surface is deliberately small, and adding to it is the change
most likely to be pushed back on. The rules, enforced in
`pnpm-workspace.yaml` and in review:

- **Exact version pins.** No ranges, anywhere, including transitive overrides.
- **A seven-day release-age gate** (`minimumReleaseAge: 10080`). A version
  published less than a week ago cannot be installed here, so a compromised
  publish has a week to be noticed before it can reach a build.
- **Install scripts are off** except for an explicit `allowBuilds` allow-list.
- **No git dependencies, no tarball URLs, no `file:` outside the workspace.**
- **`--frozen-lockfile` everywhere**, CI included.
- **Prefer vanilla code over adding a dependency.** A hundred lines you own
  beats a package you do not.

## Hardening notes for operators

- Set `SEARCH_ENCRYPTION_KEY` explicitly rather than letting a key be generated
  into the state directory — otherwise a copied volume carries both the sealed
  provider keys and the key that opens them.
- `SEARCH_STATE_DIR` is the instance's identity: the CA, the server
  certificate, and the pairing material. Back it up as secret material, and do
  not copy it to a second instance.
- Give Search its own database role, scoped to the `search` schema. It never
  needs to read anything else, and when it shares a database with Studio it
  should not be able to.
- Give Search its own bucket. Studio never writes to it, and nothing else
  should.

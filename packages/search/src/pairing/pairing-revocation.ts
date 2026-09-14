// What a revoked pairing means to the running service.
//
// **Copied from actana/control `packages/core/src/core-pairing-revocation.ts`**
// (its ADR 0034 D9 and D10), with the store read swapped from a JSON file to a
// Postgres query. ADR 0008 records the copy.
//
// `pair revoke` stamps `revoked_at` on a row. That stamp is a record, not an
// enforcement: the certificate it names is still one this instance's CA signed
// and still completes the handshake. Nothing about revocation is true until
// this module makes it true.
//
// Two halves, answering two questions:
//
//   1. **Is this credential revoked?** — asked at the TLS gate on every
//      request. That is what stops a revoked client coming *back*.
//   2. **What has just been revoked?** — asked on a timer, so that a change
//      made by another process (the admin listener on a second instance, or an
//      operator's SQL) is seen without waiting for a restart.
//
// **Polling, not listening.** A one-second query against a table with a handful
// of rows is a cost this service does not notice, and it is the same code path
// whether the revocation was made here or by another process against the same
// database. The bound it buys is stated plainly: a revoked client is refused
// within {@link REVOCATION_SWEEP_MS} of the stamp, not instantly — and
// immediately when the stamp was made through this process's own admin route,
// which refreshes on the way out.

import { createLogger } from "@actana/search-shared/log";
import { normaliseCertSerial } from "@actana/search-shared/pairing/cert-material";

const logger = createLogger("pairing.revocation");

/** How often the service re-reads the store looking for fresh revocations. */
export const REVOCATION_SWEEP_MS = 1_000;

/**
 * The revoked serials this module reads. `SearchPairingStore` satisfies it.
 *
 * **It must throw rather than answer empty when it cannot read.** That is the
 * whole of {@link PairingRevocations.refresh}'s guarantee: "this instance has
 * revoked nobody" and "this instance cannot tell you who it revoked" must never
 * be the same answer.
 */
export interface RevokedClientsPort {
  /** Every revoked certificate serial, or throw saying why it could not read. */
  revokedCertSerials(): Promise<string[]>;
}

/** The `sub` claim a paired client's bearer carries — `pair:<serial>`. */
export function pairingBearerSubject(certSerial: string): string {
  return `${BEARER_SUBJECT_PREFIX}${certSerial}`;
}

const BEARER_SUBJECT_PREFIX = "pair:";

/** The serial inside a `pair:<serial>` subject, or `null` for anything else. */
export function certSerialFromBearerSubject(sub: string | undefined): string | null {
  if (!sub || !sub.startsWith(BEARER_SUBJECT_PREFIX)) return null;
  const serial = sub.slice(BEARER_SUBJECT_PREFIX.length);
  return serial.length > 0 ? serial : null;
}

/**
 * One spelling of a certificate serial — re-exported, not redeclared.
 *
 * It moved to `@actana/search-shared/pairing/cert-material` when it turned out
 * that revocation was not the only reader: the store writes a serial and the
 * server looks one up, and a second spelling of the same normalisation would
 * have been a second chance for those two to disagree. Re-exported here because
 * Control's module is where a reader looks for it.
 */
export { normaliseCertSerial } from "@actana/search-shared/pairing/cert-material";

/** What one {@link PairingRevocations.refresh} found. */
export type RevocationRefresh =
  /** The store was read. `revoked` is what was newly revoked since last time. */
  | { ok: true; revoked: string[] }
  /** The store could not be read, so every pairing is treated as revoked. */
  | { ok: false; error: string };

/**
 * This instance's revoked serials, re-read from the store on demand.
 *
 * Held as a set rather than re-read per question because the questions are
 * asked on the hot path — every request — and the answers only change when
 * {@link refresh} says so. The sweep is what calls `refresh`, so "how stale can
 * this be" has exactly one answer and it is the sweep interval.
 *
 * **When the store cannot be read, everything is revoked.** Not "nothing is",
 * and not "whatever we happened to know last time": those are both the reading
 * that hands a revoked client its access straight back, and boot — where there
 * is no last time — is exactly when the question is asked.
 */
export class PairingRevocations {
  private readonly clients: RevokedClientsPort;
  private revoked = new Set<string>();
  /**
   * True while the last read failed. Every pairing-issued credential is
   * refused for as long as it is set, and it is cleared by the next successful
   * read so the state is a fact about the store as it is now rather than a
   * latch an operator has to reset.
   */
  private failClosedFlag = false;

  constructor(clients: RevokedClientsPort) {
    this.clients = clients;
  }

  /**
   * Re-read the store.
   *
   * On success, reports the serials revoked **since the last read**, so a
   * caller can act on the new ones without acting on every one it has already
   * handled. On failure, reports why and switches this instance to refusing
   * every pairing-issued credential. That is the fail-closed direction, and it
   * is chosen knowing what it costs: an instance whose database is unreachable
   * stops serving every client it ever paired. The alternative costs more — a
   * read that failed would silently un-revoke every certificate an operator has
   * already taken back.
   */
  async refresh(): Promise<RevocationRefresh> {
    let serials: string[];
    try {
      serials = await this.clients.revokedCertSerials();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (!this.failClosedFlag) {
        logger.error("pairing.revocation.unreadable", { error, effect: "every pairing refused" });
      }
      this.failClosedFlag = true;
      return { ok: false, error };
    }
    this.failClosedFlag = false;
    const fresh: string[] = [];
    for (const serial of serials) {
      const key = normaliseCertSerial(serial);
      if (this.revoked.has(key)) continue;
      this.revoked.add(key);
      fresh.push(serial);
    }
    return { ok: true, revoked: fresh };
  }

  /** Is this instance currently refusing every pairing because it cannot read? */
  isFailClosed(): boolean {
    return this.failClosedFlag;
  }

  /**
   * Is this certificate serial revoked?
   *
   * `null` — no peer certificate at all — is not, even while failing closed.
   * "No certificate" and "a revoked certificate" are different facts and
   * different gates answer them: `clientCertGate` refuses an uncertificated
   * caller everywhere but the pairing endpoint, and that endpoint is the one an
   * operator needs reachable to recover. Answering `true` here would close the
   * only door out of an unreadable store.
   */
  isRevoked(certSerial: string | null | undefined): boolean {
    if (!certSerial) return false;
    if (this.failClosedFlag) return true;
    return this.revoked.has(normaliseCertSerial(certSerial));
  }

  /** Is the pairing this bearer speaks for revoked? */
  isBearerSubjectRevoked(sub: string | undefined): boolean {
    return this.isRevoked(certSerialFromBearerSubject(sub));
  }
}

/** A running sweep. Stopped with the service, like every other timer. */
export type PairingRevocationSweep = { stop(): void };

/**
 * Poll the store and call `onRevoked` whenever what is revoked has changed.
 *
 * `onRevoked` takes no arguments and that is deliberate: the caller re-asks
 * this object about every connection it holds rather than being handed a list.
 * A list would carry only the *newly named* serials, and the change that most
 * needs acting on carries no serials at all — switching to fail-closed revokes
 * every pairing at once.
 *
 * The first read happens immediately and does **not** call back: at boot, every
 * revocation already on file was made against a connection that does not exist
 * any more. What the first read does is seed the set — or, if the store is
 * unreadable, put this instance into fail-closed before it serves its first
 * request, which is the moment the guarantee has to hold.
 */
export function startPairingRevocationSweep(opts: {
  revocations: PairingRevocations;
  onRevoked: () => void;
  intervalMs?: number;
}): PairingRevocationSweep {
  let wasFailClosed = false;
  const seed = opts.revocations.refresh().then(() => {
    wasFailClosed = opts.revocations.isFailClosed();
  });
  const timer = setInterval(() => {
    void seed.then(async () => {
      const result = await opts.revocations.refresh();
      const nowFailClosed = !result.ok;
      // Two things count as a change, and the second is the one a list could
      // not express: fresh serials, or crossing into fail-closed. Crossing back
      // out does not — nothing became revoked by the store becoming readable.
      const enteredFailClosed = nowFailClosed && !wasFailClosed;
      wasFailClosed = nowFailClosed;
      if (result.ok && result.revoked.length > 0) {
        logger.info("pairing.revoked", { certSerials: result.revoked });
      } else if (!enteredFailClosed) {
        return;
      }
      opts.onRevoked();
    });
  }, opts.intervalMs ?? REVOCATION_SWEEP_MS);
  // Never the reason this process stays alive.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// Exit codes, named once.
//
// The first four are Control's `packages/cli/src/exit-codes.ts`, numbers and
// meanings unchanged, because an operator who drives both commands should not
// have to learn that 2 means something different here. The pairing block is
// Control's too, and for the reason its header gives: a wrong code, a spent
// code, a Core that is not answering and a certificate authority that is not
// the one you were read out are four situations with four next actions, and the
// enrollment script running this across a fleet is not going to grep English
// off stderr to tell them apart.
//
// What is **not** copied is Control's `EXIT_LINK_LOST` (125). It exists for a
// command running on the other machine whose connection dropped; every verb
// here is a request and a response.

/** It worked. */
export const EXIT_OK = 0;

/** It did not work: the instance refused, a file was unreadable, a blob was bad. */
export const EXIT_FAILURE = 1;

/** The command line was wrong: unknown verb or flag, missing argument. */
export const EXIT_USAGE = 2;

/**
 * The verb exists and the **instance** cannot do it.
 *
 * Distinct from {@link EXIT_USAGE} on purpose. Every verb here works against
 * the current contract now that TASK-004's REST surface has landed, so what
 * reaches this code is an instance that does not serve a route one of them
 * calls — an older deployment, answering `not-implemented`. A script should be
 * able to tell "that instance is too old" from "you typed it wrong" without
 * reading a sentence.
 */
export const EXIT_UNIMPLEMENTED = 3;

// ─── Pairing, from the client's side ────────────────────────────────────────
//
// One code per failure `@actana/search`'s `SearchPairingError` distinguishes, so
// `redeem` can switch over the SDK's union exhaustively. Numbers are Control's.

/** Nothing answered at the address, or the dial timed out. */
export const EXIT_PAIR_UNREACHABLE = 10;

/** Something answered and it has no pairing route — check it is a Search instance. */
export const EXIT_PAIR_NOT_PAIRABLE = 11;

/** The chain presented had no certificate authority in it. */
export const EXIT_PAIR_NO_CA = 12;

/** No fingerprint was given, so nothing could be compared. **The code was not sent.** */
export const EXIT_PAIR_FINGERPRINT_UNCONFIRMED = 13;

/** The CA presented is not the one read out. **The code was not sent.** */
export const EXIT_PAIR_FINGERPRINT_MISMATCH = 14;

/** The right CA, on an address its certificate does not cover. */
export const EXIT_PAIR_HOSTNAME_MISMATCH = 15;

/** The right CA, and a certificate that is expired or otherwise unusable. */
export const EXIT_PAIR_CERTIFICATE_INVALID = 16;

/** The instance refused the code: wrong, expired, spent, or out of attempts. */
export const EXIT_PAIR_REFUSED = 17;

/** Too many attempts from here, too fast. */
export const EXIT_PAIR_RATE_LIMITED = 18;

/** The instance would not accept the request itself — a bug on this side. */
export const EXIT_PAIR_REJECTED = 19;

/** The instance failed while handling the redemption. Its logs have the reason. */
export const EXIT_PAIR_CORE_ERROR = 20;

/** A 200 that was not a redemption response. */
export const EXIT_PAIR_MALFORMED_RESPONSE = 21;

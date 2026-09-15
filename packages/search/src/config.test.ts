/**
 * The configuration's own refusals — the ones that are about the environment
 * rather than about a value's type.
 *
 * `SEARCH_STATE_DIR` is here because of what it cost. A state directory whose
 * `admin.sock` is longer than `sun_path` is a directory the kernel will not let
 * the admin listener bind, and nothing said so until **step 5 of `boot()`**: the
 * migrations had run, the identity was minted, the API listener was answering
 * `GET /v1/health` with `{"ok":true}`, and the failure was `listen EINVAL …
 * /admin.sock` with no mention of a length. A variable that cannot work is a
 * variable to refuse while nothing is open yet.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, resetConfig } from "./config.ts";
import { SUN_PATH_MAX_BYTES } from "./api/admin-socket.ts";

const SAVED = process.env.SEARCH_STATE_DIR;

beforeEach(() => {
  resetConfig();
});

afterEach(() => {
  if (SAVED === undefined) delete process.env.SEARCH_STATE_DIR;
  else process.env.SEARCH_STATE_DIR = SAVED;
  resetConfig();
});

describe("SEARCH_STATE_DIR", () => {
  it("is refused when its admin socket path would not fit, with the reason", () => {
    // The proof run's was 130 bytes; anything past the limit is the same defect.
    process.env.SEARCH_STATE_DIR = `/tmp/${"a".repeat(SUN_PATH_MAX_BYTES)}`;
    let thrown: unknown;
    try {
      config();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("Invalid Search configuration");
    expect(message).toContain("SEARCH_STATE_DIR");
    // The three things the operator needs: the limit, what the kernel says, and
    // the way out that does not involve moving the directory.
    expect(message).toContain(String(SUN_PATH_MAX_BYTES));
    expect(message).toContain("EINVAL");
    expect(message).toContain("SEARCH_ADMIN_PORT");
  });

  it("accepts a directory whose socket path fits", () => {
    process.env.SEARCH_STATE_DIR = "/var/lib/search";
    expect(config().SEARCH_STATE_DIR).toBe("/var/lib/search");
  });

  /**
   * Unset is not measured. The default is `~/.actana-search`, which is short
   * everywhere, and measuring it would make reading the configuration depend on
   * a home directory.
   */
  it("is not measured when it is not set", () => {
    delete process.env.SEARCH_STATE_DIR;
    expect(config().SEARCH_STATE_DIR).toBeUndefined();
  });
});

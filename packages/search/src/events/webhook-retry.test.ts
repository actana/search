// The retry policy as arithmetic, so it can be asserted without waiting for it.
import { describe, expect, it } from "vitest";
import {
  isRetryableStatus,
  shouldRetry,
  WEBHOOK_BASE_DELAY_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_DELAY_MS,
  webhookBackoffMs,
} from "./webhook-retry.ts";

describe("webhookBackoffMs", () => {
  it("does not delay the first attempt", () => {
    expect(webhookBackoffMs(1)).toBe(0);
    expect(webhookBackoffMs(0)).toBe(0);
  });

  it("doubles from the base delay and caps", () => {
    expect(webhookBackoffMs(2)).toBe(WEBHOOK_BASE_DELAY_MS);
    expect(webhookBackoffMs(3)).toBe(WEBHOOK_BASE_DELAY_MS * 2);
    expect(webhookBackoffMs(4)).toBe(WEBHOOK_BASE_DELAY_MS * 4);
    expect(webhookBackoffMs(5)).toBe(WEBHOOK_BASE_DELAY_MS * 8);
    expect(webhookBackoffMs(99)).toBe(WEBHOOK_MAX_DELAY_MS);
  });

  it("spends under ten seconds on a receiver that is down", () => {
    let total = 0;
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      total += webhookBackoffMs(attempt);
    }
    expect(total).toBeLessThan(10_000);
  });
});

describe("isRetryableStatus", () => {
  it("is done with a 2xx", () => {
    for (const status of [200, 201, 202, 204, 299]) {
      expect(isRetryableStatus(status), String(status)).toBe(false);
    }
  });

  it("gives up on a 4xx that is the request's own fault", () => {
    // Sending the same malformed thing four more times does not make it valid,
    // so these are terminal and the ledger says so on the first attempt.
    for (const status of [400, 401, 403, 404, 410, 415, 422]) {
      expect(isRetryableStatus(status), String(status)).toBe(false);
    }
  });

  it("retries the two 4xx that mean 'later'", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });

  it("retries a 5xx, a redirect this client does not follow, and a dead socket", () => {
    for (const status of [500, 502, 503, 504, 302, 0]) {
      expect(isRetryableStatus(status), String(status)).toBe(true);
    }
  });
});

describe("shouldRetry", () => {
  it("stops at the attempt ceiling even on a retryable status", () => {
    expect(shouldRetry(WEBHOOK_MAX_ATTEMPTS - 1, 503)).toBe(true);
    expect(shouldRetry(WEBHOOK_MAX_ATTEMPTS, 503)).toBe(false);
  });

  it("stops immediately on a terminal status", () => {
    expect(shouldRetry(1, 404)).toBe(false);
    expect(shouldRetry(1, 204)).toBe(false);
  });
});

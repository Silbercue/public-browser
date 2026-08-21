import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WEBDRIVER_MASK_SOURCE,
  applyWebdriverMask,
  isStealthEnabled,
  resolveStealth,
  setStealthEnabled,
} from "./stealth.js";

describe("resolveStealth", () => {
  it("defaults to enabled when nothing is configured", () => {
    expect(resolveStealth({})).toBe(true);
  });

  it("honours an explicit option over the environment", () => {
    expect(resolveStealth({ SILBERCUE_STEALTH: "0" }, true)).toBe(true);
    expect(resolveStealth({ SILBERCUE_STEALTH: "1" }, false)).toBe(false);
  });

  it.each(["0", "false", "off", "no", "disabled", "FALSE", " off "])(
    "disables masking for SILBERCUE_STEALTH=%j",
    (value) => {
      expect(resolveStealth({ SILBERCUE_STEALTH: value })).toBe(false);
    },
  );

  it.each(["1", "true", "on", "yes", "enabled"])(
    "keeps masking for SILBERCUE_STEALTH=%j",
    (value) => {
      expect(resolveStealth({ SILBERCUE_STEALTH: value })).toBe(true);
    },
  );

  it("supports the PUBLIC_BROWSER_STEALTH alias", () => {
    expect(resolveStealth({ PUBLIC_BROWSER_STEALTH: "0" })).toBe(false);
  });

  it("prefers the canonical name over the alias", () => {
    expect(
      resolveStealth({ SILBERCUE_STEALTH: "1", PUBLIC_BROWSER_STEALTH: "0" }),
    ).toBe(true);
  });

  it("ignores an unrecognised value instead of guessing", () => {
    // A typo must never silently switch masking off.
    expect(resolveStealth({ SILBERCUE_STEALTH: "maybe" })).toBe(true);
    expect(
      resolveStealth({ SILBERCUE_STEALTH: "maybe", PUBLIC_BROWSER_STEALTH: "0" }),
    ).toBe(false);
  });
});

describe("applyWebdriverMask", () => {
  const send = vi.fn(async () => ({}));
  const client = { send } as unknown as Parameters<typeof applyWebdriverMask>[0];

  beforeEach(() => {
    send.mockClear();
    setStealthEnabled(true);
  });

  afterEach(() => {
    setStealthEnabled(true);
  });

  it("injects for both new and current documents by default", async () => {
    await applyWebdriverMask(client, "s1");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      1,
      "Page.addScriptToEvaluateOnNewDocument",
      { source: WEBDRIVER_MASK_SOURCE },
      "s1",
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      "Runtime.evaluate",
      { expression: WEBDRIVER_MASK_SOURCE, awaitPromise: false },
      "s1",
    );
  });

  it("skips the new-document registration when asked to", async () => {
    await applyWebdriverMask(client, "s1", { newDocument: false });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      { expression: WEBDRIVER_MASK_SOURCE, awaitPromise: false },
      "s1",
    );
  });

  it("sends nothing at all when stealth is disabled", async () => {
    setStealthEnabled(false);

    await applyWebdriverMask(client, "s1");

    expect(send).not.toHaveBeenCalled();
    expect(isStealthEnabled()).toBe(false);
  });

  it("swallows CDP errors — masking is hardening, not correctness", async () => {
    send.mockRejectedValueOnce(new Error("Target closed"));

    await expect(applyWebdriverMask(client, "s1")).resolves.toBeUndefined();
    // The second call still runs even though the first one threw.
    expect(send).toHaveBeenCalledTimes(2);
  });
});

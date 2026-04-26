import { describe, it, expect, vi, beforeEach } from "vitest";

describe("debug", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("logs to stderr when DEBUG contains public-browser", async () => {
    process.env.DEBUG = "public-browser";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { debug } = await import("./debug.js");

    debug("test message", 42);

    expect(spy).toHaveBeenCalledWith("[public-browser] test message", 42);
  });

  it("does not log when DEBUG is unset", async () => {
    delete process.env.DEBUG;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { debug } = await import("./debug.js");

    debug("should not appear");

    expect(spy).not.toHaveBeenCalled();
  });

  it("does not log when DEBUG does not contain public-browser", async () => {
    process.env.DEBUG = "other-module";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { debug } = await import("./debug.js");

    debug("should not appear");

    expect(spy).not.toHaveBeenCalled();
  });

  it("logs when DEBUG contains public-browser among other values", async () => {
    process.env.DEBUG = "foo,public-browser,bar";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { debug } = await import("./debug.js");

    debug("multi-value");

    expect(spy).toHaveBeenCalledWith("[public-browser] multi-value");
  });
});

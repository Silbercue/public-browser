import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StarNudge, NUDGE_MESSAGES } from "./star-nudge.js";

function make(overrides: Partial<ConstructorParameters<typeof StarNudge>[0]> = {}) {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const dir = mkdtempSync(join(tmpdir(), "pb-nudge-"));
  const nudge = new StarNudge({ storePath: join(dir, "nudge.json"), now: clock.now, ...overrides });
  return { nudge, clock, storePath: join(dir, "nudge.json") };
}

describe("StarNudge — when it shows", () => {
  it("stays hidden for the first four tool calls and appears on the fifth", () => {
    const { nudge } = make();
    for (let i = 0; i < 4; i++) expect(nudge.onToolCall()).toBeNull();
    expect(nudge.onToolCall()).toEqual(NUDGE_MESSAGES[0]);
  });

  it("stays visible for 20 s, then hides", () => {
    const { nudge, clock } = make();
    for (let i = 0; i < 5; i++) nudge.onToolCall();
    clock.advance(19_000);
    expect(nudge.onToolCall()).toEqual(NUDGE_MESSAGES[0]);
    clock.advance(2_000);
    expect(nudge.onToolCall()).toBeNull();
  });

  it("comes back after 10 minutes with the next message, rotating", () => {
    const { nudge, clock } = make();
    for (let i = 0; i < 5; i++) nudge.onToolCall();
    clock.advance(10 * 60_000);
    expect(nudge.onToolCall()).toEqual(NUDGE_MESSAGES[1]);
    clock.advance(10 * 60_000);
    expect(nudge.onToolCall()).toEqual(NUDGE_MESSAGES[0]);
  });

  it("does not come back early", () => {
    const { nudge, clock } = make();
    for (let i = 0; i < 5; i++) nudge.onToolCall();
    clock.advance(9 * 60_000);
    expect(nudge.onToolCall()).toBeNull();
  });

  it("never shows when disabled (headless — nobody is watching)", () => {
    const { nudge, clock } = make({ enabled: false });
    for (let i = 0; i < 50; i++) { clock.advance(60_000); expect(nudge.onToolCall()).toBeNull(); }
  });
});

describe("StarNudge — dismissal", () => {
  it("never shows again after dismiss, and remembers that across instances", () => {
    const { nudge, clock, storePath } = make();
    for (let i = 0; i < 5; i++) nudge.onToolCall();
    nudge.dismiss("starred");
    clock.advance(60 * 60_000);
    expect(nudge.onToolCall()).toBeNull();
    expect(JSON.parse(readFileSync(storePath, "utf8"))).toMatchObject({ dismissed: true, reason: "starred" });

    const again = new StarNudge({ storePath, now: clock.now });
    for (let i = 0; i < 10; i++) expect(again.onToolCall()).toBeNull();
  });

  it("treats an unreadable store as not dismissed", () => {
    const { storePath, clock } = make();
    writeFileSync(storePath, "{not json");
    const nudge = new StarNudge({ storePath, now: clock.now });
    for (let i = 0; i < 4; i++) nudge.onToolCall();
    expect(nudge.onToolCall()).toEqual(NUDGE_MESSAGES[0]);
  });

  it("creates the store directory on dismiss", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-nudge-"));
    const storePath = join(dir, "deeper", "nudge.json");
    const nudge = new StarNudge({ storePath, now: () => 0 });
    nudge.dismiss("closed");
    expect(existsSync(storePath)).toBe(true);
  });
});

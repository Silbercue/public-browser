import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  HintLedger,
  hintLedger,
  HINT_KIND,
  hintsReachModel,
  resetHintLedgerOnInitialize,
  withoutHintDelivery,
} from "./hint-ledger.js";

describe("HintLedger (Stufe 2 H3)", () => {
  it("grants each hint kind exactly once until reset", () => {
    const ledger = new HintLedger();
    expect(ledger.claim(HINT_KIND.domQuery)).toBe(true);
    expect(ledger.claim(HINT_KIND.domQuery)).toBe(false);
    expect(ledger.claim(HINT_KIND.fillForm)).toBe(true);
    ledger.reset();
    expect(ledger.claim(HINT_KIND.domQuery)).toBe(true);
  });

  it("knows the navigate and click advice kinds (Plancheck P14)", () => {
    expect(HINT_KIND.navigateNext).toBe("navigate:next");
    expect(HINT_KIND.clickNoVisibleChange).toBe("click:no-visible-change");
  });
});

// Plancheck P15: a hint counts as shown only in a top-level MCP response.
describe("withoutHintDelivery (Stufe 2 H3, Plancheck P15)", () => {
  it("lets a hint through without using it up while the response does not reach the model", async () => {
    const ledger = new HintLedger();
    await withoutHintDelivery(async () => {
      expect(hintsReachModel()).toBe(false);
      expect(ledger.claim(HINT_KIND.jsClick)).toBe(true);
      expect(ledger.claim(HINT_KIND.jsClick)).toBe(true);
    });
    expect(hintsReachModel()).toBe(true);
    expect(ledger.claim(HINT_KIND.jsClick)).toBe(true);
    expect(ledger.claim(HINT_KIND.jsClick)).toBe(false);
  });

  it("keeps a hint the model already saw away from undelivered responses, too", async () => {
    const ledger = new HintLedger();
    expect(ledger.claim(HINT_KIND.navigateNext)).toBe(true);
    await withoutHintDelivery(async () => {
      expect(ledger.claim(HINT_KIND.navigateNext)).toBe(false);
    });
  });

  it("holds across awaits and does not leak into a call running at the same time", async () => {
    const ledger = new HintLedger();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const undelivered = withoutHintDelivery(async () => {
      await gate;
      return ledger.claim(HINT_KIND.dialog);
    });
    // A direct MCP call running meanwhile still counts.
    expect(ledger.claim(HINT_KIND.fillForm)).toBe(true);
    expect(ledger.claim(HINT_KIND.fillForm)).toBe(false);
    release();
    expect(await undelivered).toBe(true);
    expect(ledger.claim(HINT_KIND.dialog)).toBe(true);
  });
});

describe("resetHintLedgerOnInitialize (Stufe 2 H3)", () => {
  beforeEach(() => {
    hintLedger.reset();
  });

  it("re-arms every hint when an MCP client (re)initializes the server", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    resetHintLedgerOnInitialize(server);
    expect(hintLedger.claim(HINT_KIND.streakWarning)).toBe(true);
    expect(hintLedger.claim(HINT_KIND.streakWarning)).toBe(false);

    server.server.oninitialized?.();

    expect(hintLedger.claim(HINT_KIND.streakWarning)).toBe(true);
  });

  it("keeps an oninitialized callback that was set before", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    let calls = 0;
    server.server.oninitialized = () => { calls++; };
    resetHintLedgerOnInitialize(server);

    server.server.oninitialized?.();

    expect(calls).toBe(1);
  });

  it("does nothing for a server double without an inner Server", () => {
    expect(() => resetHintLedgerOnInitialize({})).not.toThrow();
  });
});

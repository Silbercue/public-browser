import { describe, it, expect, vi } from "vitest";
import { OVERLAY_SCRIPT } from "./session-overlay.js";

/**
 * The overlay script is injected via Page.addScriptToEvaluateOnNewDocument,
 * which runs before the parser has produced <html>. These tests run the
 * script against a minimal fake DOM that models exactly that: a document
 * whose documentElement is still null.
 */

interface FakeElement {
  tag: string;
  id: string;
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  style: Record<string, string>;
  innerHTML: string;
  content: { cloneNode: () => object };
  attachShadow: () => { appendChild: () => void; querySelector: () => null };
}

function fakeDom(opts: { hasRoot: boolean }) {
  const created: FakeElement[] = [];
  const listeners = new Map<string, Array<() => void>>();
  let attached: FakeElement | null = null;
  const root = {
    appendChild: vi.fn((el: FakeElement) => {
      attached = el;
    }),
  };
  const shadowRoot = { appendChild: vi.fn(), querySelector: vi.fn(() => null) };

  const document = {
    documentElement: opts.hasRoot ? root : null,
    getElementById: vi.fn((id: string) => (attached && attached.id === id ? attached : null)),
    createElement: vi.fn((tag: string): FakeElement => {
      const el: FakeElement = {
        tag,
        id: "",
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        style: {},
        innerHTML: "",
        content: { cloneNode: () => ({}) },
        attachShadow: () => shadowRoot,
      };
      created.push(el);
      return el;
    }),
    addEventListener: vi.fn((type: string, fn: () => void) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    }),
  };
  const window: Record<string, unknown> = {};

  return {
    document,
    window,
    root,
    created,
    listeners,
    run() {
      new Function("document", "window", OVERLAY_SCRIPT)(document, window);
    },
    /** The parser has built <html>; fire DOMContentLoaded. */
    domContentLoaded() {
      document.documentElement = root;
      for (const fn of listeners.get("DOMContentLoaded") ?? []) fn();
    },
    hosts: () => created.filter((el) => el.tag === "div"),
  };
}

describe("session overlay script — before <html> exists", () => {
  it("does not throw when documentElement is null (the addScriptToEvaluateOnNewDocument case)", () => {
    // Regression: `document.documentElement.appendChild(host)` threw a
    // TypeError on every page load, which Public Browser then reported back
    // to itself as a page error in tab_status.
    const dom = fakeDom({ hasRoot: false });
    expect(() => dom.run()).not.toThrow();
    expect(dom.root.appendChild).not.toHaveBeenCalled();
  });

  it("attaches the host once the DOM is built", () => {
    const dom = fakeDom({ hasRoot: false });
    dom.run();
    expect(dom.listeners.get("DOMContentLoaded")).toHaveLength(1);

    dom.domContentLoaded();

    expect(dom.root.appendChild).toHaveBeenCalledTimes(1);
    expect(dom.hosts()).toHaveLength(1);
    expect(dom.root.appendChild.mock.calls[0][0]).toBe(dom.hosts()[0]);
  });

  it("does not create a second host when the script runs again while the first one waits", () => {
    // injectOverlay registers the script AND evaluates it once immediately;
    // the self-healing path in updateOverlayStatus may evaluate it again.
    const dom = fakeDom({ hasRoot: false });
    dom.run();
    dom.run();

    dom.domContentLoaded();

    expect(dom.hosts()).toHaveLength(1);
    expect(dom.root.appendChild).toHaveBeenCalledTimes(1);
  });

  it("clears the pending marker after attaching", () => {
    const dom = fakeDom({ hasRoot: false });
    dom.run();
    expect(dom.window.__sc_session_overlay_pending__).toBe(true);

    dom.domContentLoaded();

    expect(dom.window.__sc_session_overlay_pending__).toBe(false);
  });
});

describe("session overlay script — on a built page", () => {
  it("attaches immediately and registers no listener", () => {
    const dom = fakeDom({ hasRoot: true });
    dom.run();

    expect(dom.root.appendChild).toHaveBeenCalledTimes(1);
    expect(dom.document.addEventListener).not.toHaveBeenCalled();
  });

  it("hides the host from the accessibility tree", () => {
    // view_page reads the AX tree; with filter "all" the status bar showed
    // up as page content ("Public Browser", the cortex page-type flash).
    const dom = fakeDom({ hasRoot: true });
    dom.run();

    expect(dom.hosts()[0].attributes["aria-hidden"]).toBe("true");
  });

  it("is a no-op when the overlay is already on the page", () => {
    const dom = fakeDom({ hasRoot: true });
    dom.run();
    dom.run();

    expect(dom.hosts()).toHaveLength(1);
    expect(dom.root.appendChild).toHaveBeenCalledTimes(1);
  });
});

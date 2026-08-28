import { describe, it, expect, beforeEach } from "vitest";
import { configureSessionHandler } from "./configure-session.js";
import { SessionDefaults } from "../cache/session-defaults.js";

describe("configureSessionHandler", () => {
  let sd: SessionDefaults;

  beforeEach(() => {
    sd = new SessionDefaults();
  });

  it("ohne Parameter: gibt aktuelle Defaults und Vorschlaege zurueck", async () => {
    sd.setDefault("tab", "tab-abc");

    const result = await configureSessionHandler({}, sd);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.defaults).toEqual({ tab: "tab-abc" });
    expect(parsed.autoPromote).toEqual([]);
  });

  it("mit defaults: setzt Defaults und gibt aktualisierte Defaults zurueck", async () => {
    const result = await configureSessionHandler(
      { defaults: { tab: "tab-abc123", timeout: 10000 } },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.defaults).toEqual({ tab: "tab-abc123", timeout: 10000 });
  });

  it("mit defaults: { tab: null } entfernt Default", async () => {
    sd.setDefault("tab", "tab-abc");
    sd.setDefault("timeout", 5000);

    const result = await configureSessionHandler(
      { defaults: { tab: null } },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.defaults).toEqual({ timeout: 5000 });
    // tab should be removed
    expect(parsed.defaults.tab).toBeUndefined();
  });

  it("mit autoPromote: true: uebernimmt Vorschlaege als Defaults", async () => {
    // Create suggestions by tracking calls
    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("click", { tab: "tab-xyz" });

    const result = await configureSessionHandler(
      { autoPromote: true },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.applied).toEqual({ tab: "tab-xyz" });
    expect(parsed.defaults).toEqual({ tab: "tab-xyz" });
  });

  it("_meta enthaelt elapsedMs und method: configure_session", async () => {
    const result = await configureSessionHandler({}, sd);

    expect(result._meta).toBeDefined();
    expect(result._meta?.method).toBe("configure_session");
    expect(typeof result._meta?.elapsedMs).toBe("number");
  });

  it("autoPromote: true with no suggestions: returns empty applied and defaults", async () => {
    const result = await configureSessionHandler(
      { autoPromote: true },
      sd,
    );

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.applied).toEqual({});
    expect(parsed.defaults).toEqual({});
  });

  it("H4: autoPromote + defaults gleichzeitig → beide werden ausgefuehrt", async () => {
    // Set up suggestions
    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("click", { tab: "tab-xyz" });

    const result = await configureSessionHandler(
      { autoPromote: true, defaults: { timeout: 8000 } },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    // autoPromote should have applied the suggestion
    expect(parsed.applied).toEqual({ tab: "tab-xyz" });
    // defaults should contain both the explicit default AND the promoted suggestion
    expect(parsed.defaults).toEqual({ timeout: 8000, tab: "tab-xyz" });
  });

  // ── Profile Reconnect (restart: true) ──────────────────────────────

  it("profile + restart:true + browserReady → returns restartRequired flag", async () => {
    const result = await configureSessionHandler(
      { profile: "Business", restart: true },
      sd,
      /* browserReady */ true,
    );

    expect(result.isError).toBeFalsy();
    expect(result._meta?.restartRequired).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.profile).toBe("Business");
    expect(parsed.status).toBe("restart_pending");
    expect(sd.getDefault("_profile")).toBe("Business");
  });

  // BUG-019: the handler could only ever record the intent. Nothing consumed
  // the restartRequired flag, so restart: true answered "restart_pending" and
  // then no restart happened. The caller now passes the actual restart.
  it("profile + restart:true + a restart fn → performs the restart and says so", async () => {
    const calls: string[] = [];
    const result = await configureSessionHandler(
      { profile: "Business", restart: true },
      sd,
      /* browserReady */ true,
      async () => { calls.push("restart"); },
    );

    expect(calls).toEqual(["restart"]);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.status).toBe("restarted");
    // The profile has to be stored BEFORE the restart, otherwise the relaunch
    // comes up on the old profile.
    expect(sd.getDefault("_profile")).toBe("Business");
  });

  it("a failing restart surfaces as an error instead of a success message", async () => {
    const result = await configureSessionHandler(
      { profile: "Business", restart: true },
      sd,
      /* browserReady */ true,
      async () => { throw new Error("Chrome refused to close"); },
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toContain("Chrome refused to close");
  });

  it("profile + restart:true + browserReady=false → stores profile normally", async () => {
    const result = await configureSessionHandler(
      { profile: "Business", restart: true },
      sd,
      /* browserReady */ false,
    );

    expect(result.isError).toBeFalsy();
    expect(result._meta?.restartRequired).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.profile).toBe("Business");
    expect(parsed.status).toBe("profile_set");
    expect(sd.getDefault("_profile")).toBe("Business");
  });

  it("profile + browserReady + NO restart → error (backward compat)", async () => {
    const result = await configureSessionHandler(
      { profile: "Julian" },
      sd,
      /* browserReady */ true,
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toContain("restart: true");
  });

  it("restart:true without profile → ignored, returns defaults", async () => {
    const result = await configureSessionHandler(
      { restart: true },
      sd,
    );

    expect(result.isError).toBeFalsy();
    expect(result._meta?.restartRequired).toBeUndefined();
  });

  it("defaults with unknown keys are accepted (future-proof)", async () => {
    const result = await configureSessionHandler(
      { defaults: { custom_param: "value", another: 42 } },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.defaults).toEqual({ custom_param: "value", another: 42 });
  });

  // ── FR-049: Top-Level-Parameter faelschlich in `defaults` verschachtelt ──

  it("profile + defaults:{restart} bei laufendem Browser → eigener Fehler, nicht der Profil-Text", async () => {
    const result = await configureSessionHandler(
      { profile: "Julian", defaults: { restart: true } },
      sd,
      /* browserReady */ true,
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toContain("restart");
    expect(parsed.error).toContain("top-level parameter");
    // Der echte Profilname, nicht ein Platzhalter — die gezeigte Form muss absetzbar sein.
    expect(parsed.error).toContain("configure_session({profile: \"Julian\", restart: true})");
    expect(parsed.error).not.toContain("\"...\"");
    expect(parsed.error).not.toContain("Cannot change Chrome profile");
  });

  it("defaults:{restart} ohne profile → derselbe Fehler, und nichts landet im Cache", async () => {
    const result = await configureSessionHandler(
      { defaults: { restart: true, tab: "tab-abc" } },
      sd,
      /* browserReady */ false,
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toContain("top-level parameter");
    // Abgelehnter Call darf nichts schreiben — auch nicht die legitimen Keys daneben.
    expect(sd.getAllDefaults()).toEqual({});
  });

  it("mehrere fehlplatzierte Keys werden alle genannt", async () => {
    const result = await configureSessionHandler(
      { defaults: { restart: true, autoPromote: true } },
      sd,
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toContain("restart");
    expect(parsed.error).toContain("autoPromote");
    // Beispiel ohne profile-Teil, wenn kein Profil im Call stand.
    // Reihenfolge folgt dem Schema, nicht dem Call — beide Keys mit ihren echten Werten.
    expect(parsed.error).toContain("configure_session({autoPromote: true, restart: true})");
    expect(parsed.error).not.toContain("profile:");
  });

  it("fehlplatziertes autoPromote → Beispiel zeigt autoPromote, nicht restart", async () => {
    const result = await configureSessionHandler(
      { defaults: { autoPromote: true } },
      sd,
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toContain("configure_session({autoPromote: true})");
    // Positive Gegenprobe oben: der Fehler nennt das Beispiel ueberhaupt.
    // Negativ: kein Rat, der Chrome neu startet.
    expect(parsed.error).not.toContain("restart");
  });

  it("profile + defaults:{headless} bleibt erlaubt (frictioneer-Workflow)", async () => {
    const result = await configureSessionHandler(
      { profile: "Julian", defaults: { headless: true } },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.defaults).toEqual({ _profile: "Julian", headless: true });
    expect(parsed.profile).toBe("Julian");
  });

  it("profile + restart:true bei laufendem Browser bleibt der Restart-Pfad", async () => {
    const calls: string[] = [];
    const result = await configureSessionHandler(
      { profile: "Julian", restart: true },
      sd,
      /* browserReady */ true,
      async () => { calls.push("restart"); },
    );

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual(["restart"]);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.status).toBe("restarted");
  });

  it("Profil-Fehler bei laufendem Browser zeigt die vollstaendige Aufrufform", async () => {
    const result = await configureSessionHandler(
      { profile: "Julian" },
      sd,
      /* browserReady */ true,
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toContain("configure_session({profile: \"Julian\", restart: true})");
    expect(parsed.available_profiles).toBeDefined();
  });
});

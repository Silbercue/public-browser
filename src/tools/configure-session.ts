import { z } from "zod";
import type { SessionDefaults } from "../cache/session-defaults.js";
import type { ToolResponse } from "../types.js";
import { discoverProfiles } from "../cdp/chrome-profiles.js";

export const configureSessionSchema = z.object({
  defaults: z.record(z.unknown())
    .optional()
    .describe("Param name → default value; null removes a default"),
  autoPromote: z.boolean()
    .optional()
    .describe("Apply all current auto-promote suggestions"),
  profile: z.string()
    .optional()
    .describe("Chrome profile name (list them with: public-browser profiles); restart: true switches mid-session"),
  restart: z.boolean()
    .optional()
    .describe("Restart Chrome with the new profile even if running; closes all tabs"),
});

export type ConfigureSessionParams = z.infer<typeof configureSessionSchema>;

/**
 * Top-Level-Parameter des Schemas. Aus dem Schema abgeleitet statt hartcodiert,
 * damit kuenftige Parameter automatisch mitgeprueft werden.
 */
const RESERVED_TOP_LEVEL_KEYS = Object.keys(configureSessionSchema.shape)
  .filter((key) => key !== "defaults");

export async function configureSessionHandler(
  params: ConfigureSessionParams,
  sessionDefaults: SessionDefaults,
  browserReady?: boolean,
  /**
   * Performs the actual browser restart. The handler has no access to the
   * session, so without this it could only ever record the intent — which is
   * how restart: true came to answer "restart_pending" while nothing restarted
   * (BUG-019). Optional so the Script API and unit tests can leave it out.
   */
  restartBrowser?: () => Promise<void>,
): Promise<ToolResponse> {
  const start = performance.now();

  // FR-049: `restart` & Co. sind Top-Level-Parameter. Landen sie in `defaults`,
  // fielen sie frueher stillschweigend durch (und wurden sogar als Muell-Default
  // gecacht) — die Antwort war byteweise dieselbe wie beim Versuch davor.
  if (params.defaults) {
    const misplaced = RESERVED_TOP_LEVEL_KEYS.filter(
      (key) => Object.prototype.hasOwnProperty.call(params.defaults, key),
    );
    if (misplaced.length > 0) {
      const list = misplaced.join(", ");
      const verb = misplaced.length === 1
        ? "is a top-level parameter, not a session default"
        : "are top-level parameters, not session defaults";
      // Das Beispiel wird aus dem echten Call gebaut — fehlplatzierte Keys mit ihren
      // Werten, das Profil mit seinem echten Namen. Ein fest verdrahtetes
      // `restart: true` waere bei anderen Keys ein falscher Rat (FR-049).
      const defaultsObj = params.defaults as Record<string, unknown>;
      const exampleParts = misplaced.map((key) => `${key}: ${JSON.stringify(defaultsObj[key]) ?? "undefined"}`);
      if (params.profile !== undefined) {
        exampleParts.unshift(`profile: ${JSON.stringify(params.profile)}`);
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `${list} ${verb}. Call configure_session({${exampleParts.join(", ")}}) — ${list} belongs next to \`defaults\`, not inside it; keys inside defaults are per-tool parameter defaults (tab, timeout, headless, ...). Nothing was changed.`,
            misplaced_keys: misplaced,
          }),
        }],
        isError: true,
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "configure_session" },
      };
    }
  }

  if (params.profile !== undefined) {
    if (browserReady && !params.restart) {
      const profiles = discoverProfiles();
      const available = profiles.map((p) => `"${p.name}"`).join(", ");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `Cannot change Chrome profile after browser is already running. Call configure_session({profile: "${params.profile}", restart: true}) to restart Chrome with that profile (restart is a top-level parameter, not a key inside defaults), or set the profile before the first browser interaction.`,
            available_profiles: available,
          }),
        }],
        isError: true,
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "configure_session" },
      };
    }

    sessionDefaults.setDefault("_profile", params.profile);

    if (browserReady && params.restart) {
      // The profile is already stored above — the relaunch inside restartBrowser()
      // reads it back, so the order here matters.
      if (restartBrowser) {
        try {
          await restartBrowser();
        } catch (err) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: `Could not restart Chrome with profile "${params.profile}": ${err instanceof Error ? err.message : String(err)}`,
            }) }],
            isError: true,
            _meta: { elapsedMs: Math.round(performance.now() - start), method: "configure_session" },
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            profile: params.profile,
            status: "restarted",
            message: `Chrome restarted with profile "${params.profile}". All previous tabs were closed.`,
          }) }],
          _meta: {
            elapsedMs: Math.round(performance.now() - start),
            method: "configure_session",
            restartRequired: true,
          },
        };
      }

      // No restart hook wired in (Script API, tests): report the intent only.
      return {
        content: [{ type: "text", text: JSON.stringify({
          profile: params.profile,
          status: "restart_pending",
          message: `Chrome will restart with profile "${params.profile}". All current tabs will be closed.`,
        }) }],
        _meta: {
          elapsedMs: Math.round(performance.now() - start),
          method: "configure_session",
          restartRequired: true,
        },
      };
    }
  }

  // H4 fix: Process defaults and autoPromote independently (no early return)
  let applied: Record<string, unknown> | undefined;

  // defaults gesetzt → Defaults aktualisieren
  if (params.defaults) {
    for (const [key, value] of Object.entries(params.defaults)) {
      sessionDefaults.setDefault(key, value);
    }
  }

  // autoPromote: true → alle Vorschlaege als Defaults uebernehmen
  if (params.autoPromote) {
    applied = sessionDefaults.applyAllSuggestions();
  }

  // Build response based on what was requested
  if (params.defaults !== undefined || params.autoPromote || params.profile !== undefined) {
    const payload: Record<string, unknown> = {
      defaults: sessionDefaults.getAllDefaults(),
    };
    if (applied !== undefined) {
      payload.applied = applied;
    }
    if (params.profile !== undefined) {
      payload.profile = params.profile;
      payload.status = "profile_set";
    }
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      _meta: { elapsedMs: Math.round(performance.now() - start), method: "configure_session" },
    };
  }

  // Keine Parameter → aktuelle Defaults + Vorschlaege abfragen
  return {
    content: [{ type: "text", text: JSON.stringify({
      defaults: sessionDefaults.getAllDefaults(),
      autoPromote: sessionDefaults.getSuggestions(),
    }) }],
    _meta: { elapsedMs: Math.round(performance.now() - start), method: "configure_session" },
  };
}

import { debug } from "../cdp/debug.js";

/**
 * Story 20.1 — Async DOM-Diff: Click antwortet sofort, Diff piggybacks auf
 * die naechste Tool-Response.
 *
 * `DeferredDiffSlot` haelt **maximal einen** aktiven Background-Diff-Job.
 * Strukturell identisch zu `PrefetchSlot` (Story 18.5), aber mit einem
 * Payload: der fertig formatierte Diff-Text (`string | null`), der per
 * `drain()` nicht-blockierend abgeholt werden kann.
 *
 * Lifecycle-Regeln (identisch zu PrefetchSlot):
 *  - **Genau ein Slot** pro Instanz. Slot 2 cancelt Slot 1 atomar.
 *  - **Identity-Check** via monoton steigender `slotId`.
 *  - **Atomarer schedule():** `_active` wird synchron gesetzt, BEVOR der
 *    Build startet (`setImmediate`).
 *  - **Fehler-Absorption:** Build-Fehler werden debug-geloggt, nie an LLM.
 *
 * Zusaetzlich gegenueber PrefetchSlot:
 *  - `_pendingDiffText` speichert das Build-Ergebnis.
 *  - `drain()` liest und loescht den Pending-Diff atomar (nicht-blockierend).
 */

interface ActiveSlot {
  slotId: number;
  abortController: AbortController;
  donePromise: Promise<void>;
}

/**
 * Build-Callback: bekommt den AbortSignal und liefert den formatierten
 * Diff-Text (oder null wenn kein Diff). Der Callback muss den Signal
 * selbst pruefen und bei Abbruch frueh zurueckkehren.
 */
export type DeferredDiffBuild = (signal: AbortSignal) => Promise<string | null>;

export class DeferredDiffSlot {
  private _active: ActiveSlot | null = null;
  private _nextSlotId = 0;
  private _pendingDiffText: string | null = null;

  /** Test-only: gibt an ob aktuell ein Slot lebt. */
  get isActive(): boolean {
    return this._active !== null;
  }

  /** Test-only: gibt den aktuell gepufferten Diff-Text zurueck (ohne zu drainen). */
  get pendingDiffText(): string | null {
    return this._pendingDiffText;
  }

  /**
   * Plant einen neuen Background-Diff-Job. Wenn bereits ein Slot lebt,
   * wird er via AbortController gecancelt und ersetzt — atomar.
   *
   * Der vorherige `_pendingDiffText` wird ebenfalls geloescht: ein neuer
   * Click invalidiert jeden alten Diff.
   */
  schedule(build: DeferredDiffBuild): Promise<void> {
    // 1. Vorherigen Slot synchron cancelln.
    if (this._active !== null) {
      try {
        this._active.abortController.abort();
      } catch {
        // AbortController.abort() wirft nicht in modernen Node-Versionen.
      }
      this._active = null;
    }

    // Alten Pending-Diff invalidieren — neuer Click ueberschreibt alles.
    this._pendingDiffText = null;

    // 2. Neuen Slot-State atomar setzen.
    const slotId = ++this._nextSlotId;
    const abortController = new AbortController();
    const signal = abortController.signal;

    // 3. Build in naechstem Event-Loop-Tick starten (setImmediate).
    const donePromise = new Promise<void>((resolveDone) => {
      setImmediate(() => {
        const wrapped = (async () => build(signal))();
        wrapped
          .then((diffText: string | null) => {
            // Identity-Check: nur speichern wenn DIESER Slot noch aktiv ist.
            if (this._active !== null && this._active.slotId === slotId) {
              this._pendingDiffText = diffText;
            }
          })
          .catch((err: unknown) => {
            if (isAbortError(err)) return;
            debug(
              "DeferredDiffSlot: build failed, dropping result: %s",
              err instanceof Error ? err.message : String(err),
            );
          })
          .finally(() => {
            // Identity-Check: nur aufraeumen wenn DIESER Slot noch aktiv ist.
            if (this._active !== null && this._active.slotId === slotId) {
              this._active = null;
            }
            resolveDone();
          });
      });
    });

    const slot: ActiveSlot = {
      slotId,
      abortController,
      donePromise,
    };
    this._active = slot;

    return donePromise;
  }

  /**
   * Nicht-blockierender Drain: gibt den Pending-Diff zurueck und setzt
   * ihn auf null. Wenn kein Diff bereitsteht (Build noch nicht fertig
   * oder kein Diff produziert), gibt null zurueck.
   *
   * Story 20.1 H1-Fix: Wenn ein Build noch in-flight ist, wird er
   * via AbortController gecancelt UND `_active` auf null gesetzt, damit
   * das Build-Ergebnis NICHT mehr in `_pendingDiffText` landen kann.
   * Ohne diesen Cancel wuerde ein spaeter fertig werdender Build sein
   * Ergebnis in `_pendingDiffText` schreiben und beim naechsten Drain
   * als Ghost-Diff auftauchen.
   */
  drain(): string | null {
    // H1-Fix: Cancel any in-flight build so its result is discarded.
    if (this._active !== null) {
      try {
        this._active.abortController.abort();
      } catch {
        // AbortController.abort() wirft nicht in modernen Node-Versionen.
      }
      this._active = null;
    }
    const text = this._pendingDiffText;
    this._pendingDiffText = null;
    return text;
  }

  /**
   * Sofort den aktiven Slot abbrechen und freigeben. Idempotent.
   * Loescht auch den Pending-Diff.
   */
  cancel(): void {
    if (this._active !== null) {
      try {
        this._active.abortController.abort();
      } catch {
        // see schedule()
      }
      this._active = null;
    }
    this._pendingDiffText = null;
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError";
  }
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    return name === "AbortError";
  }
  return false;
}

/**
 * Modulweite Singleton-Instanz.
 */
export const deferredDiffSlot = new DeferredDiffSlot();

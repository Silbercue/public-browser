# BUG-015: Screenshot schwarz bei verdecktem Chrome-Fenster (macOS)

## Status: GEFIXT — Dual-Layer-Fix (setFocusEmulationEnabled + CDPScreenshotNewSurface)

## Problem

`Page.captureScreenshot` liefert schwarze Bilder wenn das Chrome-Fenster:
- Auf einem sekundaeren Monitor liegt
- Von anderen App-Fenstern verdeckt ist
- Nicht im Vordergrund des macOS Compositors ist

Alle anderen Tools (read_page, click, evaluate, type) funktionieren — nur der Screenshot ist betroffen.

## Root Cause

macOS "Occlusion Tracking" (seit Chrome 74): Wenn ein Fenster nicht sichtbar ist, sendet macOS ein Occlusion-Signal. Chrome pausiert daraufhin den Renderer-Prozess. `Page.captureScreenshot` versucht einen Frame zu erfassen der nie gerendert wurde.

Chromium Design Doc: https://www.chromium.org/developers/design-documents/mac-occlusion/

Die exakte Kette im Chromium-Quellcode:
1. macOS meldet Fenster-Okklusion
2. `WebContentsImpl::WasOccluded()` wird aufgerufen
3. `CalculatePageVisibilityState(OCCLUDED)` gibt `kHidden` zurueck (wenn `visible_capturer_count_ == 0`)
4. `RenderWidgetHostViewMac::WasOccluded()` → `host()->WasHidden()` → Renderer pausiert
5. `Page.captureScreenshot` liest leeren Frame → schwarzes Bild

Relevante Chromium-Dateien:
- `content/browser/renderer_host/render_widget_host_view_mac.mm` (Zeilen 591-607)
- `content/browser/web_contents/web_contents_impl.cc` (Zeilen 5012-5035)
- `content/browser/devtools/protocol/emulation_handler.cc` (Zeilen 1004-1016)

## Fix: Dual-Layer-Ansatz

### Layer 1: `Emulation.setFocusEmulationEnabled({ enabled: true })` (Runtime)

Der primaere Fix. Ein einziger CDP-Call der den Renderer dauerhaft aktiv haelt:

```typescript
await cdpClient.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
```

**Wie es funktioniert** (aus `emulation_handler.cc` Zeilen 1004-1016):
- Ruft intern `WebContents::IncrementCapturerCount(stay_hidden=false)` auf
- Inkrementiert `visible_capturer_count_`
- `CalculatePageVisibilityState(OCCLUDED)` gibt dann `kVisible` statt `kHidden` zurueck
- Der Renderer bleibt permanent aktiv, unabhaengig von macOS Occlusion-Signalen
- Handle bleibt aktiv bis `setFocusEmulationEnabled(false)` oder `Emulation.Disable()`

**Vorteile:**
- Funktioniert bei WebSocket-Verbindung (keine Launch-Flags noetig)
- Funktioniert bei Auto-Launch (Pipe)
- Kein Performance-Overhead (kein Screencast, keine Extra-Frames)
- Pro Tab/Session — muss bei Tab-Wechsel erneut aufgerufen werden

**Implementiert in:**
- `src/server.ts` — Initial-Setup nach `Accessibility.enable` (nur headed)
- `src/server.ts` — Reconnect-Handler
- `src/tools/switch-tab.ts` — `activateSession()` bei Tab-Wechsel

### Layer 2: `--enable-features=CDPScreenshotNewSurface` (Launch-Flag)

Komplementaerer Fix fuer Auto-Launch-Modus. Ein Chromium Feature Flag der den Screenshot-Pfad aendert:

```bash
--enable-features=CDPScreenshotNewSurface
```

**Wie es funktioniert** (aus `render_widget_host_impl.cc` Zeilen 2167-2206):
1. `ForceRedraw()` — erzwingt Renderer-Redraw
2. `RequestRepaintOnNewSurface()` — alloziert neue `LocalSurfaceId` via `BrowserCompositorMac::ForceNewSurfaceId()`
3. `CopyFromSurface()` — liest direkt aus dem Viz Surface Cache, NICHT vom Screen-Display

**Der alte Pfad** (ohne Feature) wartete auf `SwapBuffers` / Screen-Praesentation. macOS blockiert die Praesentation bei okkultierten Fenstern → Screenshot haengt oder ist schwarz.

**Details:**
- Echtes Chromium `base::Feature`, `FEATURE_DISABLED_BY_DEFAULT`
- Eingefuehrt in Chrome 138 (Commit `3ef2c6cb`, 2025-05-13, Autor: dgozman@chromium.org)
- Chromium CL: https://chromium-review.googlesource.com/c/chromium/src/+/6519891
- Chromium Bug: https://issues.chromium.org/issues/377715191
- Playwright Default seit v1.47 (PR #36092, Mai 2025)
- Chrome 146+: Unterstuetzt (146 > 138)
- Nur bei Chrome-Start setzbar, kein Runtime-CDP-Call

**Implementiert in:** `src/cdp/chrome-launcher.ts` Zeile 136 (CHROME_FLAGS)

### Warum beide Layer?

| Szenario | Layer 1 (setFocusEmulation) | Layer 2 (NewSurface) |
|----------|---------------------------|---------------------|
| Auto-Launch (Pipe) | Aktiv | Aktiv |
| WebSocket (externer Chrome MIT Flag) | Aktiv | Aktiv |
| WebSocket (externer Chrome OHNE Flag) | Aktiv | Nicht verfuegbar |

Layer 1 ist der Runtime-Fix der immer funktioniert. Layer 2 ist der Defense-in-Depth fuer Auto-Launch.

## Verworfene Alternative: Permanenter Page.startScreencast

Ebenfalls funktionsfaehig, aber komplexer als `setFocusEmulationEnabled`:
- Registriert Frame-Subscriber → `IncrementCapturerCount()`
- MUSS vor Okklusion gestartet werden (nicht nachtraeglich)
- Braucht Frame-Ack-Handling und Throttling
- CPU-Overhead durch kontinuierliche Frame-Produktion
- Playwright nutzt Screencast NUR fuer Video-Recording, nicht fuer Screenshots

`setFocusEmulationEnabled` erreicht denselben Effekt (IncrementCapturerCount) mit einem einzigen Call und ohne Overhead.

## Reproduktion (vor dem Fix)

```bash
# Chrome mit Remote Debugging starten (OHNE CDPScreenshotNewSurface)
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --user-data-dir=/tmp/chrome-debug-test \
  --no-first-run \
  http://localhost:4242

# Fenster auf sekundaeren Monitor schieben
# MCP-Server starten, screenshot aufrufen → SCHWARZ
```

## Beobachtung: Erster Screenshot nach Connect funktioniert

Ein entscheidendes Detail: Der ERSTE Screenshot nach einem frischen MCP-Server-Connect funktioniert. Alle nachfolgenden sind schwarz.

**Was beim Server-Start passiert (server.ts:56-81):**
1. `Target.attachToTarget` → neues Session
2. `Runtime.enable`, `Page.enable`, `Accessibility.enable`
3. `Browser.getWindowForTarget({ targetId })` → windowId
4. `Browser.setWindowBounds({ windowId, bounds: { width: 1280, height: 885 } })` → **Resize**

Das Resize in Schritt 4 triggert einen Compositor-Render-Zyklus. Der erste Screenshot danach erfasst diesen Frame. Danach erkennt macOS die Okklusion erneut und pausiert den Renderer.

## Getestete Workarounds (vor dem Fix, alle gescheitert)

### 1. Chrome-Flags (--disable-backgrounding-occluded-windows)
- Flags werden korrekt gesetzt (verifiziert via `ps aux`)
- Chrome 146 auf macOS 15 (Sequoia): Flags wirken NICHT zuverlaessig auf sekundaerem Monitor
- Playwright setzt diese Flags als Default — aber Playwright nutzt CDPScreenshotNewSurface als eigentlichen Fix

### 2. Emulation.setDeviceMetricsOverride (temporaer)
- Aendert den Viewport, weckt aber den pausierten Renderer NICHT auf
- Bestaetigt durch Quellcode-Analyse: `emulation_handler.cc` ruft NUR `EnableDeviceEmulation()` auf — kein Einfluss auf Visibility

### 3. Browser.setWindowBounds — Fenster verschieben
- Fenster-Move via CDP hat auf macOS keinen sichtbaren Effekt (`window.screenX` aendert sich nicht)

### 4. Browser.setWindowBounds — Resize-Trigger
- Funktioniert NICHT wenn zwischen Server-Start und Screenshot zu viel Zeit vergangen ist
- macOS re-okkuliert das Fenster bevor der naechste captureScreenshot ausgefuehrt wird

### 5. Page.startScreencast (kurzzeitig)
- Renderer bereits pausiert — Screencast produziert keine Frames bei okkuliertem Fenster
- Muss DAUERHAFT und VOR Okklusion gestartet werden (siehe verworfene Alternative oben)

### 6. Target.activateTarget + Browser.setWindowBounds(windowState: 'normal')
- Aktiviert den Tab, aber weckt den Renderer nicht dauerhaft

### 7. fromSurface: false
- Liest vom View-Layer (NSView auf macOS via `GrabViewSnapshot`)
- View-Layer ist AUCH leer wenn der Renderer nie gerendert hat
- Bestaetigt: Beide Pfade (`CopyFromSurface` und `GrabViewSnapshot`) scheitern bei pausiertem Renderer

## Was NICHT hilft (bestaetigt durch Quellcode-Analyse)

- `--disable-features=CalculateNativeWinOcclusion` — **Windows-only** (NativeWindowOcclusionTrackerWin), nicht macOS
- `Emulation.setDeviceMetricsOverride` — kein Einfluss auf Visibility/Occlusion
- `Emulation.setEmulatedMedia` — kein Einfluss
- `Runtime.evaluate` mit `requestAnimationFrame` — hilft nicht bei pausiertem Renderer
- `Page.setWebLifecycleState({state: 'active'})` — nicht wirksam (Puppeteer Issue #3339)

## Relevante Dateien

- `src/tools/screenshot.ts` — Screenshot-Handler
- `src/server.ts` — Server-Init mit setFocusEmulationEnabled (BUG-015 Fix)
- `src/tools/switch-tab.ts` — activateSession() mit setFocusEmulationEnabled (BUG-015 Fix)
- `src/cdp/chrome-launcher.ts:126-137` — CHROME_FLAGS (inkl. CDPScreenshotNewSurface)

## Quellen

### Primaerquellen (Chromium-Quellcode)
- [emulation_handler.cc](https://github.com/nicedoc/chromium/blob/main/content/browser/devtools/protocol/emulation_handler.cc) — `SetFocusEmulationEnabled` Zeilen 1004-1016
- [web_contents_impl.cc](https://github.com/nicedoc/chromium/blob/main/content/browser/web_contents/web_contents_impl.cc) — `CalculatePageVisibilityState` Zeilen 5012-5035
- [render_widget_host_impl.cc](https://github.com/nicedoc/chromium/blob/main/content/browser/renderer_host/render_widget_host_impl.cc) — `kCDPScreenshotNewSurface` Pfad Zeilen 2167-2206
- [render_widget_host_view_mac.mm](https://github.com/nicedoc/chromium/blob/main/content/browser/renderer_host/render_widget_host_view_mac.mm) — `WasOccluded` Zeilen 591-607
- [page_handler.cc](https://github.com/nicedoc/chromium/blob/main/content/browser/devtools/protocol/page_handler.cc) — `CaptureScreenshot` Zeilen 1343-1349

### Chromium Issues & CLs
- [Chromium Issue 377715191](https://issues.chromium.org/issues/377715191) — "[DevTools] Screenshot hangs on Focus emulated Page"
- [Chromium Issue 40213507](https://issues.chromium.org/issues/40213507) — "Re-Enable Window Occlusion for Capture Scenarios"
- [Chromium CL 6519891](https://chromium-review.googlesource.com/c/chromium/src/+/6519891) — CDPScreenshotNewSurface Commit
- [Chromium Mac Occlusion Design Doc](https://www.chromium.org/developers/design-documents/mac-occlusion/)

### Playwright
- [chromiumSwitches.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts) — CDPScreenshotNewSurface Flag (Zeile 70)
- [Playwright PR #36092](https://github.com/microsoft/playwright/pull/36092) — CDPScreenshotNewSurface Einfuehrung
- [Playwright PR #37201](https://github.com/microsoft/playwright/pull/37201) — CDPScreenshotNewSurface fuer alle Channels
- [Playwright Issue #16307](https://github.com/microsoft/playwright/issues/16307) — Screenshot Timeouts auf Background Tabs
- [Playwright Issue #33330](https://github.com/microsoft/playwright/issues/33330) — Screenshot hangs on Focus emulated Page

### Puppeteer & Sonstige
- [Puppeteer PR #8496](https://github.com/puppeteer/puppeteer/pull/8496) — fromSurface Option
- [Puppeteer Issue #3339](https://github.com/puppeteer/puppeteer/issues/3339) — not working when not focused
- [chrome-launcher chrome-flags-for-tools.md](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md)
- [ScreenshotOne Blog](https://screenshotone.com/blog/take-a-screenshot-from-the-surface-in-puppeteer-and-chrome-devtools-protocol/) — fromSurface erklaert
- [CDP Page-Domain Spec](https://chromedevtools.github.io/devtools-protocol/tot/Page/)

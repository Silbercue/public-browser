/**
 * Star nudge — the small "★ Star on GitHub" link at the right end of the
 * session overlay bar.
 *
 * It is meant for the human watching the browser, never for the agent (the
 * overlay is aria-hidden, so view_page never sees it). It shows briefly and
 * rarely: first after the fifth tool call of a session, then every ten
 * minutes, each time for twenty seconds, rotating through the messages. Once
 * the person clicks it or closes it, it never shows again — remembered in
 * `~/.public-browser/nudge.json`, not per website.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface NudgeMessage {
  text: string;
  href: string;
}

export const NUDGE_MESSAGES: readonly NudgeMessage[] = [
  { text: "★ Star Public Browser on GitHub", href: "https://github.com/Silbercue/public-browser" },
  {
    text: "Works wonderfully with Jev →",
    href: "https://github.com/Silbercue/public-browser#perfect-for-jev--a-decision-model-needs-a-menu-public-browser-hands-it-one",
  },
];

export const DEFAULT_NUDGE_STORE = join(homedir(), ".public-browser", "nudge.json");

export interface StarNudgeOptions {
  /** Where the dismissal is remembered. Default `~/.public-browser/nudge.json`. */
  storePath?: string;
  /** Clock, for tests. */
  now?: () => number;
  /** False in headless sessions — nobody is watching the bar. Default true. */
  enabled?: boolean;
  /** Tool call on which the nudge appears for the first time. Default 5. */
  firstAfterCalls?: number;
  /** Pause between appearances. Default 10 minutes. */
  everyMs?: number;
  /** How long one appearance stays. Default 20 seconds. */
  visibleMs?: number;
}

export class StarNudge {
  private readonly storePath: string;
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly firstAfterCalls: number;
  private readonly everyMs: number;
  private readonly visibleMs: number;

  private calls = 0;
  private dismissed: boolean;
  private shownAt: number | null = null;
  private messageIndex = -1;

  constructor(options: StarNudgeOptions = {}) {
    this.storePath = options.storePath ?? DEFAULT_NUDGE_STORE;
    this.now = options.now ?? Date.now;
    this.enabled = options.enabled ?? true;
    this.firstAfterCalls = options.firstAfterCalls ?? 5;
    this.everyMs = options.everyMs ?? 10 * 60_000;
    this.visibleMs = options.visibleMs ?? 20_000;
    this.dismissed = this.readDismissed();
  }

  /** Call once per tool call. Returns the message to show right now, or null to hide. */
  onToolCall(): NudgeMessage | null {
    if (!this.enabled || this.dismissed) return null;
    this.calls++;
    const t = this.now();
    if (this.shownAt === null) {
      if (this.calls < this.firstAfterCalls) return null;
      return this.startShowing(t);
    }
    if (t - this.shownAt < this.visibleMs) return NUDGE_MESSAGES[this.messageIndex];
    if (t - this.shownAt >= this.everyMs) return this.startShowing(t);
    return null;
  }

  /** The person clicked the link or closed the nudge — never show it again. */
  dismiss(reason: "starred" | "closed"): void {
    this.dismissed = true;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify({ dismissed: true, reason, at: new Date(this.now()).toISOString() }));
    } catch {
      // Not remembering is the worst case — the nudge shows again next session.
    }
  }

  private startShowing(t: number): NudgeMessage {
    this.shownAt = t;
    this.messageIndex = (this.messageIndex + 1) % NUDGE_MESSAGES.length;
    return NUDGE_MESSAGES[this.messageIndex];
  }

  private readDismissed(): boolean {
    try {
      if (!existsSync(this.storePath)) return false;
      const parsed = JSON.parse(readFileSync(this.storePath, "utf8")) as { dismissed?: unknown };
      return parsed.dismissed === true;
    } catch {
      return false;
    }
  }
}

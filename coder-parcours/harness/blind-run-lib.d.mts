// Typen fuer blind-run-lib.mjs (siehe dort). Nur die im Coder-Parcours genutzten Exporte von test-hardest/blind-run.mjs.

export interface BlindRunDeps {
  claude: { file: string; argsPrefix: string[] };
  chromeBin: string | null;
  measureDir: string;
  resultsDir: string;
  projectsDir: string | null;
  suiteFetch: (url: string) => Promise<string>;
  now: () => Date;
  envOverrides: Record<string, string>;
  [key: string]: unknown;
}

export function defaultDeps(): BlindRunDeps;
export function scrubProviderKeys(env: Record<string, string | undefined>): Record<string, string | undefined>;
export const MODEL_PIN: string;

// Fuer harness/run-session.mjs (Task 13).
export interface SpawnResult { code: number | null; signal: string | null; stdout: string; timedOut: boolean; pid: number; error: Error | null }
export function spawnWithTimeout(file: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number; stderrFile: string }): Promise<SpawnResult>;
export function sh(file: string, args: string[], opts?: Record<string, unknown>): string;
export function killGroup(pid: number | null | undefined, sig: string): void;
export function isAlive(pid: number | null | undefined): boolean;
export function probeServerInfo(participant: { name: string; command: string; args: string[] }, env?: Record<string, string>, deps?: unknown,
  opts?: { timeoutMs?: number; cwd?: string }): Promise<{ name: string | null; version: string | null; instructions: string | null }>;
export interface CallRow { tool_use_id: string; name: string; chars: number; ms: number | null; result_text: string; output_tokens?: number }
export function mcpCallsFromJsonl(jsonlText: string, prefix: string): CallRow[];
export function cliCallsFromJsonl(jsonlText: string, cli: string): CallRow[];
export function jsonlSlugFor(dir: string): string;
export function readModelFromJsonl(jsonlText: string): string | null;
export function usageTotal(u: unknown): number | null;

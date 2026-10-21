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

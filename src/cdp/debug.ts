const isDebug = (process.env.DEBUG ?? "").includes("public-browser");

export function debug(message: string, ...args: unknown[]): void {
  if (!isDebug) return;
  console.error(`[public-browser] ${message}`, ...args);
}

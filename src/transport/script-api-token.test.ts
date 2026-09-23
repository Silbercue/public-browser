import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCRIPT_SERVER_ID,
  SCRIPT_TOKEN_ENV,
  generateScriptToken,
  scriptTokenPath,
  writeScriptTokenFile,
} from "./script-api-token.js";

describe("script-api-token (S1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pb-token-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("nennt Umgebungsvariable und Kennung", () => {
    expect(SCRIPT_TOKEN_ENV).toBe("PUBLIC_BROWSER_SCRIPT_TOKEN");
    expect(SCRIPT_SERVER_ID).toBe("public-browser");
  });

  it("legt pro Port eine eigene Datei an", () => {
    expect(scriptTokenPath(9223, dir)).toBe(join(dir, "script-api-9223.token"));
    expect(scriptTokenPath(9444, dir)).toBe(join(dir, "script-api-9444.token"));
  });

  it("erzeugt 64 Hex-Zeichen, jedes Mal neu", () => {
    const a = generateScriptToken();
    const b = generateScriptToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it.skipIf(process.platform === "win32")(
    "schreibt den Schluessel mit 0600, auch ueber eine alte Datei mit 0644",
    () => {
      mkdirSync(join(dir, "home"));
      const file = scriptTokenPath(9444, join(dir, "home"));
      writeFileSync(file, "alt", { mode: 0o644 });

      writeScriptTokenFile(file, "neu");

      expect(readFileSync(file, "utf8")).toBe("neu");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")("legt einen fehlenden Ordner mit 0700 an", () => {
    const home = join(dir, "neu");
    writeScriptTokenFile(scriptTokenPath(9445, home), "k");
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("ersetzt die Datei ueber eine Temp-Datei und laesst keine Reste liegen (P34)", () => {
    const home = join(dir, "home");
    const file = scriptTokenPath(9446, home);
    writeScriptTokenFile(file, "erst");
    writeScriptTokenFile(file, "dann");

    expect(readFileSync(file, "utf8")).toBe("dann");
    expect(readdirSync(home)).toEqual(["script-api-9446.token"]);
  });

  it("raeumt die Temp-Datei weg, wenn das Umbenennen scheitert (P34)", () => {
    const home = join(dir, "home");
    const file = scriptTokenPath(9447, home);
    // A non-empty directory at the target makes rename fail on every platform.
    mkdirSync(file, { recursive: true });
    writeFileSync(join(file, "inhalt"), "x");

    expect(() => writeScriptTokenFile(file, "k")).toThrow();
    expect(readdirSync(home)).toEqual(["script-api-9447.token"]);
  });

  it.skipIf(process.platform === "win32")(
    "ersetzt einen Symlink am Zielort, statt durch ihn hindurch zu schreiben (P34)",
    () => {
      const home = join(dir, "home");
      mkdirSync(home);
      const victim = join(dir, "fremde-datei");
      writeFileSync(victim, "unberuehrt");
      const file = scriptTokenPath(9448, home);
      symlinkSync(victim, file);

      writeScriptTokenFile(file, "neu");

      expect(readFileSync(victim, "utf8")).toBe("unberuehrt");
      expect(lstatSync(file).isSymbolicLink()).toBe(false);
      expect(readFileSync(file, "utf8")).toBe("neu");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );
});

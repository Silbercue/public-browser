import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromeUsingProfile, removeOrphanedWrappers } from "./profile-in-use.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("findChromeUsingProfile (S2)", () => {
  let base: string;
  let profile: string;
  let wrapper: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "pb-inuse-"));
    profile = join(base, "real", "Profile 1");
    mkdirSync(profile, { recursive: true });
    wrapper = join(base, "public-browser-profile-0a1b2c3d");
    mkdirSync(wrapper);
    symlinkSync(profile, join(wrapper, "Profile 1"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const line = (pid: number, extra = "") =>
    ` ${pid} ${CHROME} --remote-debugging-pipe --user-data-dir=${wrapper} --profile-directory=Profile 1${extra}`;

  it("meldet den Chrome, dessen Wrapper auf dasselbe Profil zeigt", () => {
    expect(findChromeUsingProfile(profile, "Profile 1", () => `${line(4242)}\n`)).toBe(4242);
  });

  it("ueberspringt Hilfsprozesse (--type=…)", () => {
    expect(findChromeUsingProfile(profile, "Profile 1", () => line(4243, " --type=renderer"))).toBeNull();
  });

  it("ignoriert einen Wrapper, der auf ein anderes Profil zeigt", () => {
    const other = join(base, "real", "Profile 2");
    mkdirSync(other);
    expect(findChromeUsingProfile(other, "Profile 1", () => line(4242))).toBeNull();
  });

  it("ignoriert Chrome-Prozesse ohne Public-Browser-Wrapper", () => {
    const plain = ` 99 ${CHROME} --user-data-dir=${join(base, "real")} --profile-directory=Profile 1`;
    expect(findChromeUsingProfile(profile, "Profile 1", () => plain)).toBeNull();
  });

  it("ignoriert einen Wrapper, der schon geloescht ist", () => {
    rmSync(wrapper, { recursive: true, force: true });
    expect(findChromeUsingProfile(profile, "Profile 1", () => line(4242))).toBeNull();
  });

  it("gibt null zurueck, wenn ps fehlt (Windows)", () => {
    expect(
      findChromeUsingProfile(profile, "Profile 1", () => {
        throw new Error("spawn ps ENOENT");
      }),
    ).toBeNull();
  });
});

// P34: Ein Chrome, der per SIGKILL starb, hinterlaesst seinen Wrapper samt Symlink aufs echte Profil.
describe("removeOrphanedWrappers (S2)", () => {
  const NOW = Date.now();
  let base: string;
  let profile: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "pb-orphan-"));
    profile = join(base, "real", "Profile 1");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "Cookies"), "keep");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Wrapper wie launchChrome ihn baut, mit gesetztem Alter. */
  function wrapperAged(name: string, ageMs: number): string {
    const dir = join(base, name);
    mkdirSync(dir);
    symlinkSync(profile, join(dir, "Profile 1"));
    const t = new Date(NOW - ageMs);
    utimesSync(dir, t, t);
    return dir;
  }

  it("loescht alte Wrapper ohne Chrome, nie das Profil dahinter", () => {
    const orphan = wrapperAged("public-browser-profile-0000aaaa", 10 * 60_000);
    const live = wrapperAged("public-browser-profile-0000bbbb", 10 * 60_000);
    const starting = wrapperAged("public-browser-profile-0000cccc", 1_000);
    const tempProfile = join(base, "public-browser-1234abcd");
    mkdirSync(tempProfile);
    const old = new Date(NOW - 10 * 60_000);
    utimesSync(tempProfile, old, old);
    const ps = ` 4242 ${CHROME} --remote-debugging-pipe --user-data-dir=${live} --profile-directory=Profile 1\n`;

    expect(removeOrphanedWrappers(base, () => ps, NOW)).toEqual([orphan]);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live)).toBe(true); // ein Chrome nutzt ihn noch
    expect(existsSync(starting)).toBe(true); // ein Start kann gerade laufen
    expect(existsSync(tempProfile)).toBe(true); // kein Profil-Wrapper
    expect(readFileSync(join(profile, "Cookies"), "utf-8")).toBe("keep");
  });

  it("loescht nichts, wenn ps fehlt (Windows) — ohne Prozessliste ist nichts sicher verwaist", () => {
    const orphan = wrapperAged("public-browser-profile-0000dddd", 10 * 60_000);
    expect(
      removeOrphanedWrappers(base, () => {
        throw new Error("spawn ps ENOENT");
      }, NOW),
    ).toEqual([]);
    expect(existsSync(orphan)).toBe(true);
  });
});

// Review M1: ein Leerzeichen im Temp-Pfad darf weder den Profil-Schutz noch das
// Aufraeumen aushebeln. Gegenprobe: derselbe Fall ohne Leerzeichen.
describe.each([
  { label: "mit Leerzeichen", prefix: "pb space " },
  { label: "ohne Leerzeichen", prefix: "pb-nospace-" },
])("Wrapper-Pfad $label im Temp-Ordner (S2)", ({ prefix }) => {
  const NOW = Date.now();
  let base: string;
  let profile: string;
  let wrapper: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), prefix));
    profile = join(base, "real", "Profile 1");
    mkdirSync(profile, { recursive: true });
    wrapper = join(base, "public-browser-profile-0000ffff");
    mkdirSync(wrapper);
    symlinkSync(profile, join(wrapper, "Profile 1"));
    const old = new Date(NOW - 10 * 60_000);
    utimesSync(wrapper, old, old);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const ps = () =>
    ` 4242 ${CHROME} --remote-debugging-pipe --user-data-dir=${wrapper} --profile-directory=Profile 1\n`;

  it("findChromeUsingProfile meldet die PID des laufenden Chrome", () => {
    expect(findChromeUsingProfile(profile, "Profile 1", ps)).toBe(4242);
  });

  it("removeOrphanedWrappers laesst den Wrapper des laufenden Chrome stehen", () => {
    expect(removeOrphanedWrappers(base, ps, NOW)).toEqual([]);
    expect(existsSync(wrapper)).toBe(true);
  });
});

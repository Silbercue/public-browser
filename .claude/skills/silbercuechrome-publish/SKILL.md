---
name: silbercuechrome-publish
description: Release-Skill fuer SilbercueChrome. Prueft beide Repos (public Free + private Pro), bumpt die Version, baut + testet, dry-run, dann npm publish + GitHub Release ueber scripts/publish.ts. Trigger-Phrasen: "publish", "release", "veroeffentlichen", "neues release", "version pushen", "deploy", "npm publish", "auf npm bringen", "rausbringen", "an die endkunden bringen"
---

# SilbercueChrome Publish

Release-Skill fuer das SilbercueChrome Open-Core-Projekt: bringt den lokalen Stand als neue Version zu den Endkunden ueber `npx @silbercue/chrome@latest`.

## Architektur

Zwei separate GitHub-Repos bilden zusammen das Distribution-Bundle:

| Repo | Pfad | GitHub | npm-Paket |
|------|------|--------|-----------|
| **Public (Free)** | `/Users/silbercue/Documents/Cursor/Skills/SilbercueChrome` | `Silbercue/silbercuechrome` | `@silbercue/chrome` |
| **Private (Pro)** | `/Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro` | `Silbercue/SilbercueChromePro` | `silbercuechrome-pro` (intern, npm published) |

Anders als SilbercueSwift wird hier **nicht** ueber GitHub Actions / Tag-Push getriggert, sondern direkt ueber das lokale Pipeline-Script `scripts/publish.ts` (`npm run publish:release`). Das macht in einem Rutsch: Push beider Repos → Build + Tests → Tag → `npm publish` → `gh release create` → Verify.

## Voraussetzung — Live-Verifikation

**Bevor du diesen Skill startest:** der User muss bestaetigt haben dass der lokale Build live im echten Claude-Code-MCP getestet wurde. Hintergrund: Die `~/.claude.json` zeigt fuer die Test-Phase auf `node /Users/.../build/index.js` statt auf `npx @silbercue/chrome@latest`. Wenn der lokale Build nicht live verifiziert ist, geht ggf. ein Bug an alle User raus.

Wenn unklar: nicht publishen, erst mit dem User klaeren.

## Ablauf — 6 Phasen

Fuehre ALLE Phasen der Reihe nach aus. Ueberspringe keine Phase.

### Phase 1: Status beider Repos pruefen

```bash
# Free Repo
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
echo "=== FREE REPO ==="
git status --short
git log --oneline -5
git tag --sort=-v:refname | head -5
node -p "require('./package.json').version"

# Pro Repo
cd /Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro
echo "=== PRO REPO ==="
git status --short
git log --oneline -5
git log origin/master..HEAD --oneline  # ungepushte Commits
node -p "require('./package.json').version"
```

**Pruefe:**
- Working tree beider Repos sauber? (akzeptable Ignorables im Free-Repo: `prompt.md`, `marketing/`)
- Beide auf Branch `master`?
- Versionen in beiden `package.json` gleich?
- npm authentifiziert? `npm whoami`
- gh CLI authentifiziert? `gh auth status`

Zeige dem User eine Kurz-Zusammenfassung:
```
FREE: [clean/dirty] | vX.Y.Z | N ungepushte Commits
PRO:  [clean/dirty] | vX.Y.Z | N ungepushte Commits
npm:  ok / NICHT EINGELOGGT
gh:   ok / NICHT AUTH
```

Wenn etwas klemmt: STOPP, gemeinsam mit User fixen.

### Phase 2: Aenderungen committen und pushen

Falls einer der Repos uncommitted Changes hat: vorher mit dem User klaeren ob die ins Release sollen oder nicht. Wenn ja → committen. Wenn nein → ggf. stashen oder erst in einem separaten Schritt rausnehmen.

`scripts/publish.ts` pusht in Phase 2 selbst — du musst hier nichts manuell pushen. Nur sicherstellen dass alles committed ist.

```bash
# Falls Free-Repo dirty:
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
git add <files>
git commit -m "<message>"

# Falls Pro-Repo dirty:
cd /Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro
git add <files>
git commit -m "<message>"
```

### Phase 3: Version bestimmen

Lese den letzten Tag und schlage eine neue Version vor:

```bash
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
git tag --sort=-v:refname | head -1
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline
```

**Versionsregeln (SemVer):**
- **Patch** (0.2.0 → 0.2.1): Bug-Fixes, kein Verhaltenswechsel fuer User
- **Minor** (0.2.0 → 0.3.0): Neue Features oder spuerbare Verhaltensaenderung, API rueckwaertskompatibel
- **Major** (0.2.0 → 1.0.0): Breaking Changes in der API

Schlage dem User die passende Version vor basierend auf den Commits seit dem letzten Tag. Heuristik:
- Nur `fix:` → patch
- `feat:` oder `refactor:` mit Verhaltensaenderung → minor
- `BREAKING CHANGE` im Commit-Body → major

Warte auf Bestaetigung vom User.

### Phase 4: package.json in beiden Repos updaten + committen

NICHT `npm version` benutzen — das macht automatisch git tag, was wir scripts/publish.ts ueberlassen. Stattdessen direkt die JSON-Datei rewrites:

```bash
# Free-Repo
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
python3 -c "
import json
with open('package.json') as f: d = json.load(f)
d['version'] = '<NEW_VERSION>'
with open('package.json', 'w') as f: json.dump(d, f, indent=2); f.write('\n')
"
git add package.json
git commit -m "chore: bump version to v<NEW_VERSION>"

# Pro-Repo (Versionen MUESSEN matchen — publish.ts faellt sonst hart)
cd /Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro
python3 -c "
import json
with open('package.json') as f: d = json.load(f)
d['version'] = '<NEW_VERSION>'
with open('package.json', 'w') as f: json.dump(d, f, indent=2); f.write('\n')
"
git add package.json
git commit -m "chore: bump version to v<NEW_VERSION>"
```

Nicht pushen — `publish.ts` macht das in Phase 2 selbst.

### Phase 5: Dry-Run

```bash
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
npm run publish:release -- --dry-run
```

Lies den Output sorgfaeltig. Erwartet:
- **Phase 1:** `Repo status OK (vX.Y.Z)`
- **Phase 2:** `repo: N commit(s) ahead` und `[DRY-RUN] Would push ...`
- **Phase 3:** Build + Tests echt durchgelaufen, alle gruen. Fuer Pro-Repo: `npm install`, `npm run build`, `npm pack` simuliert.
- **Phase 4:** Tag-Erstellung simuliert
- **Phase 5:** `[DRY-RUN] Would publish to npm: @silbercue/chrome@X.Y.Z` und `[DRY-RUN] Would create GitHub release vX.Y.Z`
- **Phase 6:** Verify-Schritt simuliert

Wenn irgendwas im Dry-Run scheitert: STOPP, mit User fixen, dann nochmal Dry-Run.

### Phase 5b: User-Konfirmation

Zeig dem User eine kurze Zusammenfassung:
- Welche Version raus geht
- Wieviele Commits seit dem letzten Tag drin sind (`git log $LAST_TAG..HEAD --oneline`)
- Pro-Repo bewegt sich mit
- Naechste Aktion: `npm run publish:release` (echter Publish)

Frage dann konkret: **"Soll ich publishen?"** Warte auf eindeutige Bestaetigung ("ja", "go", "publish", "raus damit"). Bei Unsicherheit: nicht publishen.

### Phase 6: Echter Publish

```bash
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
npm run publish:release
```

Streame den Output mit. Das Script macht:
1. Phase 1 Sanity-Check
2. Phase 2 Push beider Repos
3. Phase 3 Build + Tests + Pro-Build + npm pack
4. Phase 4 Tag erstellen + pushen
5. Phase 5 `npm publish` + `gh release create`
6. Phase 6 Verify

Wenn Fehler:
- **Phase 1-4:** Meist kein Schaden, fixen und retry
- **Phase 5 mid-stream (npm publish geklappt, gh release nicht):** Paket ist live, nur GitHub Release fehlt. Manuell nachholen: `gh release create vX.Y.Z --generate-notes`
- **Phase 6:** Publish ist durch, nur Verify hat ein Problem. Manuell pruefen mit `npm view @silbercue/chrome version` und `gh release view vX.Y.Z`

### Phase 7: Verifizieren und User informieren

```bash
npm view @silbercue/chrome version
gh release view v<NEW_VERSION>
git log -1 --format="%H %s"
```

Alle drei sollten konsistent die neue Version zeigen.

Sage dem User:
1. **Version live** auf `https://www.npmjs.com/package/@silbercue/chrome`
2. **GitHub Release** auf `https://github.com/Silbercue/silbercuechrome/releases/tag/v<NEW_VERSION>`
3. **Pro-Repo Update** falls relevant
4. **Hinweis Claude-Code-Config:** Wenn die `~/.claude.json` aktuell auf den lokalen Build zeigt (`node /Users/.../build/index.js`), kann der User sie jetzt zurueck auf `npx @silbercue/chrome@latest` umbiegen. Backup liegt ggf. unter `~/.claude.json.backup-*`. Frag den User ob er das jetzt machen will.

## Fehlerbehebung

### "Free repo has uncommitted changes"
`scripts/publish.ts` ist hart bei working-tree status. Akzeptable Ignorables (`prompt.md`, `marketing/`) muessen vorher entweder committed, gestasht oder bewusst entfernt werden — `publish.ts` kennt keine Ausnahmen. Im Zweifel mit dem User klaeren.

### "Version mismatch: free=X.Y.Z, pro=A.B.C"
Pro-Repo hat eine andere Version in `package.json`. Beide muessen exakt matchen. Phase 4 nochmal sauber durchlaufen.

### "npm not authenticated"
```bash
npm login
```
Im interaktiven Terminal-Prompt — der MCP kann das nicht selber machen. User muss es im Terminal tippen. Hinweis: Der User kann `! npm login` direkt im Claude-Code-Prompt eingeben damit es in der Session laeuft.

### "gh CLI not authenticated"
```bash
gh auth login
```
Selber Hinweis wie bei npm.

### npm publish gescheitert mit "EPRIVATE"
Free-Repo `package.json` hat `"private": true`. Auf `false` setzen, committen, retry. (`scripts/publish.ts` hat dafuer einen Hard-Fail in Phase 1.)

### Tests rot in Phase 3
Stoppen. `npm test` lokal ausfuehren, Fehler analysieren, fixen, committen. Dann nochmal von vorne.

### Pro-Repo nicht gefunden
Wenn `../silbercuechrome-pro` nicht existiert, laeuft `publish.ts` im "Free-Only release" Modus. Kein Fehler — aber dann werden auch nur die Free-Bits released. Falls der User erwartet hat dass das Pro-Paket mit released wird: STOPP und Pro-Repo erst klonen.

## Sicherheits-Regeln

NIE brechen, auch wenn der User es nahelegt:

1. **Kein Publish ohne explizite User-Konfirmation in Phase 5b.** "Mach mal" reicht nicht — es muss klar auf "Soll ich publishen?" geantwortet werden.
2. **Keine `--skip-npm` / `--skip-github` Flags** in Production-Releases. Die sind nur fuer Debugging.
3. **Kein `npm unpublish`.** Wenn was schiefgeht — auch wenn der User danach fragt — erst mit ihm reden. `unpublish` ist innerhalb 72h moeglich aber npm hasst es. Lieber Patch-Version drueberlegen.
4. **Keine `--force`-Flags** auf git oder npm Befehle. Wenn was nicht klappt, Root Cause finden.
5. **Niemals nur Pro-Repo allein publishen.** Free-Repo muss immer mit. `publish.ts` setzt das schon richtig durch, aber sei vorsichtig wenn jemand "nur Pro" vorschlaegt.

## Checkliste (Kurzfassung)

- [ ] Live-Verifikation des lokalen Builds vom User bestaetigt
- [ ] Phase 1: Status beider Repos geprueft, npm + gh authentifiziert
- [ ] Phase 2: Uncommitted Changes entweder committed oder geklaert
- [ ] Phase 3: Version mit User abgestimmt
- [ ] Phase 4: package.json in beiden Repos gebumpt + committed
- [ ] Phase 5: Dry-Run gruen
- [ ] Phase 5b: User-Konfirmation eingeholt
- [ ] Phase 6: `npm run publish:release` durchgelaufen
- [ ] Phase 7: npm registry, GitHub release und git tag verifiziert
- [ ] User informiert (Links + ggf. Claude-Config-Reset)

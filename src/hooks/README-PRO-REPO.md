# Pro-Repo Setup Guide

## Uebersicht

Das Pro-Repo (`silbercuechrome-pro`) erweitert den Free-Tier-Code mit Pro-Features.
Es importiert `@silbercuechrome/mcp` als Dependency und registriert Pro-Implementierungen
ueber das Hook-System.

## Pro-Repo Struktur

```
silbercuechrome-pro/
  src/
    index.ts          # Entry-Point: registerProHooks() + startServer()
    gates/
      dom-snapshot.ts # featureGate fuer dom_snapshot
    ...
  package.json
  tsconfig.json
```

## package.json

```json
{
  "name": "@silbercuechrome/mcp-pro",
  "type": "module",
  "main": "./build/index.js",
  "bin": {
    "silbercuechrome-pro": "./build/index.js"
  },
  "dependencies": {
    "@silbercuechrome/mcp": "file:../silbercuechrome"
  }
}
```

Nach npm-Publish kann `file:../silbercuechrome` durch eine Versionsreferenz ersetzt werden.

## tsconfig.json

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "build", "src/**/*.test.ts"]
}
```

## Entry-Point (src/index.ts)

```typescript
#!/usr/bin/env node
import { registerProHooks } from "@silbercuechrome/mcp/hooks";
import { startServer } from "@silbercuechrome/mcp";

// Register Pro-Feature-Implementierungen VOR startServer()
registerProHooks({
  featureGate: (toolName) => {
    // Beispiel: dom_snapshot nur fuer Pro-User
    if (toolName === "dom_snapshot") {
      return { allowed: false, message: "dom_snapshot requires a Pro license" };
    }
    return { allowed: true };
  },
  // enhanceTool und onToolResult optional
});

startServer();
```

## Abhaengigkeitsrichtung

```
silbercuechrome-pro  -->  @silbercuechrome/mcp
     (privat)              (oeffentlich)
```

Das Free-Repo hat KEIN Wissen ueber das Pro-Repo.
Kein `try/catch`-Import, kein bedingter `require()`.

## Build-Prozess

```bash
# Im Pro-Repo:
npm install          # Installiert @silbercuechrome/mcp als Dependency
npm run build        # Kompiliert Pro-Code
node build/index.js  # Startet Pro-Server
```

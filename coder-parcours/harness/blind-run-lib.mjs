// blind-run-lib.mjs — einziger Importweg aus test-hardest/blind-run.mjs fuer den Coder-Parcours.
// Grund: tsconfig.node.json prueft JS mit checkJs; ein direkter Import zieht blind-run.mjs ins Programm, und dort
// meldet tsc Fehler, die wir nicht beheben duerfen (test-hardest/ bleibt unveraendert). TypeScript loest diesen
// Import ueber blind-run-lib.d.mts auf und folgt blind-run.mjs deshalb nicht. Wer weitere Exporte braucht,
// traegt sie dort ein.
export * from '../../test-hardest/blind-run.mjs';

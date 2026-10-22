#!/bin/sh
# Startet das echte Google Chrome (CODER_PARCOURS_REAL_CHROME) mit festem Fenster fuer agent-browser: --window-size steht am
# Ende und gilt damit vor dem eigenen Wert von agent-browser (1280,720). Fenster 1280x887 ergibt im neuen Headless-Modus
# einen Anzeigebereich von 1280x800 (87 px Browserrahmen). exec: der Prozess traegt danach den Chrome-Pfad.
exec "$CODER_PARCOURS_REAL_CHROME" "$@" --window-size=1280,887

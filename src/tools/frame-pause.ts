/**
 * Frame-Pause fuer Nachlesungen nach einer Eingabe (drag: Sonde nach dem Drop,
 * press_key: Editor-Zustand nach dem keyUp). Zwei Animation-Frames, hoechstens
 * FRAME_PAUSE_MAX_MS — versteckte Tabs drosseln requestAnimationFrame. Der
 * Ausdruck ist ein Promise, das mit `true` aufloest (Runtime.evaluate mit
 * awaitPromise).
 */
export const FRAME_PAUSE_MAX_MS = 100;

export const FRAME_PAUSE_EXPRESSION = `new Promise(function (resolve) {
  var done = false;
  var finish = function () { if (!done) { done = true; resolve(true); } };
  setTimeout(finish, ${FRAME_PAUSE_MAX_MS});
  requestAnimationFrame(function () { requestAnimationFrame(finish); });
})`;

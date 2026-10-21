// Test fixture: leaves a detached listener behind (like a browser or publicbrowser server a test
// forgot to close), then checks the coupon flow. Port comes from ./PORT next to this file.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const port = Number(readFileSync(`${here}PORT`, 'utf8').trim());

if (process.argv[2] === 'serve') {
  createServer((s) => s.end()).listen(port, '127.0.0.1');
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: 'ignore' }).unref();
  const up = () => new Promise((r) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); r(true); });
    s.once('error', () => r(false));
  });
  for (let i = 0; i < 100 && !(await up()); i++) await new Promise((r) => setTimeout(r, 50));

  const base = process.env.APP_URL ?? '';
  const jar = new Map();
  const call = async (method, path, body) => {
    const res = await fetch(new URL(path, base), {
      method, headers: { 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res.json();
  };
  const { classes } = await call('GET', '/api/classes');
  const open = classes.find((k) => !k.full && !k.ended);
  const before = (await call('POST', '/api/cart/items', { classId: open.id, spots: 1 })).totalCents;
  await call('POST', '/api/cart/coupon', { code: 'YOGA10' });
  const after = (await call('GET', '/api/cart')).totalCents;
  process.exit(after === before - Math.round(before * 0.1) ? 0 : 1);
}

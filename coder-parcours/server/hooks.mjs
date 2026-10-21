// Route hooks: bug modules attach `before` and `after` handlers to API routes by key ('POST /api/cart/coupon').

/**
 * Hook context handed to every hook of one request.
 * @typedef {{ req: any, body: any, sandbox: any, session: any, validate: boolean,
 *   respond: (status: number, body: any) => void, event: (name: string, bug?: string) => void,
 *   expireSession: () => void, cart: () => Promise<any> }} HookCtx
 */

/**
 * @returns {{ before: (key: string, fn: (ctx: HookCtx) => any) => void,
 *   after: (key: string, fn: (ctx: HookCtx, body: any) => any) => void,
 *   runBefore: (key: string, ctx: any) => Promise<boolean>,
 *   runAfter: (key: string, ctx: any, body: any) => Promise<any> }}
 */
export function createHookSet() {
  /** @type {Map<string, Function[]>} */
  const beforeMap = new Map();
  /** @type {Map<string, Function[]>} */
  const afterMap = new Map();
  const add = (map, key, fn) => {
    if (typeof fn !== 'function') throw new Error(`hook for ${key} must be a function`);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(fn);
  };
  return {
    before: (key, fn) => add(beforeMap, key, fn),
    after: (key, fn) => add(afterMap, key, fn),
    /** Runs the before hooks in order; stops at the first one that answered. Returns whether one answered. */
    async runBefore(key, ctx) {
      const fns = beforeMap.get(key);
      if (!fns) return false;
      const respond = ctx.respond;
      let answered = false;
      ctx.respond = (status, body) => {
        answered = true;
        respond(status, body);
      };
      try {
        for (const fn of fns) {
          await fn(ctx);
          if (answered) break;
        }
      } finally {
        ctx.respond = respond;
      }
      return answered;
    },
    /** Chains the after hooks over the body; a hook returning undefined keeps the body. */
    async runAfter(key, ctx, body) {
      let out = body;
      for (const fn of afterMap.get(key) ?? []) {
        const next = await fn(ctx, out);
        if (next !== undefined) out = next;
      }
      return out;
    },
  };
}

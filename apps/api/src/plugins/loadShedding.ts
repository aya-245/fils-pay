import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

/**
 * Load shedding: reject excess work immediately with
 * `503 { error: "overloaded" }` + `Retry-After` instead of letting it queue
 * (in the pg pool, in pay.ts's slot queue, in the event loop) until every
 * request — admitted ones included — blows its latency budget or times out.
 *
 * Three independent gates, each disabled by a 0/undefined limit:
 *  - `maxInflight`: requests currently being handled, across all routes.
 *  - `groups[].maxInflight`: a tighter cap for a class of route (the pay
 *    route holds two DB connections across two acquirer round-trips, so it
 *    saturates long before CPU does). A group may let a few requests wait
 *    briefly for a slot (`maxQueue`, `maxQueueWaitMs`): with ~0.5 s service
 *    times, pure loss-on-busy would shed random bursts well below capacity.
 *  - `maxEventLoopDelayMs`: the p90 event-loop delay over the last sampling
 *    window. Above it the process is CPU-starved (on a 0.5 vCPU quota that
 *    means CFS throttling) and every extra request only makes it worse.
 *
 * Liveness/readiness probes are exempt so Docker's healthcheck never sees an
 * overloaded-but-alive API as dead and restarts it mid-load.
 */
export interface LoadShedGroup {
  name: string;
  maxInflight: number;
  match: (method: string, url: string) => boolean;
  /** Requests allowed to wait for a slot (FIFO) once maxInflight is reached. Default 0. */
  maxQueue?: number;
  /** Longest a queued request waits before it is shed instead, ms. */
  maxQueueWaitMs?: number;
}

export interface LoadSheddingOptions {
  maxInflight?: number;
  groups?: LoadShedGroup[];
  maxEventLoopDelayMs?: number;
  retryAfterSeconds?: number;
  /** Exact paths (query string ignored) that are never shed. */
  exemptPaths?: string[];
  /** How often the event-loop delay histogram is sampled and reset, ms. */
  sampleIntervalMs?: number;
  /** Test seam: replaces the perf_hooks sampler. */
  eventLoopDelaySampler?: () => number;
}

export interface LoadShedStats {
  inflight: number;
  groupInflight: Record<string, number>;
  eventLoopDelayMs: number;
  groupQueued: Record<string, number>;
  shed: { inflight: number; group: number; queueTimeout: number; eventLoop: number };
}

declare module "fastify" {
  interface FastifyInstance {
    loadShedStats: () => LoadShedStats;
  }
}

const ADMITTED = Symbol("loadShedAdmitted");
type Tracked = FastifyRequest & { [ADMITTED]?: { released: boolean; group: LoadShedGroup | null } };

function pathOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

async function loadSheddingPlugin(app: FastifyInstance, opts: LoadSheddingOptions): Promise<void> {
  const maxInflight = opts.maxInflight ?? 0;
  const groups = (opts.groups ?? []).filter((g) => g.maxInflight > 0);
  const maxDelay = opts.maxEventLoopDelayMs ?? 0;
  const retryAfter = String(Math.max(1, opts.retryAfterSeconds ?? 1));
  const exempt = new Set(opts.exemptPaths ?? ["/healthz", "/readyz"]);

  let inflight = 0;
  const groupInflight = new Map<string, number>(groups.map((g) => [g.name, 0]));
  const queues = new Map<string, Array<(admitted: boolean) => void>>(groups.map((g) => [g.name, []]));
  const shed = { inflight: 0, group: 0, queueTimeout: 0, eventLoop: 0 };

  let delayMs = 0;
  let histogram: IntervalHistogram | null = null;
  let timer: NodeJS.Timeout | null = null;
  if (maxDelay > 0) {
    let sample = opts.eventLoopDelaySampler;
    if (!sample) {
      const h = monitorEventLoopDelay({ resolution: 10 });
      h.enable();
      histogram = h;
      sample = () => {
        const v = h.count > 0 ? h.percentile(90) / 1e6 : 0;
        h.reset();
        return v;
      };
    }
    const s = sample;
    timer = setInterval(() => {
      delayMs = s();
    }, opts.sampleIntervalMs ?? 500);
    timer.unref();
  }

  app.decorate("loadShedStats", (): LoadShedStats => ({
    inflight,
    groupInflight: Object.fromEntries(groupInflight),
    groupQueued: Object.fromEntries([...queues].map(([k, q]) => [k, q.length])),
    eventLoopDelayMs: delayMs,
    shed: { ...shed },
  }));

  function reject(reply: FastifyReply, reason: string): FastifyReply {
    return reply
      .code(503)
      .header("retry-after", retryAfter)
      .send({ error: "overloaded", message: `server overloaded (${reason}); retry after ${retryAfter}s` });
  }

  function release(request: Tracked): void {
    const state = request[ADMITTED];
    if (!state || state.released) return;
    state.released = true;
    inflight--;
    if (state.group) {
      // Hand the slot straight to the oldest waiter (count unchanged), else free it.
      const next = queues.get(state.group.name)?.shift();
      if (next) next(true);
      else groupInflight.set(state.group.name, (groupInflight.get(state.group.name) ?? 1) - 1);
    }
  }

  /** Resolves true once a slot was handed over, false on queue timeout. */
  function waitForSlot(group: LoadShedGroup): Promise<boolean> {
    const q = queues.get(group.name)!;
    return new Promise<boolean>((resolve) => {
      const waiter = (admitted: boolean): void => {
        clearTimeout(t);
        resolve(admitted);
      };
      const t = setTimeout(() => {
        const i = q.indexOf(waiter);
        if (i !== -1) q.splice(i, 1);
        resolve(false);
      }, group.maxQueueWaitMs ?? 0);
      q.push(waiter);
    });
  }

  app.addHook("onRequest", async (request: Tracked, reply) => {
    if (exempt.has(pathOf(request.url))) return;

    if (maxDelay > 0 && delayMs > maxDelay) {
      shed.eventLoop++;
      return reject(reply, "event_loop_delay");
    }
    if (maxInflight > 0 && inflight >= maxInflight) {
      shed.inflight++;
      return reject(reply, "inflight");
    }
    let group: LoadShedGroup | null = null;
    // Match the ROUTE the router chose, not the raw URL: "/pay" spelled
    // "%70ay" still reaches the pay handler but would skip the pay cap.
    const routePath = request.routeOptions?.url ?? pathOf(request.url);
    for (const g of groups) {
      if (g.match(request.method, routePath)) {
        group = g;
        break;
      }
    }
    if (group) {
      if ((groupInflight.get(group.name) ?? 0) < group.maxInflight) {
        groupInflight.set(group.name, (groupInflight.get(group.name) ?? 0) + 1);
      } else if ((group.maxQueue ?? 0) > 0 && queues.get(group.name)!.length < group.maxQueue!) {
        // On success the releasing request transferred its slot to us.
        if (!(await waitForSlot(group))) {
          shed.queueTimeout++;
          return reject(reply, `${group.name}_queue_timeout`);
        }
      } else {
        shed.group++;
        return reject(reply, group.name);
      }
    }

    inflight++;
    request[ADMITTED] = { released: false, group };
  });

  // Released when the handler has produced its reply (onSend), not when the
  // socket closes: a client that gives up mid-pay must not free a slot while
  // its handler is still holding DB connections. onSend runs for success,
  // thrown errors and aborted clients alike (onResponse does not run when
  // the client aborted), onResponse is a belt-and-braces second release.
  //
  // Callback-style on purpose, NOT async: every async onSend hook adds
  // microtask hops before Fastify marks the reply sent, and with two of them
  // (this + securityHeaders) a handler that calls reply.send() without
  // `return reply` resolves first, so Fastify's wrapThenable sends AGAIN and
  // logs a phantom 500 (ERR_HTTP_HEADERS_SENT) for every such POST.
  app.addHook("onSend", (request: Tracked, _reply, payload, done) => {
    release(request);
    done(null, payload);
  });
  app.addHook("onResponse", (request: Tracked, _reply, done) => {
    release(request);
    done();
  });

  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    histogram?.disable();
  });
}

export const loadShedding = fp(loadSheddingPlugin, { name: "load-shedding", fastify: "5.x" });

/** `POST /v1/payment-links/:token/pay` */
export function isPayRoute(method: string, path: string): boolean {
  return method === "POST" && /^\/v1\/payment-links\/[^/]+\/pay\/?$/.test(path);
}

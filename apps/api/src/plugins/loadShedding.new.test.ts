import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { isPayRoute, loadShedding, type LoadSheddingOptions } from "./loadShedding.js";
import { errorHandler } from "./errorHandler.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function build(opts: LoadSheddingOptions, gate?: Promise<void>): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(loadShedding, opts);
  app.setErrorHandler(errorHandler);
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));
  app.get("/slow", async () => {
    await gate;
    return { ok: true };
  });
  app.get("/fast", async () => ({ ok: true }));
  app.get("/boom", async () => {
    await gate;
    throw new Error("kaboom");
  });
  app.get("/pool-timeout", async () => {
    throw new Error("timeout exceeded when trying to connect");
  });
  app.post("/v1/payment-links/:token/pay", async () => {
    await gate;
    return { status: "paid" };
  });
  await app.ready();
  return app;
}

test("isPayRoute matches only POST /v1/payment-links/:token/pay", () => {
  assert.equal(isPayRoute("POST", "/v1/payment-links/plink_abc/pay"), true);
  assert.equal(isPayRoute("GET", "/v1/payment-links/plink_abc/pay"), false);
  assert.equal(isPayRoute("GET", "/v1/payment-links/plink_abc"), false);
  assert.equal(isPayRoute("POST", "/v1/merchants/m/payment-links"), false);
});

test("global in-flight cap sheds with 503 + Retry-After + overloaded, probes exempt", async () => {
  const gate = deferred();
  const app = await build({ maxInflight: 2, retryAfterSeconds: 3 }, gate.promise);
  try {
    const held = [app.inject({ url: "/slow" }), app.inject({ url: "/slow" })];
    await new Promise((r) => setImmediate(r));
    assert.equal(app.loadShedStats().inflight, 2);

    const shed = await app.inject({ url: "/fast" });
    assert.equal(shed.statusCode, 503);
    assert.equal(shed.headers["retry-after"], "3");
    assert.equal(shed.json().error, "overloaded");

    for (const probe of ["/healthz", "/readyz", "/healthz?x=1"]) {
      assert.equal((await app.inject({ url: probe })).statusCode, 200, probe);
    }

    gate.resolve();
    for (const r of await Promise.all(held)) assert.equal(r.statusCode, 200);
    assert.equal(app.loadShedStats().inflight, 0);
    assert.equal((await app.inject({ url: "/fast" })).statusCode, 200);
    assert.equal(app.loadShedStats().shed.inflight, 1);
  } finally {
    await app.close();
  }
});

test("pay group cap sheds pays only; other routes keep flowing", async () => {
  const gate = deferred();
  const app = await build(
    { maxInflight: 100, groups: [{ name: "pay", maxInflight: 1, match: isPayRoute }] },
    gate.promise,
  );
  try {
    const first = app.inject({ method: "POST", url: "/v1/payment-links/t1/pay" });
    await new Promise((r) => setImmediate(r));
    const second = await app.inject({ method: "POST", url: "/v1/payment-links/t2/pay" });
    assert.equal(second.statusCode, 503);
    assert.equal(second.json().error, "overloaded");
    assert.equal((await app.inject({ url: "/fast" })).statusCode, 200);
    gate.resolve();
    assert.equal((await first).statusCode, 200);
    assert.deepEqual(app.loadShedStats().groupInflight, { pay: 0 });
    assert.equal((await app.inject({ method: "POST", url: "/v1/payment-links/t3/pay" })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("slots are released when the handler throws", async () => {
  const app = await build({ maxInflight: 1 });
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await app.inject({ url: "/boom" })).statusCode, 500);
    }
    assert.equal(app.loadShedStats().inflight, 0);
    assert.equal((await app.inject({ url: "/fast" })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("event-loop delay above threshold sheds everything but probes", async () => {
  let lag = 0;
  const app = await build({ maxEventLoopDelayMs: 100, sampleIntervalMs: 10, eventLoopDelaySampler: () => lag });
  try {
    assert.equal((await app.inject({ url: "/fast" })).statusCode, 200);
    lag = 500;
    await new Promise((r) => setTimeout(r, 40));
    const shed = await app.inject({ url: "/fast" });
    assert.equal(shed.statusCode, 503);
    assert.equal(shed.json().error, "overloaded");
    assert.equal((await app.inject({ url: "/healthz" })).statusCode, 200);
    lag = 5;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await app.inject({ url: "/fast" })).statusCode, 200);
    assert.ok(app.loadShedStats().shed.eventLoop >= 1);
  } finally {
    await app.close();
  }
});

test("a client that aborts keeps its slot until the handler actually finishes", async () => {
  const gate = deferred();
  const app = await build({ maxInflight: 1 }, gate.promise);
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const req = http.get({ host: "127.0.0.1", port, path: "/slow" });
    req.on("error", () => {});
    await new Promise((r) => setTimeout(r, 50));
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    // Handler still running (still holding whatever it holds): stays counted.
    assert.equal(app.loadShedStats().inflight, 1);
    assert.equal((await app.inject({ url: "/fast" })).statusCode, 503);
    gate.resolve();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.loadShedStats().inflight, 0);
    assert.equal((await app.inject({ url: "/fast" })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("disabled by default: no limits means nothing is shed", async () => {
  const app = await build({});
  try {
    const all = await Promise.all(Array.from({ length: 50 }, () => app.inject({ url: "/fast" })));
    for (const r of all) assert.equal(r.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("pay group queue: a waiter inherits the slot, overflow and timeouts are shed", async () => {
  const gate = deferred();
  const app = await build(
    { groups: [{ name: "pay", maxInflight: 1, maxQueue: 1, maxQueueWaitMs: 300, match: isPayRoute }] },
    gate.promise,
  );
  try {
    const first = app.inject({ method: "POST", url: "/v1/payment-links/a/pay" });
    await new Promise((r) => setImmediate(r));
    const queued = app.inject({ method: "POST", url: "/v1/payment-links/b/pay" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(app.loadShedStats().groupQueued, { pay: 1 });
    const overflow = await app.inject({ method: "POST", url: "/v1/payment-links/c/pay" });
    assert.equal(overflow.statusCode, 503);

    gate.resolve();
    assert.equal((await first).statusCode, 200);
    assert.equal((await queued).statusCode, 200);
    assert.deepEqual(app.loadShedStats().groupInflight, { pay: 0 });
    assert.deepEqual(app.loadShedStats().groupQueued, { pay: 0 });
  } finally {
    await app.close();
  }
});

test("pay group queue: a waiter that times out gets 503 and does not leak a slot", async () => {
  const gate = deferred();
  const app = await build(
    { groups: [{ name: "pay", maxInflight: 1, maxQueue: 4, maxQueueWaitMs: 30, match: isPayRoute }] },
    gate.promise,
  );
  try {
    const first = app.inject({ method: "POST", url: "/v1/payment-links/a/pay" });
    await new Promise((r) => setImmediate(r));
    const timedOut = await app.inject({ method: "POST", url: "/v1/payment-links/b/pay" });
    assert.equal(timedOut.statusCode, 503);
    assert.match(timedOut.json().message, /queue_timeout/);
    gate.resolve();
    assert.equal((await first).statusCode, 200);
    assert.deepEqual(app.loadShedStats().groupInflight, { pay: 0 });
    assert.equal(app.loadShedStats().inflight, 0);
    assert.equal((await app.inject({ method: "POST", url: "/v1/payment-links/c/pay" })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("no double send: reply.send() without `return reply` next to another async onSend hook", async () => {
  // Regression: an async onSend here plus securityHeaders' async onSend let
  // Fastify re-send every such POST, logging a phantom 500 after the real 201.
  const app = Fastify();
  let handlerErrors = 0;
  await app.register(loadShedding, { maxInflight: 10 });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-extra", "1");
    return payload;
  });
  app.setErrorHandler((err, _req, reply) => {
    handlerErrors++;
    reply.code(500).send({ error: String((err as Error).message) });
  });
  app.post("/create", async (_req, reply) => {
    await new Promise((r) => setTimeout(r, 1));
    reply.code(201).send({ ok: true });
  });
  await app.ready();
  try {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/create", payload: { a: 1 } });
      assert.equal(res.statusCode, 201);
    }
    assert.equal(handlerErrors, 0);
    assert.equal(app.loadShedStats().inflight, 0);
  } finally {
    await app.close();
  }
});

test("errorHandler maps a pg pool checkout timeout to 503 overloaded, not 500", async () => {
  const app = await build({});
  try {
    const res = await app.inject({ url: "/pool-timeout" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["retry-after"], "1");
    assert.equal(res.json().error, "overloaded");
  } finally {
    await app.close();
  }
});

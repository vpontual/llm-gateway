import assert from "node:assert/strict";
import test from "node:test";
import {
  checkHealth,
  getVersion,
  getRunningModels,
  getAvailableModels,
  pollServer,
  checkHealthVllm,
  getVllmModels,
  pollVllmServer,
  pollGenericServer,
} from "../../src/lib/ollama";

// Route a fetch mock by URL substring; default 404. Returns a restore fn.
function mockFetchByUrl(routes: Record<string, () => Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    for (const [needle, make] of Object.entries(routes)) {
      if (String(url).includes(needle)) return make();
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function mockFetchThrows() {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("checkHealth true when body says Ollama is running", async () => {
  const restore = mockFetchByUrl({ "/": () => new Response("Ollama is running") });
  try {
    assert.equal(await checkHealth("h:1"), true);
  } finally {
    restore();
  }
});

test("checkHealth false for unexpected body", async () => {
  const restore = mockFetchByUrl({ "/": () => new Response("nope") });
  try {
    assert.equal(await checkHealth("h:1"), false);
  } finally {
    restore();
  }
});

test("checkHealth false on network error", async () => {
  const restore = mockFetchThrows();
  try {
    assert.equal(await checkHealth("h:1"), false);
  } finally {
    restore();
  }
});

test("getVersion returns version, null on error", async () => {
  let restore = mockFetchByUrl({
    "/api/version": () => new Response(JSON.stringify({ version: "0.5.0" })),
  });
  try {
    assert.equal(await getVersion("h:1"), "0.5.0");
  } finally {
    restore();
  }
  restore = mockFetchThrows();
  try {
    assert.equal(await getVersion("h:1"), null);
  } finally {
    restore();
  }
});

test("getRunningModels returns json, null on error", async () => {
  let restore = mockFetchByUrl({
    "/api/ps": () => new Response(JSON.stringify({ models: [{ name: "m" }] })),
  });
  try {
    const r = await getRunningModels("h:1");
    assert.equal(r?.models?.[0]?.name, "m");
  } finally {
    restore();
  }
  restore = mockFetchThrows();
  try {
    assert.equal(await getRunningModels("h:1"), null);
  } finally {
    restore();
  }
});

test("getAvailableModels returns json, null on error", async () => {
  let restore = mockFetchByUrl({
    "/api/tags": () => new Response(JSON.stringify({ models: [{ name: "t" }] })),
  });
  try {
    const r = await getAvailableModels("h:1");
    assert.equal(r?.models?.[0]?.name, "t");
  } finally {
    restore();
  }
  restore = mockFetchThrows();
  try {
    assert.equal(await getAvailableModels("h:1"), null);
  } finally {
    restore();
  }
});

test("pollServer aggregates health, version, running, available", async () => {
  const restore = mockFetchByUrl({
    "/api/version": () => new Response(JSON.stringify({ version: "1.2.3" })),
    "/api/ps": () => new Response(JSON.stringify({ models: [{ name: "run" }] })),
    "/api/tags": () => new Response(JSON.stringify({ models: [{ name: "avail" }] })),
    "/": () => new Response("Ollama is running"),
  });
  try {
    const r = await pollServer("h:1");
    assert.equal(r.isOnline, true);
    assert.equal(r.version, "1.2.3");
    assert.equal(r.runningModels[0].name, "run");
    assert.equal(r.availableModels[0].name, "avail");
  } finally {
    restore();
  }
});

test("pollServer defaults model arrays to [] when endpoints fail", async () => {
  const restore = mockFetchThrows();
  try {
    const r = await pollServer("h:1");
    assert.equal(r.isOnline, false);
    assert.equal(r.version, null);
    assert.deepEqual(r.runningModels, []);
    assert.deepEqual(r.availableModels, []);
  } finally {
    restore();
  }
});

test("checkHealthVllm true via /health", async () => {
  const restore = mockFetchByUrl({ "/health": () => new Response("", { status: 200 }) });
  try {
    assert.equal(await checkHealthVllm("h:1"), true);
  } finally {
    restore();
  }
});

test("checkHealthVllm falls back to /v1/models when /health is not ok", async () => {
  const restore = mockFetchByUrl({
    "/health": () => new Response("", { status: 503 }),
    "/v1/models": () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  });
  try {
    assert.equal(await checkHealthVllm("h:1"), true);
  } finally {
    restore();
  }
});

test("checkHealthVllm false when both endpoints fail", async () => {
  const restore = mockFetchThrows();
  try {
    assert.equal(await checkHealthVllm("h:1"), false);
  } finally {
    restore();
  }
});

test("getVllmModels returns data array, [] on error", async () => {
  let restore = mockFetchByUrl({
    "/v1/models": () => new Response(JSON.stringify({ data: [{ id: "qwen3" }] })),
  });
  try {
    const r = await getVllmModels("h:1");
    assert.equal(r[0].id, "qwen3");
  } finally {
    restore();
  }
  restore = mockFetchThrows();
  try {
    assert.deepEqual(await getVllmModels("h:1"), []);
  } finally {
    restore();
  }
});

test("pollVllmServer maps models to loaded+available shapes", async () => {
  const restore = mockFetchByUrl({
    "/health": () => new Response("", { status: 200 }),
    "/v1/models": () => new Response(JSON.stringify({ data: [{ id: "gemma4:26b" }] })),
  });
  try {
    const r = await pollVllmServer("h:1");
    assert.equal(r.isOnline, true);
    assert.equal(r.version, null);
    assert.equal(r.runningModels[0].name, "gemma4:26b");
    assert.equal(r.runningModels[0].details.format, "vllm");
    assert.equal(r.availableModels[0].name, "gemma4:26b");
  } finally {
    restore();
  }
});

test("pollGenericServer online via /health", async () => {
  const restore = mockFetchByUrl({ "/health": () => new Response("", { status: 200 }) });
  try {
    const r = await pollGenericServer("h:1");
    assert.equal(r.isOnline, true);
    assert.deepEqual(r.runningModels, []);
  } finally {
    restore();
  }
});

test("pollGenericServer falls back to root path", async () => {
  const restore = mockFetchByUrl({
    // /health throws (no route + we simulate by only routing root); use a thrower for /health
    "/health": () => {
      throw new Error("no /health");
    },
    "/": () => new Response("", { status: 200 }),
  });
  try {
    const r = await pollGenericServer("h:1");
    assert.equal(r.isOnline, true);
  } finally {
    restore();
  }
});

test("pollGenericServer offline when both paths fail", async () => {
  const restore = mockFetchThrows();
  try {
    const r = await pollGenericServer("h:1");
    assert.equal(r.isOnline, false);
  } finally {
    restore();
  }
});

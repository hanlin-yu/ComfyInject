// Tests for the in-memory workflow cache used by the LoRA panel and generation.
//
//   node --test test/workflowRuntime.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
    fetchWorkflow,
    getOrLoadWorkflow,
    getRuntimeWorkflow,
    markDirty,
    reloadWorkflow,
    serializeWorkflow,
} from "../src/workflowRuntime.js";

function mockFetch(t, bodies) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        const body = bodies.shift();
        return { ok: body !== undefined, json: async () => body };
    };
    t.after(() => { globalThis.fetch = original; });
    return calls;
}

test("getOrLoadWorkflow fetches once and caches by filename", async (t) => {
    const calls = mockFetch(t, [{ "1": { class_type: "X", inputs: {} } }]);
    const first = await getOrLoadWorkflow("cache-test.json");
    const second = await getOrLoadWorkflow("cache-test.json");
    assert.equal(calls.length, 1);
    assert.equal(first, second);
    assert.equal(first.dirty, false);
    assert.ok(calls[0].includes("/workflows/cache-test.json"));
});

test("markDirty flags the cached entry and ignores unknown files", async (t) => {
    mockFetch(t, [{ "1": { class_type: "X", inputs: {} } }]);
    await getOrLoadWorkflow("dirty-test.json");
    markDirty("dirty-test.json");
    assert.equal(getRuntimeWorkflow("dirty-test.json").dirty, true);
    markDirty("missing.json");
    assert.equal(getRuntimeWorkflow("missing.json"), null);
});

test("reloadWorkflow refetches and clears the dirty flag", async (t) => {
    mockFetch(t, [{ a: 1 }, { a: 2 }]);
    await getOrLoadWorkflow("reload-test.json");
    markDirty("reload-test.json");
    const entry = await reloadWorkflow("reload-test.json");
    assert.equal(entry.dirty, false);
    assert.deepEqual(entry.workflow, { a: 2 });
});

test("serializeWorkflow returns 2-space JSON and null for unknown files", async (t) => {
    mockFetch(t, [{ a: 1 }]);
    await getOrLoadWorkflow("serialize-test.json");
    assert.equal(serializeWorkflow("serialize-test.json"), JSON.stringify({ a: 1 }, null, 2));
    assert.equal(serializeWorkflow("nope.json"), null);
});

test("fetchWorkflow rejects when the file cannot be read", async (t) => {
    mockFetch(t, [undefined]);
    await assert.rejects(() => fetchWorkflow("missing-file.json"), /Failed to load workflow/);
});

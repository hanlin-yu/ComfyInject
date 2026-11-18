# LoRA Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror the LoRA nodes wired after the workflow's checkpoint/UNet node in the extension settings, let the user edit weights, remove and append LoRAs on a runtime copy, use that copy for generation, and download the edited workflow JSON.

**Architecture:** A pure graph module (`src/loraChain.js`) finds the loader and mutates the API-format workflow; a DOM-free runtime cache (`src/workflowRuntime.js`) holds per-file copies and dirty flags for the browser session. The settings panel in `settings.html` / `src/ui.js` drives those modules, and `src/comfy.js` uses the dirty copy when generating.

**Tech Stack:** Vanilla ES modules, jQuery UI helpers already present in the extension, ComfyUI API-format JSON, `node:test` for pure modules.

**Spec:** `docs/superpowers/specs/2026-11-19-lora-chain-design.md`

## Global Constraints

- No new dependencies.
- Node 20.9 (`node --test`). `src/loraChain.js` and `src/workflowRuntime.js` must import nothing from SillyTavern or the DOM so tests run in Node.
- The committed suite `test/rewriteRules.test.mjs` is green (16/16) and must stay green.
- `test/mossPrompt.test.mjs` is untracked work-in-progress with 6 pre-existing failures; do not modify it. Baseline for `node --test test/` is 28 pass / 6 fail.
- Never write workflow files from code. Save downloads a JSON file.
- Appended node ids use the `comfyinject_lora_<n>` prefix.
- One weight per LoRA: write `strength_model`; fall back to `strength_clip` only when `strength_model` is absent.
- Node refs are `[nodeId, outputIndex]` arrays; compare node ids with `String(ref[0]) === String(nodeId)`.
- Match existing style: 4 spaces, JSDoc on exported functions.

## Review Focus

- **Blank appended LoRA name** — Add creates a node before the user types a name; sending `lora_name: ""` to ComfyUI fails enum validation. Generation must prune blank `comfyinject_lora_*` nodes. Owned by Task 2 (test) and Task 4 (integration).
- **Full `LoraLoader` removal** — it has both MODEL and CLIP outputs; leaving CLIP consumers pointing at a deleted node breaks the graph. Owned by Task 2.
- **Branching consumers** — switch nodes and side branches may consume a removed node; every input ref must be rewired, not just the next LoRA in the chain. Owned by Task 2.
- **No `{{CHECKPOINT}}` node or unreadable workflow** — the panel must show a status line and generation must proceed unchanged. Owned by Task 1 (detection) and Task 5 (manual check).
- **Unsaved edits across filename switches/reload** — each file keeps its runtime copy for the session; Reload discards only after confirmation. Owned by Task 3 (cache tests) and Task 5 (manual check).

---

### Task 1: Loader detection and chain extraction

**Files:**
- Create: `src/loraChain.js`
- Test: `test/loraChain.test.mjs`

**Interfaces:**
- Produces: `isRef(value): boolean`, `findLoaderNodeId(workflow): string | null`, `extractLoraChain(workflow, loaderId): Array<{ id: string, classType: string, name: string, weight: number }>`

- [ ] **Step 1: Write the failing tests**

Create `test/loraChain.test.mjs`:

```js
// Tests for the pure LoRA graph helpers.
//
//   node --test test/loraChain.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { extractLoraChain, findLoaderNodeId, isRef } from "../src/loraChain.js";

const loaderNode = () => ({
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "{{CHECKPOINT}}" },
});

function chainedWorkflow() {
    return {
        "base": { class_type: "UNETLoader", inputs: { unet_name: "{{CHECKPOINT}}", weight_dtype: "default" } },
        "loraA": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "a.safetensors", strength_model: 0.5, model: ["base", 0] } },
        "loraB": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "b.safetensors", strength_model: 1, model: ["loraA", 0] } },
        "sampler": { class_type: "KSampler", inputs: { model: ["loraB", 0] } },
    };
}

test("isRef accepts node refs and rejects other values", () => {
    assert.equal(isRef(["1", 0]), true);
    assert.equal(isRef([1, 0]), true);
    assert.equal(isRef(["1"]), false);
    assert.equal(isRef("1"), false);
    assert.equal(isRef(null), false);
});

test("findLoaderNodeId finds the node holding {{CHECKPOINT}}", () => {
    const wf = { "1": loaderNode(), "2": { class_type: "KSampler", inputs: { model: ["1", 0] } } };
    assert.equal(findLoaderNodeId(wf), "1");
});

test("findLoaderNodeId returns null without a {{CHECKPOINT}} value", () => {
    const wf = { "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "hardcoded.safetensors" } } };
    assert.equal(findLoaderNodeId(wf), null);
});

test("findLoaderNodeId prefers a loader class when several nodes contain the placeholder", () => {
    const wf = {
        "x": { class_type: "SomeTextNode", inputs: { text: "{{CHECKPOINT}}" } },
        "1": loaderNode(),
    };
    assert.equal(findLoaderNodeId(wf), "1");
});

test("extractLoraChain follows MODEL refs in application order", () => {
    assert.deepEqual(extractLoraChain(chainedWorkflow(), "base"), [
        { id: "loraA", classType: "LoraLoaderModelOnly", name: "a.safetensors", weight: 0.5 },
        { id: "loraB", classType: "LoraLoaderModelOnly", name: "b.safetensors", weight: 1 },
    ]);
});

test("extractLoraChain includes a full LoraLoader", () => {
    const wf = {
        "base": loaderNode(),
        "lora": {
            class_type: "LoraLoader",
            inputs: { lora_name: "x.safetensors", strength_model: 0.7, strength_clip: 0.4, model: ["base", 0], clip: ["base", 1] },
        },
    };
    assert.deepEqual(extractLoraChain(wf, "base"), [
        { id: "lora", classType: "LoraLoader", name: "x.safetensors", weight: 0.7 },
    ]);
});

test("extractLoraChain ignores side-branch LoRAs", () => {
    const wf = {
        "base": loaderNode(),
        "a": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "a", strength_model: 1, model: ["base", 0] } },
        "b": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "b", strength_model: 1, model: ["base", 0] } },
    };
    assert.deepEqual(extractLoraChain(wf, "base").map((node) => node.id), ["a"]);
});

test("extractLoraChain returns an empty list when the loader feeds no LoRA", () => {
    const wf = { "1": loaderNode(), "2": { class_type: "KSampler", inputs: { model: ["1", 0] } } };
    assert.deepEqual(extractLoraChain(wf, "1"), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/loraChain.test.mjs`
Expected: FAIL — cannot find module `../src/loraChain.js`.

- [ ] **Step 3: Implement `src/loraChain.js` with the three helpers**

- `isRef(value)` — array of length 2 whose first element is a string or number and whose second is a number.
- `findLoaderNodeId(workflow)` — collect node ids whose `inputs` contain a value strictly equal to `"{{CHECKPOINT}}"`. Return `null` if none. If more than one, prefer a `class_type` matching `/(checkpoint|unet|diffusionmodel)/i`, else the first in object order.
- `extractLoraChain(workflow, loaderId)` — start at `String(loaderId)`; loop: find the first unvisited `LoraLoader` / `LoraLoaderModelOnly` node whose `inputs.model` is a ref with the current id; push exactly `{ id, classType, name, weight }` (no extra properties); continue from that node. Name is `String(inputs.lora_name ?? "")`; weight is `Number(inputs.strength_model ?? inputs.strength_clip ?? 1)`, falling back to `1` when not finite. Guard against cycles with a visited set.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/loraChain.test.mjs`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/loraChain.js test/loraChain.test.mjs
git commit -m "feat: extract the LoRA chain after the checkpoint node"
```

---

### Task 2: Graph mutations (weight, remove, append, prune)

**Files:**
- Modify: `src/loraChain.js`
- Modify: `test/loraChain.test.mjs`

**Interfaces:**
- Consumes: `extractLoraChain`, `isRef` from Task 1.
- Produces:
  - `setLoraWeight(workflow, nodeId, weight): boolean`
  - `removeLoraNode(workflow, nodeId): boolean`
  - `appendLoraNode(workflow, loaderId, name, weight): string | null`
  - `pruneBlankAddedLoras(workflow): object`

- [ ] **Step 1: Add the failing tests**

Append to `test/loraChain.test.mjs`, replacing the existing import with:

```js
import {
    appendLoraNode,
    extractLoraChain,
    findLoaderNodeId,
    isRef,
    pruneBlankAddedLoras,
    removeLoraNode,
    setLoraWeight,
} from "../src/loraChain.js";

function fullLoraWorkflow() {
    return {
        "base": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "{{CHECKPOINT}}" } },
        "lora": {
            class_type: "LoraLoader",
            inputs: { lora_name: "x.safetensors", strength_model: 0.7, strength_clip: 0.7, model: ["base", 0], clip: ["base", 1] },
        },
        "positive": { class_type: "CLIPTextEncode", inputs: { text: "hi", clip: ["lora", 1] } },
        "sampler": { class_type: "KSampler", inputs: { model: ["lora", 0] } },
    };
}

test("setLoraWeight updates strength_model and ignores unknown nodes", () => {
    const wf = chainedWorkflow();
    assert.equal(setLoraWeight(wf, "loraA", -1.5), true);
    assert.equal(wf.loraA.inputs.strength_model, -1.5);
    assert.equal(setLoraWeight(wf, "missing", 1), false);
});

test("setLoraWeight falls back to strength_clip when strength_model is absent", () => {
    const wf = { "l": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "x", strength_clip: 0.2, model: ["b", 0] } } };
    setLoraWeight(wf, "l", 0.9);
    assert.equal(wf.l.inputs.strength_clip, 0.9);
});

test("removeLoraNode rewires the next chain node to the upstream node", () => {
    const wf = chainedWorkflow();
    assert.equal(removeLoraNode(wf, "loraA"), true);
    assert.equal(wf.loraA, undefined);
    assert.deepEqual(wf.loraB.inputs.model, ["base", 0]);
});

test("removeLoraNode rewires every consumer, including branch inputs", () => {
    const wf = chainedWorkflow();
    wf.branch = { class_type: "ComfySwitchNode", inputs: { on_true: ["loraB", 0], on_false: ["loraA", 0] } };
    removeLoraNode(wf, "loraA");
    assert.deepEqual(wf.branch.inputs.on_false, ["base", 0]);
});

test("removeLoraNode rewires both MODEL and CLIP outputs of a full LoraLoader", () => {
    const wf = fullLoraWorkflow();
    assert.equal(removeLoraNode(wf, "lora"), true);
    assert.equal(wf.lora, undefined);
    assert.deepEqual(wf.sampler.inputs.model, ["base", 0]);
    assert.deepEqual(wf.positive.inputs.clip, ["base", 1]);
});

test("removeLoraNode is a no-op for unknown ids", () => {
    assert.equal(removeLoraNode(chainedWorkflow(), "missing"), false);
});

test("appendLoraNode inserts after the loader when the chain is empty", () => {
    const wf = {
        "base": { class_type: "UNETLoader", inputs: { unet_name: "{{CHECKPOINT}}" } },
        "sampler": { class_type: "KSampler", inputs: { model: ["base", 0] } },
    };
    const id = appendLoraNode(wf, "base", "new.safetensors", 0.8);
    assert.equal(id, "comfyinject_lora_0");
    assert.deepEqual(wf[id].inputs, { lora_name: "new.safetensors", strength_model: 0.8, model: ["base", 0] });
    assert.deepEqual(wf.sampler.inputs.model, [id, 0]);
});

test("appendLoraNode splices after the last chain node and redirects its sinks", () => {
    const wf = chainedWorkflow();
    const id = appendLoraNode(wf, "base", "new.safetensors", 1);
    assert.deepEqual(wf[id].inputs.model, ["loraB", 0]);
    assert.deepEqual(wf.sampler.inputs.model, [id, 0]);
    assert.deepEqual(extractLoraChain(wf, "base").map((node) => node.id), ["loraA", "loraB", id]);
});

test("appendLoraNode produces unique ids across repeated appends", () => {
    const wf = chainedWorkflow();
    const first = appendLoraNode(wf, "base", "one.safetensors", 1);
    const second = appendLoraNode(wf, "base", "two.safetensors", 1);
    assert.notEqual(first, second);
    assert.deepEqual(wf[second].inputs.model, [first, 0]);
    assert.deepEqual(wf.sampler.inputs.model, [second, 0]);
});

test("appendLoraNode returns null when the loader is missing", () => {
    assert.equal(appendLoraNode({}, "missing", "x", 1), null);
});

test("pruneBlankAddedLoras removes blank appended nodes from a copy and rewires consumers", () => {
    const wf = chainedWorkflow();
    const blank = appendLoraNode(wf, "base", "", 1);
    const named = appendLoraNode(wf, "base", "named.safetensors", 1);
    const pruned = pruneBlankAddedLoras(wf);

    assert.notEqual(pruned, wf);
    assert.equal(pruned[blank], undefined);
    assert.deepEqual(pruned[named].inputs.model, ["loraB", 0]);
    assert.deepEqual(pruned.sampler.inputs.model, [named, 0]);
    assert.ok(wf[blank], "the runtime workflow is not mutated");
    assert.ok(wf[named]);
});

test("pruneBlankAddedLoras returns the same object when nothing is blank", () => {
    const wf = chainedWorkflow();
    assert.equal(pruneBlankAddedLoras(wf), wf);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/loraChain.test.mjs`
Expected: FAIL — the four new exports are missing.

- [ ] **Step 3: Implement the four functions in `src/loraChain.js`**

- `setLoraWeight(workflow, nodeId, weight)` — if `workflow[nodeId]` is missing return `false`. If `strength_model` is an own property of `inputs`, set it; else if `strength_clip` is an own property, set that; else set `strength_model`. Assign `Number(weight)`. Return `true`.
- `removeLoraNode(workflow, nodeId)` — if missing return `false`. Read `upstream = node.inputs?.model`; if not a ref, return `false`. Rewire every input ref across the workflow whose id matches and output index is `0` to `upstream.slice()` (iterate all nodes and their `inputs` values). If `class_type === "LoraLoader"` and `inputs.clip` is a ref, rewire refs with output index `1` to `inputs.clip.slice()`. Delete `workflow[nodeId]`. Return `true`.
- `appendLoraNode(workflow, loaderId, name, weight)` — return `null` if `workflow[loaderId]` is missing. Extract the chain; `anchor = chain.length ? [chain.at(-1).id, 0] : [String(loaderId), 0]`. Capture every input location (node id + input key) whose ref equals the anchor **before** adding the node. Pick the first unused `comfyinject_lora_<n>` id. Create `{ class_type: "LoraLoaderModelOnly", inputs: { lora_name: name, strength_model: finiteWeight, model: anchor } }` where `finiteWeight` is `Number(weight)` or `1` when not finite. Point each captured sink at `[newId, 0]` and return `newId`.
- `pruneBlankAddedLoras(workflow)` — collect ids starting with `comfyinject_lora_` whose `lora_name` is blank (`String(...).trim() === ""`). If none, return the same object. Otherwise `structuredClone` the workflow, call `removeLoraNode` on each blank id, and return the clone.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/loraChain.test.mjs`
Expected: PASS — 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/loraChain.js test/loraChain.test.mjs
git commit -m "feat: edit the LoRA chain in place on the runtime workflow"
```

---

### Task 3: Runtime workflow cache

**Files:**
- Create: `src/workflowRuntime.js`
- Test: `test/workflowRuntime.test.mjs`

**Interfaces:**
- Produces:
  - `fetchWorkflow(filename): Promise<object>` — GETs `/scripts/extensions/third-party/ComfyInject/workflows/<filename>`; throws `Failed to load workflow "<filename>": <status>` on a non-OK response.
  - `getOrLoadWorkflow(filename): Promise<{ workflow: object, dirty: boolean }>`
  - `getRuntimeWorkflow(filename): { workflow: object, dirty: boolean } | null`
  - `markDirty(filename): void`
  - `reloadWorkflow(filename): Promise<{ workflow: object, dirty: boolean }>`
  - `serializeWorkflow(filename): string | null`

- [ ] **Step 1: Write the failing tests**

Create `test/workflowRuntime.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/workflowRuntime.test.mjs`
Expected: FAIL — cannot find module `../src/workflowRuntime.js`.

- [ ] **Step 3: Implement `src/workflowRuntime.js`**

Module-level `const EXTENSION_FOLDER = "scripts/extensions/third-party/ComfyInject";` and `const cache = new Map();`. Implement the six exports above; `reloadWorkflow` deletes the key before calling `getOrLoadWorkflow`; `serializeWorkflow` returns `JSON.stringify(entry.workflow, null, 2)` or `null` when the entry is absent. No SillyTavern or DOM imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/workflowRuntime.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/workflowRuntime.js test/workflowRuntime.test.mjs
git commit -m "feat: cache runtime workflow copies for the LoRA panel"
```

---

### Task 4: Use the edited runtime copy for generation

**Files:**
- Modify: `src/comfy.js:1-31` (imports and `loadWorkflow`)
- Modify: `src/comfy.js:169-171` (`generateImage` workflow load)

**Interfaces:**
- Consumes: `fetchWorkflow`, `getRuntimeWorkflow` from `./workflowRuntime.js`; `pruneBlankAddedLoras` from `./loraChain.js`.
- Produces: unchanged `generateImage` signature and return shape.

- [ ] **Step 1: Replace `loadWorkflow` in `src/comfy.js`**

Add imports at the top:

```js
import { fetchWorkflow, getRuntimeWorkflow } from "./workflowRuntime.js";
import { pruneBlankAddedLoras } from "./loraChain.js";
```

Replace the `EXTENSION_FOLDER` constant and the body of `loadWorkflow` with:

```js
async function loadWorkflow() {
    const settings = getSettings();
    const filename = settings.workflow || "comfyinject_default.json";
    const runtime = getRuntimeWorkflow(filename);
    if (runtime?.dirty) {
        return pruneBlankAddedLoras(runtime.workflow);
    }
    return await fetchWorkflow(filename);
}
```

Leave the `generateImage` call site as `const workflow = await loadWorkflow();`.

- [ ] **Step 2: Verify the module still parses and imports**

Run from the extension folder: `node --input-type=module -e "await import('./src/comfy.js'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Run the committed and new test suites**

Run: `node --test test/loraChain.test.mjs test/workflowRuntime.test.mjs test/rewriteRules.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 4: Commit**

```bash
git add src/comfy.js
git commit -m "feat: generate with the edited runtime workflow"
```

---

### Task 5: LoRA Chain settings panel

**Files:**
- Modify: `settings.html` (insert after the Workflow block, before the first `<hr class="sysHR" />` at line 38)
- Modify: `src/ui.js` (imports at top, new state/helpers after `refreshCheckpointList`, calls in `populateUI`/`wireEvents`/`initUI`)

**Interfaces:**
- Consumes: `findLoaderNodeId`, `extractLoraChain`, `setLoraWeight`, `removeLoraNode`, `appendLoraNode` from `./loraChain.js`; `getOrLoadWorkflow`, `getRuntimeWorkflow`, `markDirty`, `reloadWorkflow`, `serializeWorkflow` from `./workflowRuntime.js`.
- Produces: unchanged `initUI` signature.

- [ ] **Step 1: Add the panel markup to `settings.html`**

Insert between the Workflow field and the `<hr class="sysHR" />`:

```html
<!-- LoRA Chain -->
<div>
    <div class="flex-container flexGap5 alignItemsCenter">
        <label>LoRA Chain</label>
        <small id="comfyinject_lora_status" style="margin-left: auto;"></small>
    </div>
    <div id="comfyinject_lora_rows" style="margin-top: 4px;"></div>
    <div class="flex-container flexGap5" style="margin-top: 6px;">
        <div id="comfyinject_lora_add" class="menu_button menu_button_icon" title="Append a LoRA after the current chain">
            <i class="fa-solid fa-plus"></i>
            <span>Add LoRA</span>
        </div>
        <div id="comfyinject_lora_reload" class="menu_button menu_button_icon" title="Discard edits and load the file again">
            <i class="fa-solid fa-rotate"></i>
            <span>Reload</span>
        </div>
        <div id="comfyinject_lora_save" class="menu_button menu_button_icon" title="Download the workflow with the current LoRA chain">
            <i class="fa-solid fa-download"></i>
            <span>Save JSON</span>
        </div>
    </div>
    <datalist id="comfyinject_lora_names"></datalist>
    <small>LoRAs wired after the checkpoint/UNet node. Edits live in memory and are used for generation; Save downloads the updated workflow to replace the file in workflows/.</small>
</div>
```

- [ ] **Step 2: Add imports and module state to `src/ui.js`**

```js
import { appendLoraNode, extractLoraChain, findLoaderNodeId, removeLoraNode, setLoraWeight } from "./loraChain.js";
import { getOrLoadWorkflow, getRuntimeWorkflow, markDirty, reloadWorkflow, serializeWorkflow } from "./workflowRuntime.js";

let loraRows = [];
let loraLoaderId = null;
let loraWorkflowFile = "";
let loraLoadToken = 0;
let loraPanelTimer = null;
```

- [ ] **Step 3: Implement the panel helpers in `src/ui.js`**

- `escapeHtml(value)` — replace `&`, `<`, `>`, `"`, `'`.
- `isAppendedLoraId(id)` — `id.startsWith("comfyinject_lora_")`.
- `async function fetchLoraNames()` — fetch `/object_info/LoraLoaderModelOnly` and `/object_info/LoraLoader` from `settings.comfy_host`; collect `data[cls].input.required.lora_name[0]` into a Set; fill `#comfyinject_lora_names` with `<option value="...">`; swallow all errors silently.
- `async function loadLoraPanel({ forceReload = false } = {})` — read `getSettings().workflow || ""`. Empty → rows cleared, `loraLoaderId = null`, status `Set a workflow filename.`, Add and Save disabled. Otherwise bump `loraLoadToken`, then set status `Loading…`, clear `loraRows`/`loraLoaderId`, empty the rows container, and disable Add and Save. Reuse the cached entry when it is dirty and `forceReload` is false; otherwise refetch a clean entry from disk with `reloadWorkflow(filename)` (mirroring generation). Ignore stale tokens. On failure set `loraLoaderId = null`, show `Could not read <filename>.`, and keep both buttons disabled. Find the loader; if missing set `loraLoaderId = null`, show `No {{CHECKPOINT}} node found in <filename>.`, and keep both buttons disabled; otherwise store `loraLoaderId = findLoaderNodeId(entry.workflow)`, enable Add and Save, and call `renderLoraPanel()`.
- `function renderLoraPanel()` — read the cached entry; map `extractLoraChain(...)` to rows of shape `{ nodeId: node.id, name, weight, appended: isAppendedLoraId(node.id) }` and store in `loraRows`. Build one row per entry: name as a read-only `<span class="comfyinject-lora-name" title="...">` (ellipsis, flex 1) or, for appended rows, `<input type="text" class="text_pole comfyinject-lora-name-input" list="comfyinject_lora_names" value="...">`; a `<input type="number" step="0.05" class="text_pole comfyinject-lora-weight" style="width: 80px;">`; a remove `<div class="menu_button comfyinject-lora-remove"><i class="fa-solid fa-xmark"></i></div>`. Each element carries `data-row-index`. Call `updateLoraStatus()`.
- `function updateLoraStatus()` — `${loraRows.length} LoRA(s) · ${entry.dirty ? "unsaved changes" : "no unsaved changes"}`, or the empty/error message already set.

- [ ] **Step 4: Wire the events in `wireEvents()`**

- Delegated `input` on `.comfyinject-lora-weight`: parse `parseFloat`; if finite, `setLoraWeight(workflow, row.nodeId, value)`, `markDirty(loraWorkflowFile)`, `updateLoraStatus()`.
- Delegated `input` on `.comfyinject-lora-name-input`: set `workflow[row.nodeId].inputs.lora_name = $(this).val()`, also update `loraRows[index].name` in memory (the Save blank-name check reads it), `markDirty`, `updateLoraStatus()`.
- Delegated `click` on `.comfyinject-lora-remove`: `removeLoraNode`, `markDirty`, `renderLoraPanel()`.
- `#comfyinject_lora_add`: return early when `loraLoaderId` is null or the runtime entry is missing; otherwise `appendLoraNode(workflow, loraLoaderId, "", 1)`; if an id is returned, `markDirty`, `renderLoraPanel()`, and focus the last `.comfyinject-lora-name-input`.
- `#comfyinject_lora_reload`: if the entry is dirty, `confirm("Discard unsaved LoRA edits for <file>?")` and return on cancel; `await reloadWorkflow(loraWorkflowFile)`; then `await loadLoraPanel()` so the loader is re-detected and rows re-render from the fresh copy.
- `#comfyinject_lora_save`: if any row is an appended node with a blank name, `toastr.warning("Name every added LoRA before saving.", "ComfyInject")` and return. Otherwise `serializeWorkflow(loraWorkflowFile)`; create a Blob, trigger an `<a download="<basename>">` click, revoke the URL, and `toastr.success("Downloaded <file>. Replace it in workflows/ to persist.", "ComfyInject")`. Do not clear the dirty flag.
- In the existing Workflow `input` handler, add a second debounce (500 ms) that calls `loadLoraPanel()`; keep the existing 1500 ms validation.

- [ ] **Step 5: Initialize on load**

In `initUI()`, after `refreshCheckpointList(false)`, call `fetchLoraNames()` and `loadLoraPanel()` (fire and forget).

- [ ] **Step 6: Manual browser verification**

Start SillyTavern (`node server.js` from `T:/SillyTavern`), open the UI, and check in the ComfyInject settings drawer:

1. Workflow `moss.json` → one row per LoRA wired after the base/UNet node, in application order, each showing the file's weight; status shows the row count + `no unsaved changes`.
2. Change the first weight → status `unsaved changes`.
3. Add LoRA → row with an empty name input; type a name from the dropdown.
4. Remove a middle row → it disappears; the chain still lists in order.
5. Save JSON → a `moss.json` download containing the modified `strength_model` and a `comfyinject_lora_0` node, with `{{CHECKPOINT}}` / `{{SEED}}` placeholders intact.
6. Generate an image from a `[[IMG: ... ]]` marker → the `/prompt` payload contains the edited chain (Network tab), and ComfyUI returns an image.
7. Reload → confirm dialog, then edits revert to the file.
8. Switch to `comfyinject_default.json` → 0 rows; Add a LoRA and Save → the downloaded JSON has the new node between `1` and the sampler's `model` input.
9. Add a blank-name row and generate → no ComfyUI enum error (blank node pruned); Save warns instead of downloading.
10. Set Workflow to a nonexistent file → `Could not read …`, no crash.

- [ ] **Step 7: Commit**

```bash
git add settings.html src/ui.js
git commit -m "feat: add the LoRA Chain settings panel"
```

---

### Task 6: Documentation and final verification

**Files:**
- Modify: `README.md` (new `## LoRA Chain` section before `## Custom Workflows`, line 362)
- Modify: `workflows/workflows_README.md` (new note after the placeholder table)

**Interfaces:**
- Consumes: behavior from Tasks 1–5.
- Produces: user-facing docs.

- [ ] **Step 1: Add the README section**

Cover: the panel sits below Workflow; it finds the `{{CHECKPOINT}}` node and mirrors the linear `LoraLoader*` MODEL chain; weights edit `strength_model`; Remove rewires the graph; Add appends a model-only LoRA nearest the sampler; edits live in memory and generation uses them immediately; Save downloads the JSON and you must replace the file in `workflows/`; external workflows without `{{CHECKPOINT}}` are not mirrored; side-branch LoRAs are not listed.

- [ ] **Step 2: Add the workflows README note**

State that the panel only mirrors the linear chain of `LoraLoader` / `LoraLoaderModelOnly` nodes reachable from the `{{CHECKPOINT}}` node's MODEL output, and that appended LoRAs are `LoraLoaderModelOnly` nodes with ids prefixed `comfyinject_lora_`.

- [ ] **Step 3: Run the full verification**

Run: `node --test test/loraChain.test.mjs test/workflowRuntime.test.mjs test/rewriteRules.test.mjs`
Expected: all pass.

Run: `node --test test/`
Expected: new tests add to the pass count; the only failures remain the 6 pre-existing `mossPrompt` tests.

Run: `git status --short`
Expected: only the intended files (`src/loraChain.js`, `src/workflowRuntime.js`, `src/comfy.js`, `src/ui.js`, `settings.html`, `test/loraChain.test.mjs`, `test/workflowRuntime.test.mjs`, README files, plus the design/plan docs). The untracked workflow JSONs and `mossPrompt` files must not be staged.

- [ ] **Step 4: Commit the docs (including the spec and plan)**

```bash
git add README.md workflows/workflows_README.md docs/superpowers/specs/2026-11-19-lora-chain-design.md docs/superpowers/plans/2026-11-19-lora-chain.md
git commit -m "docs: document the LoRA Chain panel"
```

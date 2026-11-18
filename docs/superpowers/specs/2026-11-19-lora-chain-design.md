# LoRA Chain — Design

- **Date:** 2026-11-19
- **Branch:** `feat/lora-slider`
- **Status:** proposed

## Intent

ComfyInject generates images from API-format workflow JSON by swapping `{{…}}` placeholders. Today, changing LoRAs means hand-editing that JSON. This feature reads the LoRA chain already wired after the checkpoint / UNet node into the settings panel, lets the user change weights, remove rows, and append new LoRAs by editing a runtime copy of the workflow, and offers a Save button that downloads the modified JSON for the user to put back into `workflows/`.

No edits are persisted in extension settings; nothing is written to disk automatically.

## Goals

- Find the loader node by its `{{CHECKPOINT}}` input (works for `CheckpointLoaderSimple`, `UNETLoader`, etc.).
- Walk the linear MODEL chain after that node and list every `LoraLoader` / `LoraLoaderModelOnly` node in application order (checkpoint → sampler).
- Edit weights, remove nodes, and append LoRAs on a runtime copy of the workflow; the graph is patched immediately, so generation uses the edited version even before saving.
- Save button downloads the full workflow JSON (placeholders intact) for the user to replace the file in `workflows/`.
- Offer LoRA filenames from ComfyUI's `/object_info` in a dropdown, like the existing checkpoint field.

## Non-goals

- Writing to the workflow file automatically (browser limitation; user chose download).
- Persisting LoRA edits in extension settings or across page reloads.
- Renaming LoRA nodes that already exist in the workflow (only appended nodes get an editable name).
- Changing `strength_clip` on full `LoraLoader` nodes.
- Mirroring branching/parallel LoRA graphs; only the linear MODEL chain starting at the loader is read.
- Reordering rows.

## Anti-goals (would make this a failure)

- Changing generation output when the runtime workflow has not been edited.
- Breaking generation when ComfyUI is unreachable (the LoRA name list is optional).
- Corrupting or crashing on a workflow without a `{{CHECKPOINT}}` node — the panel explains why it is empty and generation proceeds unchanged.
- Silently losing unsaved runtime edits on Reload — confirm first. Switching filenames keeps each file's runtime copy for the session, so no confirm is needed there.
- An unfinished Add row (blank name) breaking generation — blank `comfyinject_lora_*` nodes are pruned from the generation copy.

## Approaches considered

1. **Per-workflow deltas in settings** (earlier design). Store weight overrides, removed ids, and appended LoRAs keyed by workflow file; apply at generation. Rejected by the user in favour of runtime editing.
2. **Runtime edit + download (chosen).** Load the workflow JSON once, mutate the graph in memory as the user edits, have generation use that copy, and download the edited JSON on Save.

## Runtime store (`src/workflowRuntime.js`)

A DOM-free module shared by the settings panel and the generation path:

```js
// In-memory only; cleared on page reload.
Map<filename, { workflow, dirty }>
```

- `getOrLoadWorkflow(filename)` — return the cached entry, otherwise fetch the file (same URL as today) and cache it clean.
- `getRuntimeWorkflow(filename)` — cache lookup, or `null`.
- `markDirty(filename)` — any LoRA edit.
- `reloadWorkflow(filename)` — drop the entry, fetch again.
- `serializeWorkflow(filename)` — `JSON.stringify(workflow, null, 2)` for download.

Entries persist for the browser session, so switching workflow names back and forth keeps unsaved edits for each file.

## Graph operations (`src/loraChain.js`, pure module)

### `findLoaderNodeId(workflow)`

Return the first node whose inputs contain a value exactly equal to `"{{CHECKPOINT}}"`; prefer class types matching `Checkpoint|UNET|Unet|DiffusionModel` when several match. Return `null` otherwise.

### `extractLoraChain(workflow, loaderId)`

- Start from the ref `[loaderId, 0]` (MODEL output).
- Repeatedly find a not-yet-visited `LoraLoader` / `LoraLoaderModelOnly` node whose `model` input equals the current ref; record `{ id, classType, name, weight }` and continue from `[nodeId, 0]`.
- Deterministic (object iteration order) and cycle-guarded. Side-branch LoRAs that do not continue the linear chain are not included.
- Weight read from `strength_model` (fallback `strength_clip`, then `1`).

### `setLoraWeight(workflow, nodeId, weight)`

Set `strength_model` (fallback `strength_clip`) to the number. No-op if the node is missing.

### `removeLoraNode(workflow, nodeId)`

- Rewire every input ref equal to `[nodeId, 0]` to the node's `model` input.
- For a full `LoraLoader`, also rewire `[nodeId, 1]` consumers to its `clip` input ref when present.
- Delete the node.

### `appendLoraNode(workflow, loaderId, name, weight)`

- Extract the chain; the anchor is the last chain node's `[id, 0]`, or the loader's `[id, 0]` if the chain is empty.
- Capture every input ref pointing at the anchor (the chain's sinks) before changing anything.
- Create a `LoraLoaderModelOnly` node with a collision-safe id (`comfyinject_lora_0`, `_1`, …) whose `model` is the anchor, then point the captured sinks at the new node.
- This makes appended LoRAs run last, nearest the sampler.

### `pruneBlankAddedLoras(workflow)`

Returns the same object when nothing needs pruning; otherwise a `structuredClone` with every `comfyinject_lora_*` node whose `lora_name` is blank removed via `removeLoraNode` (consumers rewired). Generation uses this so an unfinished Add row cannot reach ComfyUI.

All six graph functions are covered by `node:test` unit tests.

## UI (`settings.html`, `src/ui.js`)

A **LoRA Chain** section in the main settings panel, directly below the Workflow field:

```
LoRA Chain           6 LoRAs · unsaved changes
─────────────────────────────────────
 realskin_style_moss…  [ 0.33 ]  [×]   ← names from workflow, read-only
 LongLegsMoss-L4       [ 0.50 ]  [×]
 …
 my_extra_lora [text]  [ 0.80 ]  [×]   ← appended node, name editable + datalist
[+ Add LoRA] [Reload] [Save JSON]
```

- On init and when the Workflow field changes (debounced), `loadLoraPanel()` refetches a clean cached file from disk (mirroring generation) and reuses a dirty runtime copy so unsaved edits survive, then renders the chain. If the field is empty or the fetch fails, show the reason and disable Add and Save.
- Weight and name edits update the graph in place and refresh only the status line, so focus is kept; remove and Add re-render from a fresh `extractLoraChain`. Every edit marks the entry dirty. Add calls `appendLoraNode(workflow, loaderId, "", 1)` and focuses the new name field.
- Appended nodes are recognised by the `comfyinject_lora_` id prefix: their name is an editable text input backed by a `<datalist>` fetched from `/object_info/LoraLoaderModelOnly` + `/object_info/LoraLoader` (silent on failure). All other rows show the name read-only.
- `Reload` refetches the file, discarding edits; confirms first when dirty.
- `Save JSON` builds a Blob from `serializeWorkflow()` and triggers a download named after the workflow file. It refuses with a warning while any appended row has a blank name, and does not clear the dirty flag — generation keeps using the edited copy until the user replaces the file and reloads.
- Status line reports the chain size and dirty state, or why the panel is empty (no workflow file, fetch failed, no `{{CHECKPOINT}}` node).
- The Advanced Settings reset button is unaffected (there is no new setting to reset).

## Generation integration (`src/comfy.js`)

`loadWorkflow()` resolves the filename from settings as today, then prefers an edited runtime copy:

```js
const runtime = getRuntimeWorkflow(filename);
const workflow = runtime?.dirty
    ? runtime.workflow
    : await fetchWorkflowFromDisk(filename);
```

A clean cache entry is ignored so external edits to the file are picked up as they are today. When dirty, `pruneBlankAddedLoras` produces the generation copy first, then `fillWorkflow` serialises it immediately, so concurrent generations are safe and an unfinished Add row cannot break the prompt.

## Tests (`test/loraChain.test.mjs`)

Pure module, run with `node --test test/loraChain.test.mjs`:

- Loader detection for `CheckpointLoaderSimple`, `UNETLoader`, and the no-placeholder case.
- Chain extraction order/weights, including a full `LoraLoader`.
- Weight set mutates the runtime copy in place.
- Removal of a middle node rewires its successor to the upstream node.
- Removal of a full `LoraLoader` rewires both MODEL and CLIP consumers.
- Append-only to a chain-less workflow inserts after the loader and reuses former loader consumers.
- Appending after an existing chain feeds the chain's former sinks; ids avoid collisions.
- Negative weights survive.
- Removing an unknown / already-removed id is a no-op.

Existing `node --test test/*.test.mjs` suites must keep passing.

## Documentation

- `README.md`: short "LoRA Chain" feature section, including that Save downloads the JSON and the file must be replaced in `workflows/`.
- `workflows/workflows_README.md`: note that the panel mirrors only the linear `LoraLoader*` MODEL chain after the `{{CHECKPOINT}}` node.

## Files touched

| File | Change |
|---|---|
| `src/loraChain.js` | new pure graph module |
| `src/workflowRuntime.js` | new in-memory workflow cache |
| `src/comfy.js` | use edited runtime copy when dirty |
| `settings.html` | LoRA Chain section |
| `src/ui.js` | load/render/edit/download wiring |
| `test/loraChain.test.mjs` | new tests |
| `README.md`, `workflows/workflows_README.md` | docs |

## Left to the builder

- Exact wording/CSS classes for the panel; reuse `text_pole`, `menu_button`, and `flex-container` styles.
- Whether Add is available when there is no `{{CHECKPOINT}}` node (no — status line only).
- Confirm dialog wording when discarding dirty edits.

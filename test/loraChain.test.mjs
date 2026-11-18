// Tests for the pure LoRA graph helpers.
//
//   node --test test/loraChain.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
    appendLoraNode,
    extractLoraChain,
    findLoaderNodeId,
    isRef,
    pruneBlankAddedLoras,
    removeLoraNode,
    setLoraWeight,
} from "../src/loraChain.js";

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

test("appendLoraNode splices after a full LoraLoader without touching its CLIP output", () => {
    const wf = fullLoraWorkflow();
    const id = appendLoraNode(wf, "base", "new.safetensors", 0.6);
    assert.deepEqual(wf[id].inputs.model, ["lora", 0]);
    assert.deepEqual(wf.sampler.inputs.model, [id, 0]);
    assert.deepEqual(wf.positive.inputs.clip, ["lora", 1]);
});

test("pruneBlankAddedLoras removes blank appended nodes from a copy and rewires consumers", () => {
    const wf = chainedWorkflow();
    const blank = appendLoraNode(wf, "base", "", 1);
    const named = appendLoraNode(wf, "base", "named.safetensors", 1);
    const before = structuredClone(wf);
    const pruned = pruneBlankAddedLoras(wf);

    assert.notEqual(pruned, wf);
    assert.equal(pruned[blank], undefined);
    assert.deepEqual(pruned[named].inputs.model, ["loraB", 0]);
    assert.deepEqual(pruned.sampler.inputs.model, [named, 0]);
    assert.ok(wf[blank], "the runtime workflow is not mutated");
    assert.ok(wf[named]);
    assert.deepEqual(wf, before);
});

test("pruneBlankAddedLoras returns the same object when nothing is blank", () => {
    const wf = chainedWorkflow();
    assert.equal(pruneBlankAddedLoras(wf), wf);
});

test("pruneBlankAddedLoras removes multiple blank nodes and rewires the sink", () => {
    const wf = chainedWorkflow();
    const first = appendLoraNode(wf, "base", "", 1);
    const second = appendLoraNode(wf, "base", "  ", 1);
    const named = appendLoraNode(wf, "base", "named.safetensors", 1);
    const pruned = pruneBlankAddedLoras(wf);
    assert.equal(pruned[first], undefined);
    assert.equal(pruned[second], undefined);
    assert.deepEqual(pruned[named].inputs.model, ["loraB", 0]);
    assert.deepEqual(pruned.sampler.inputs.model, [named, 0]);
});

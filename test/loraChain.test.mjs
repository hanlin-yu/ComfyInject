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

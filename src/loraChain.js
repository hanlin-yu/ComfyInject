// Pure graph helpers for the LoRA chain feature.
//
// Nothing in here touches SillyTavern or the DOM, so the whole module can be
// imported and tested in plain node.  Later tasks and the settings panel
// consume these helpers.

const CHECKPOINT_PLACEHOLDER = "{{CHECKPOINT}}";
const LOADER_CLASS_REGEX = /(checkpoint|unet|diffusionmodel)/i;
const LORA_CLASS_TYPES = new Set(["LoraLoader", "LoraLoaderModelOnly"]);
const APPENDED_LORA_PREFIX = "comfyinject_lora_";

/**
 * Tells whether a workflow input value is a node reference.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRef(value) {
    return Array.isArray(value)
        && value.length === 2
        && (typeof value[0] === "string" || typeof value[0] === "number")
        && typeof value[1] === "number";
}

/**
 * Finds the node that receives the checkpoint placeholder.
 *
 * Several nodes may contain the placeholder; a loader class is preferred then,
 * because text nodes can reference the macro without being the image source.
 * @param {object} workflow
 * @returns {string|null}
 */
export function findLoaderNodeId(workflow) {
    const candidates = Object.entries(workflow ?? {})
        .filter(([, node]) => Object.values(node?.inputs ?? {}).includes(CHECKPOINT_PLACEHOLDER))
        .map(([nodeId, node]) => ({ nodeId, classType: node?.class_type }));

    if (candidates.length === 0) return null;

    const preferred = candidates.find(({ classType }) => LOADER_CLASS_REGEX.test(String(classType ?? "")));
    return (preferred ?? candidates[0]).nodeId;
}

/**
 * Lists the LoRAs applied to the model after the loader, in application order.
 * @param {object} workflow
 * @param {string|number} loaderId
 * @returns {Array<{id: string, classType: string, name: string, weight: number}>}
 */
export function extractLoraChain(workflow, loaderId) {
    const chain = [];
    const visited = new Set();
    let currentId = String(loaderId);

    for (;;) {
        const next = Object.entries(workflow ?? {}).find(([nodeId, node]) => {
            if (visited.has(nodeId)) return false;
            if (!LORA_CLASS_TYPES.has(node?.class_type)) return false;
            const model = node?.inputs?.model;
            return isRef(model) && String(model[0]) === currentId;
        });

        if (!next) break;

        const [nodeId, node] = next;
        const weight = Number(node.inputs.strength_model ?? node.inputs.strength_clip ?? 1);

        chain.push({
            id: nodeId,
            classType: node.class_type,
            name: String(node.inputs.lora_name ?? ""),
            weight: Number.isFinite(weight) ? weight : 1,
        });

        visited.add(nodeId);
        currentId = nodeId;
    }

    return chain;
}

/**
 * Visits every input value of every node in the workflow.
 * @param {object} workflow
 * @param {(nodeId: string, inputs: object, key: string, value: unknown) => void} visit
 */
function forEachInput(workflow, visit) {
    for (const [nodeId, node] of Object.entries(workflow ?? {})) {
        const inputs = node?.inputs;
        if (!inputs) continue;
        for (const [key, value] of Object.entries(inputs)) {
            visit(nodeId, inputs, key, value);
        }
    }
}

/**
 * Repoints every input ref to one output of a node at a replacement ref.
 * @param {object} workflow
 * @param {string|number} sourceId
 * @param {number} outputIndex
 * @param {Array} targetRef
 */
function rewireRefs(workflow, sourceId, outputIndex, targetRef) {
    forEachInput(workflow, (nodeId, inputs, key, value) => {
        if (!isRef(value)) return;
        if (String(value[0]) !== String(sourceId) || value[1] !== outputIndex) return;
        inputs[key] = targetRef.slice();
    });
}

/**
 * Sets a LoRA weight, preferring `strength_model` over `strength_clip`.
 * @param {object} workflow
 * @param {string|number} nodeId
 * @param {number|string} weight
 * @returns {boolean} whether the node exists and was updated
 */
export function setLoraWeight(workflow, nodeId, weight) {
    const node = workflow?.[nodeId];
    if (!node) return false;

    const inputs = node.inputs ?? (node.inputs = {});
    const key = Object.hasOwn(inputs, "strength_model")
        ? "strength_model"
        : Object.hasOwn(inputs, "strength_clip")
            ? "strength_clip"
            : "strength_model";
    inputs[key] = Number(weight);
    return true;
}

/**
 * Removes a LoRA node, rewiring its consumers to the node fed into it.
 * @param {object} workflow
 * @param {string|number} nodeId
 * @returns {boolean} whether the node was removed
 */
export function removeLoraNode(workflow, nodeId) {
    const node = workflow?.[nodeId];
    if (!node) return false;

    const upstream = node.inputs?.model;
    if (!isRef(upstream)) return false;

    rewireRefs(workflow, nodeId, 0, upstream);

    const clipUpstream = node.inputs?.clip;
    if (node.class_type === "LoraLoader" && isRef(clipUpstream)) {
        rewireRefs(workflow, nodeId, 1, clipUpstream);
    }

    delete workflow[nodeId];
    return true;
}

/**
 * Appends a LoRA node at the end of the chain and feeds the old sinks from it.
 * @param {object} workflow
 * @param {string|number} loaderId
 * @param {string} name
 * @param {number|string} weight
 * @returns {string|null} the new node id, or null without a loader
 */
export function appendLoraNode(workflow, loaderId, name, weight) {
    if (!workflow?.[loaderId]) return null;

    const chain = extractLoraChain(workflow, loaderId);
    const anchor = chain.length
        ? [chain[chain.length - 1].id, 0]
        : [String(loaderId), 0];

    const sinks = [];
    forEachInput(workflow, (nodeId, inputs, key, value) => {
        if (isRef(value) && String(value[0]) === String(anchor[0]) && value[1] === anchor[1]) {
            sinks.push({ nodeId, key });
        }
    });

    let index = 0;
    while (Object.hasOwn(workflow, `${APPENDED_LORA_PREFIX}${index}`)) index += 1;
    const newId = `${APPENDED_LORA_PREFIX}${index}`;

    const numericWeight = Number(weight);
    workflow[newId] = {
        class_type: "LoraLoaderModelOnly",
        inputs: {
            lora_name: name,
            strength_model: Number.isFinite(numericWeight) ? numericWeight : 1,
            model: anchor,
        },
    };

    for (const { nodeId, key } of sinks) {
        workflow[nodeId].inputs[key] = [newId, 0];
    }

    return newId;
}

/**
 * Drops appended LoRA nodes whose name is blank, without touching the original.
 * @param {object} workflow
 * @returns {object} the same workflow when nothing is blank, otherwise a pruned clone
 */
export function pruneBlankAddedLoras(workflow) {
    const blankIds = Object.entries(workflow ?? {})
        .filter(([nodeId, node]) => nodeId.startsWith(APPENDED_LORA_PREFIX)
            && String(node?.inputs?.lora_name ?? "").trim() === "")
        .map(([nodeId]) => nodeId);

    if (blankIds.length === 0) return workflow;

    const pruned = structuredClone(workflow);
    for (const nodeId of blankIds) {
        removeLoraNode(pruned, nodeId);
    }
    return pruned;
}

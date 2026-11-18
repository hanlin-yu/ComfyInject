// Pure graph helpers for the LoRA chain feature.
//
// Nothing in here touches SillyTavern or the DOM, so the whole module can be
// imported and tested in plain node.  Later tasks and the settings panel
// consume these helpers.

const CHECKPOINT_PLACEHOLDER = "{{CHECKPOINT}}";
const LOADER_CLASS_REGEX = /(checkpoint|unet|diffusionmodel)/i;
const LORA_CLASS_TYPES = new Set(["LoraLoader", "LoraLoaderModelOnly"]);

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
        const inputs = node.inputs ?? {};
        const weight = Number(inputs.strength_model ?? inputs.strength_clip ?? 1);

        chain.push({
            id: nodeId,
            classType: node.class_type,
            name: String(inputs.lora_name ?? ""),
            weight: Number.isFinite(weight) ? weight : 1,
        });

        visited.add(nodeId);
        currentId = nodeId;
    }

    return chain;
}

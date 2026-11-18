// In-memory runtime copies of workflows for the LoRA chain feature.
//
// This module is DOM-free, so it can be imported and tested in plain node.
// The settings panel and generation share the cached entries: edits made
// through the panel mark the entry dirty, and generation uses the runtime
// copy instead of re-reading the file.

const EXTENSION_FOLDER = "scripts/extensions/third-party/ComfyInject";

/** @type {Map<string, { workflow: object, dirty: boolean }>} */
const cache = new Map();

/**
 * Loads a workflow JSON file from the extension's workflows folder.
 * @param {string} filename
 * @returns {Promise<object>} The parsed workflow object
 */
export async function fetchWorkflow(filename) {
    const response = await fetch(`/${EXTENSION_FOLDER}/workflows/${filename}`);
    if (!response.ok) {
        throw new Error(`Failed to load workflow "${filename}": ${response.status}`);
    }
    return await response.json();
}

/**
 * Returns the cached runtime entry for a workflow, loading it on first use.
 * @param {string} filename
 * @returns {Promise<{ workflow: object, dirty: boolean }>} The cached entry
 */
export async function getOrLoadWorkflow(filename) {
    const cached = cache.get(filename);
    if (cached) return cached;

    const entry = { workflow: await fetchWorkflow(filename), dirty: false };
    cache.set(filename, entry);
    return entry;
}

/**
 * Returns the cached runtime entry without loading anything.
 * @param {string} filename
 * @returns {{ workflow: object, dirty: boolean } | null}
 */
export function getRuntimeWorkflow(filename) {
    return cache.get(filename) ?? null;
}

/**
 * Marks a cached workflow as edited in memory.
 * @param {string} filename
 * @returns {void}
 */
export function markDirty(filename) {
    const entry = cache.get(filename);
    if (entry) entry.dirty = true;
}

/**
 * Discards the cached copy and loads the workflow from disk again.
 * @param {string} filename
 * @returns {Promise<{ workflow: object, dirty: boolean }>} The fresh entry
 */
export async function reloadWorkflow(filename) {
    cache.delete(filename);
    return await getOrLoadWorkflow(filename);
}

/**
 * Serializes the cached workflow as 2-space JSON.
 * @param {string} filename
 * @returns {string | null} The JSON text, or null when nothing is cached
 */
export function serializeWorkflow(filename) {
    const entry = cache.get(filename);
    return entry ? JSON.stringify(entry.workflow, null, 2) : null;
}

// LLM-facing half of the "rewrite the prompt with AI" feature.
//
// Reads the image-prompt specification out of the user's own preset and asks
// the model to rewrite one prompt against it.  Everything that does not need
// SillyTavern lives in rewriteRules.js.

import { MODULE_NAME } from "../settings.js";
import {
    buildRewriteMessages,
    extractNarrativeWindow,
    neutralizeMacros,
    sanitizeRewrittenPrompt,
    truncate,
    REWRITE_RULES_FALLBACK,
} from "./rewriteRules.js";

// The prompt block the specification is expected to live in, matched by name in
// the active preset.  Falls back to any block that mentions a marker.
const RULES_BLOCK_NAME = "comfyinject";

const RULES_MAX_CHARS = 8000;
const CARD_MAX_CHARS = 1500;

// The fallback warning is worth showing once per session, not once per click.
let warnedAboutFallback = false;

/**
 * @returns {object} The extension's saved settings
 */
function getSettings() {
    return SillyTavern.getContext().extensionSettings[MODULE_NAME] ?? {};
}

/**
 * Picks the image-prompt specification out of a preset's prompt blocks.
 *
 * The block's own `enabled` flag is deliberately ignored: enabled state really
 * lives in prompt_order[], whose per-character ids differ between exported
 * presets and the live settings, and the user naming the block is signal enough.
 * @param {Array<object>|null} prompts
 * @returns {{text: string, source: string}|null}
 */
function pickRulesPrompt(prompts) {
    if (!Array.isArray(prompts)) return null;

    const named = prompts.find(prompt => String(prompt?.name ?? "").trim().toLowerCase() === RULES_BLOCK_NAME);
    if (named?.content?.trim()) {
        return { text: named.content.trim(), source: `preset block "${named.name}"` };
    }

    const byContent = prompts.find(prompt => prompt?.content?.includes("[[IMG:"));
    if (byContent?.content?.trim()) {
        return { text: byContent.content.trim(), source: `preset block "${byContent.name ?? "unnamed"}" (matched by content)` };
    }

    return null;
}

/**
 * Reads the prompt blocks of the currently loaded chat-completion preset.
 * Imported lazily so a core path change degrades to the next tier instead of
 * breaking the extension on load.
 * @returns {Promise<Array<object>|null>}
 */
async function readLivePrompts() {
    try {
        const module = await import("../../../../openai.js");
        return module?.promptManager?.serviceSettings?.prompts ?? null;
    } catch (error) {
        console.warn("[ComfyInject] Could not read the live prompt list:", error);
        return null;
    }
}

/**
 * Reads the prompt blocks of the selected preset as saved on disk.  Covers the
 * text-completion APIs, where the prompt manager is not initialised.
 * @returns {Array<object>|null}
 */
function readSavedPresetPrompts() {
    try {
        const presetManager = SillyTavern.getContext().getPresetManager?.();
        const name = presetManager?.getSelectedPresetName?.();
        if (!name) return null;

        return presetManager?.getCompletionPresetByName?.(name)?.prompts ?? null;
    } catch (error) {
        console.warn("[ComfyInject] Could not read the saved preset:", error);
        return null;
    }
}

/**
 * Finds the image-prompt specification the rewrite should follow.
 * @returns {Promise<{text: string, source: string}>}
 */
export async function resolveRulesText() {
    const override = getSettings().rewrite_rules_override;
    if (typeof override === "string" && override.trim()) {
        return { text: override.trim(), source: "settings override" };
    }

    if (getSettings().rewrite_auto_read_preset !== false) {
        const live = pickRulesPrompt(await readLivePrompts());
        if (live) return live;

        const saved = pickRulesPrompt(readSavedPresetPrompts());
        if (saved) return saved;
    }

    if (!warnedAboutFallback) {
        warnedAboutFallback = true;
        toastr.warning("No ComfyInject prompt block found in the active preset; using the built-in rewrite rules.", "ComfyInject");
    }

    return { text: REWRITE_RULES_FALLBACK, source: "built-in fallback" };
}

/**
 * Reads the current character's description for identity/outfit continuity.
 * getCharacterCardFields() is already macro-substituted and honours chat-level
 * prompt overrides, so it matches what the main model sees.
 * @returns {Promise<string>}
 */
async function getCharacterCardText() {
    const context = SillyTavern.getContext();

    try {
        const chid = context.characterId;
        if (chid === undefined || chid === null) return "";

        if (context.characters?.[chid]?.shallow && typeof context.unshallowCharacter === "function") {
            await context.unshallowCharacter(chid);
        }

        const fields = context.getCharacterCardFields?.();
        if (!fields) return "";

        return truncate(
            [fields.description, fields.personality, fields.scenario].filter(Boolean).join("\n\n"),
            CARD_MAX_CHARS,
        );
    } catch (error) {
        console.warn("[ComfyInject] Could not read the character card for the rewrite:", error);
        return "";
    }
}

/**
 * Rejects if a promise does not settle in time.  The losing promise still has
 * handlers attached, so it cannot surface as an unhandled rejection.
 * @param {Promise<any>} promise
 * @param {number} timeoutMs - 0 or less disables the timeout
 * @returns {Promise<any>}
 */
function withTimeout(promise, timeoutMs) {
    if (!(timeoutMs > 0)) return promise;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)),
            timeoutMs,
        );

        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); },
        );
    });
}

/**
 * Asks the LLM to rewrite one image prompt following the user's own rules.
 *
 * Uses generateRaw(): it runs on the user's main API, carries no chat history or
 * character card of its own, never touches the visible chat, and — unlike a
 * quiet generation — does not emit GENERATION_STARTED, so it cannot invalidate
 * ComfyUI jobs that are still running.
 * @param {object} options
 * @param {string} options.prompt - The prompt being rewritten
 * @param {string} options.ar - Fixed aspect ratio token
 * @param {string} options.shot - Fixed shot token
 * @param {string} options.mes - The message the image lives in
 * @param {number} options.imgIndex - Index of the image within the message
 * @param {Array<{prompt: string, ar: string, shot: string}>} options.siblings - Every image in the message
 * @returns {Promise<{rewritten: string|null, rulesSource: string}>}
 */
export async function rewritePromptWithLlm({ prompt, ar, shot, mes, imgIndex, siblings = [] }) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    if (typeof context.generateRaw !== "function") {
        throw new Error("This SillyTavern version has no generateRaw()");
    }

    const { text: rulesText, source: rulesSource } = await resolveRulesText();

    const { systemPrompt, prompt: userPrompt } = buildRewriteMessages({
        rulesText: truncate(rulesText, RULES_MAX_CHARS),
        prompt: neutralizeMacros(prompt),
        ar,
        shot,
        // Card, narrative and sibling prompts have already had their macros
        // resolved; generateRaw substitutes again, so break the syntax.
        cardText: neutralizeMacros(await getCharacterCardText()),
        excerpt: neutralizeMacros(extractNarrativeWindow(mes, imgIndex, Number(settings.rewrite_context_chars) || 1200)),
        siblings: siblings.map(entry => ({ ...entry, prompt: neutralizeMacros(entry?.prompt ?? "") })),
        targetIndex: imgIndex,
    });

    const raw = await withTimeout(
        context.generateRaw({
            prompt: userPrompt,
            systemPrompt,
            responseLength: Number(settings.rewrite_max_tokens) || 1200,
        }),
        Number(settings.rewrite_timeout_ms) || 0,
    );

    return { rewritten: sanitizeRewrittenPrompt(raw), rulesSource };
}

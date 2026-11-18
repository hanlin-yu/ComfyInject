// Pure helpers for the "rewrite the prompt with AI" feature.
//
// Nothing in here touches SillyTavern or the DOM, so the whole module can be
// imported and tested in plain node.  The SillyTavern-facing half lives in
// rewrite.js, the UI half in dom.js.

/**
 * Matches an injected image tag.  Must stay in sync with buildImgTag() in
 * dom.js and with the regexes in outbound.js / gallery.js / state.js.
 */
export const IMG_TAG_REGEX = /<img class="comfyinject-image"[^>]*>/g;

const PROMPT_ATTR_REGEX = /data-prompt="([^"]*)"/;
const SEED_ATTR_REGEX = /data-seed="([^"]*)"/;

/**
 * Instructions used when the active preset has no ComfyInject block to read.
 * Condensed from the conventions a Danbooru-tag model expects, so a rewrite is
 * still useful out of the box.
 */
export const REWRITE_RULES_FALLBACK = `PROMPT is a comma-separated Danbooru-style tag list followed by a Visual Scene Specification paragraph.

Tag rules:
- All tags lowercase, spaces instead of underscores, separated by ", ".
- At least 20 tags.
- No quality tags (masterpiece, best quality, absurdres) and no @artist tags.
- Do not escape parentheses with backslashes.
- Start with a safety tier tag: safe, sensitive, nsfw or explicit.
- Tag order: safety tier, subject count (1girl / 1boy / 2girls), character, series, clothing and accessories, pose and action, expression, scene and atmosphere, camera.
- NSFW tags go after the pose/action tags and before the expression tags.
- Include the canonical character tag and the franchise tag when the subject is a known character.

Visual Scene Specification:
- A camera-centric paragraph of roughly 80-150 words in plain natural language.
- Describe only what is visible: camera framing, camera angle, the exact number of visible subjects, subject placement, pose, gaze direction, foreground, major background elements, lighting.
- Do not narrate events, tell a story, or infer emotions, intentions or relationships.
- Concise and information-dense; no filler.`;

/**
 * Parses the data attributes of an injected image tag.
 * @param {string} tag - A tag matched by IMG_TAG_REGEX
 * @returns {{prompt: string, seed: string}}
 */
export function parseImgTag(tag) {
    return {
        prompt: tag.match(PROMPT_ATTR_REGEX)?.[1]?.replace(/&quot;/g, '"') ?? "",
        seed: tag.match(SEED_ATTR_REGEX)?.[1] ?? "",
    };
}

/**
 * Returns the character offsets of every injected image tag in a message.
 * @param {string} mes
 * @returns {Array<{start: number, end: number, tag: string}>}
 */
export function findImageTagOffsets(mes) {
    const offsets = [];

    for (const match of String(mes ?? "").matchAll(IMG_TAG_REGEX)) {
        offsets.push({ start: match.index, end: match.index + match[0].length, tag: match[0] });
    }

    return offsets;
}

/**
 * Decodes the entities SillyTavern leaves in stored message text.
 * @param {string} text
 * @returns {string}
 */
export function decodeHtmlEntities(text) {
    return text
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&apos;", "'")
        .replaceAll("&nbsp;", " ")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
}

/**
 * Turns stored message HTML into readable plain text for an LLM.
 * Image tags become "[image]" so the model can see where the pictures sit.
 * @param {string} text
 * @returns {string}
 */
export function toPlainText(text) {
    return decodeHtmlEntities(
        String(text ?? "")
            .replace(IMG_TAG_REGEX, "[image]")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n\n")
            .replace(/<[^>]+>/g, ""),
    )
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * The narrative around one image, used as scene context for the rewrite.
 * Offsets have to come from message.mes: the rendered DOM has been restructured
 * by markdown and by other extensions, so its character offsets do not line up.
 * @param {string} mes
 * @param {number} imgIndex
 * @param {number} radius - Characters of narrative to take on each side
 * @returns {string}
 */
export function extractNarrativeWindow(mes, imgIndex, radius) {
    const text = String(mes ?? "");
    const tags = findImageTagOffsets(text);
    const target = tags[imgIndex];

    if (!target) return toPlainText(text);

    let from = Math.max(0, target.start - radius);
    let to = Math.min(text.length, target.end + radius);

    // Never cut through a tag: the fragment left behind (" />", "<img class")
    // is not a complete tag, so it would survive tag stripping and reach the model.
    for (const { start, end } of tags) {
        if (start < from && end > from) from = start;
        if (start < to && end > to) to = end;
    }

    return toPlainText(text.slice(from, to));
}

/**
 * Breaks {{macro}} syntax in text that came from a card or a message.
 * generateRaw runs substituteParams over everything it is given, so an
 * un-neutralised macro would be evaluated a second time — and the character
 * card's macros have already been resolved by getCharacterCardFields().
 * @param {string} text
 * @returns {string}
 */
export function neutralizeMacros(text) {
    return String(text ?? "").replaceAll("{{", "{ {").replaceAll("}}", "} }");
}

/**
 * Truncates text to a character budget, marking where it was cut.
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function truncate(text, limit) {
    const value = String(text ?? "");
    return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

const SYSTEM_FRAMING = `You rewrite ONE image-generation prompt for a Danbooru-tag style image model.
The prompt belongs to a single [[IMG: PROMPT | AR | SHOT | SEED ]] marker inside a roleplay message.
The SPECIFICATION below was written for the narrative writer. Apply only the parts that define the
PROMPT segment: the tag vocabulary and tag order, the safety tier tag, the NSFW tag placement, and the
Visual Scene Specification. Ignore anything about how many markers to write, where to place them, and
the AR/SHOT/SEED vocabularies — those are already fixed and must not appear in your reply.`;

const OUTPUT_CONTRACT = `OUTPUT CONTRACT
- Reply with the rewritten PROMPT only — nothing before or after it.
- No pipes (|), no [[IMG: ... ]] wrapper, no AR/SHOT/SEED segments, no labels, no quotes, no code fences, no commentary.
- Format: the tag list first, then a blank line, then the Visual Scene Specification paragraph.
- Never emit the characters "<" or ">".
- Keep the same subject, character identity, outfit and moment as the CURRENT PROMPT; only rewrite the wording so it satisfies the specification.
- Do not reuse the other prompts given as context: every marker must read as its own distinct image.`;

const CLOSE_SHOT_LINE = `This marker is a CLOSE shot: follow the specification's CLOSE definition — build the whole
prompt around exactly ONE local part (face, eyes, lips, hands, fingers, chest, hips, a prop, a piece of
clothing, or the single focal object of the moment) and reduce the background to soft bokeh.`;

/**
 * Builds the system and user messages for the rewrite call.
 * @param {object} options
 * @param {string} options.rulesText - The image-prompt specification to follow
 * @param {string} options.prompt - The prompt being rewritten
 * @param {string} options.ar - Fixed aspect ratio token
 * @param {string} options.shot - Fixed shot token
 * @param {string} options.cardText - Character card context (already capped)
 * @param {string} options.excerpt - Narrative around the target image
 * @param {Array<{prompt: string, ar: string, shot: string}>} options.siblings - Every image in the message
 * @param {number} options.targetIndex - Index of the image being rewritten
 * @param {number} [options.siblingPromptLimit] - Per-prompt character budget
 * @returns {{systemPrompt: string, prompt: string}}
 */
export function buildRewriteMessages({
    rulesText,
    prompt,
    ar,
    shot,
    cardText,
    excerpt,
    siblings = [],
    targetIndex = 0,
    siblingPromptLimit = 240,
}) {
    const systemPrompt = [
        SYSTEM_FRAMING,
        "=== SPECIFICATION ===",
        String(rulesText ?? "").trim(),
        "=== END SPECIFICATION ===",
        shot === "CLOSE" ? CLOSE_SHOT_LINE : "",
        OUTPUT_CONTRACT,
    ].filter(Boolean).join("\n\n");

    const siblingLines = siblings
        .map((entry, index) => {
            const marker = index === targetIndex ? "  <- TARGET (the one you are rewriting)" : "";
            const framing = [entry?.ar, entry?.shot].filter(Boolean).join(" / ");
            return `${index + 1}. ${framing ? `[${framing}] ` : ""}${truncate(entry?.prompt ?? "", siblingPromptLimit)}${marker}`;
        })
        .join("\n");

    const userPrompt = [
        "TARGET MARKER (fixed — do not repeat these in your reply)",
        `AR: ${ar || "SQUARE"}`,
        `SHOT: ${shot || "MEDIUM"}`,
        "",
        "CHARACTER CARD",
        cardText?.trim() || "(not available)",
        "",
        "IMAGE PROMPTS ALREADY USED IN THIS MESSAGE",
        siblingLines || "(none)",
        "",
        "NARRATIVE EXCERPT AROUND THE TARGET IMAGE",
        '"""',
        excerpt?.trim() || "(not available)",
        '"""',
        "",
        "CURRENT PROMPT OF THE TARGET IMAGE",
        '"""',
        prompt,
        '"""',
        "",
        "Rewrite the target prompt now. Reply with the PROMPT alone: the tags, then a blank line, then the",
        "Visual Scene Specification. No pipes, no marker, no commentary.",
    ].join("\n");

    return { systemPrompt, prompt: userPrompt };
}

/**
 * Cleans a model response into a prompt that is safe to store in a message.
 *
 * Returning null means "not usable" and the caller keeps the original prompt.
 * @param {string} raw - The raw model response
 * @returns {string|null}
 */
export function sanitizeRewrittenPrompt(raw) {
    if (typeof raw !== "string") return null;

    let text = raw.trim();
    if (!text) return null;

    // Reasoning blocks: generateRaw has no removeReasoning, and some models leak these.
    text = text.replace(/<(thinking|think|reasoning|analysis|thought)>[\s\S]*?<\/\1>/gi, " ");

    // Markdown fences, however they were opened.
    text = text.replace(/```[a-z]*\s*/gi, " ").replace(/```/g, " ");
    text = text.trim();

    // If the model wrapped the prompt in a marker, keep only the PROMPT segment.
    const markerStart = text.search(/\[\[IMG:/i);
    if (markerStart !== -1) {
        text = text.slice(markerStart).replace(/^\[\[IMG:\s*/i, "");
    }

    // A prompt may never contain a pipe — it is the marker's separator.
    const pipe = text.indexOf("|");
    if (pipe !== -1) text = text.slice(0, pipe);

    // Leading "PROMPT:" label and wrapping quotes/brackets.
    text = text.trim()
        .replace(/^(?:PROMPT|prompt)\s*[:：]\s*/, "")
        .replace(/^[["'“”‘’]+/, "")
        .replace(/[\]"'“”‘’]+$/, "")
        .trim();

    // "<" and ">" would truncate the stored <img> tag: buildImgTag only escapes
    // quotes, and every tag regex in the codebase stops at the first ">".
    text = text.replace(/[<>]/g, "");
    text = text.replace(/\n{3,}/g, "\n\n").trim();

    if (text.length < 60) return null;
    if (!/[a-z]/.test(text)) return null;
    if (text.includes("[[IMG")) return null;

    return text;
}

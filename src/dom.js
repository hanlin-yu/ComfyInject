import { hasImageMarker, parseImageMarkers, generateParsedMarker } from "./parse.js";
import { generateImage } from "./comfy.js";
import { saveLastSeed, getImageData } from "./state.js";
import { rewritePromptWithLlm } from "./rewrite.js";
import { MODULE_NAME } from "../settings.js";

/**
 * Builds the <img> tag string that gets injected into the message.
 * Stores prompt and seed as data attributes for outbound.js to read.
 * @param {string} imageUrl - The full ComfyUI /view URL
 * @param {string} prompt - The raw prompt returned by generateImage()
 * @param {number} seed - The resolved seed used for generation
 * @returns {string} The HTML img tag string
 */
function buildImgTag(imageUrl, prompt, seed) {
    return `<img class="comfyinject-image" src="${imageUrl}" data-prompt="${prompt.replace(/"/g, '&quot;')}" data-seed="${seed}" />`;
}

/**
 * Finds the current array index of a message by its send_date.
 * @param {string} sendDate - The send_date to look for
 * @returns {number} The current index, or -1 if not found
 */
function findIndexBySendDate(sendDate) {
    const context = SillyTavern.getContext();
    for (let i = 0; i < context.chat.length; i++) {
        if (context.chat[i].send_date === sendDate) return i;
    }
    return -1;
}

/**
 * Returns the current marker repair toast mode.
 * @returns {"all" | "failures" | "off"}
 */
function getRepairToastMode() {
    return SillyTavern.getContext().extensionSettings[MODULE_NAME]?.repair_toast_mode || "failures";
}

/**
 * Returns true if a repairMeta object contains any meaningful repair info.
 * Non-canonical formatting alone does not count unless something was actually
 * defaulted, ignored, or flagged.
 * @param {object|null} repairMeta
 * @returns {boolean}
 */
function hasMeaningfulRepair(repairMeta) {
    if (!repairMeta || typeof repairMeta !== "object") return false;

    const defaulted = Array.isArray(repairMeta.defaulted) ? repairMeta.defaulted : [];
    const duplicateTokens = repairMeta.duplicateTokens || {};

    const duplicateAr = Array.isArray(duplicateTokens.AR) ? duplicateTokens.AR : [];
    const duplicateShot = Array.isArray(duplicateTokens.SHOT) ? duplicateTokens.SHOT : [];
    const duplicateSeed = Array.isArray(duplicateTokens.SEED) ? duplicateTokens.SEED : [];

    return (
        defaulted.length > 0 ||
        duplicateAr.length > 0 ||
        duplicateShot.length > 0 ||
        duplicateSeed.length > 0 ||
        repairMeta.possibleSeedInPrompt === true
    );
}

/**
 * Shows a grouped repair toast for one live-rendered message.
 * This is only used for successful repaired markers.
 * @param {number} repairedCount
 * @param {number} totalCount
 */
function maybeShowGroupedRepairToast(repairedCount, totalCount) {
    if (getRepairToastMode() !== "all") return;
    if (repairedCount <= 0) return;

    toastr.warning(
        `Repaired ${repairedCount}/${totalCount} markers in this message. See Image Gallery for details.`,
        "ComfyInject"
    );
}

/**
 * Logs a grouped repair warning for one live-rendered message.
 * This mirrors the user-facing grouped repair toast.
 * @param {number} messageIndex
 * @param {number} repairedCount
 * @param {number} totalCount
 */
function maybeLogGroupedRepairWarning(messageIndex, repairedCount, totalCount) {
    if (getRepairToastMode() !== "all") return;
    if (repairedCount <= 0) return;

    console.warn("[ComfyInject] Repaired markers in message:", {
        messageIndex,
        repairedCount,
        totalCount,
    });
}

/**
 * Shows a parse-failure toast based on the user's marker repair toast setting.
 * @param {string} errorText
 */
function maybeShowParseFailureToast(errorText) {
    const mode = getRepairToastMode();
    if (mode === "off") return;

    toastr.warning(errorText, "ComfyInject");
}

/**
 * Shows one bulk-scan repair summary toast after scanning old messages.
 * This avoids spamming one toast per message during chat load.
 * @param {number} repairedMessages
 * @param {number} repairedMarkers
 */
function maybeShowBulkRepairSummaryToast(repairedMessages, repairedMarkers) {
    if (getRepairToastMode() !== "all") return;
    if (repairedMarkers <= 0) return;

    toastr.warning(
        `Repaired ${repairedMarkers} markers across ${repairedMessages} existing messages. See Image Gallery for details.`,
        "ComfyInject"
    );
}

/**
 * Logs one bulk-scan repair summary warning after scanning old messages.
 * @param {number} repairedMessages
 * @param {number} repairedMarkers
 */
function maybeLogBulkRepairSummaryWarning(repairedMessages, repairedMarkers) {
    if (getRepairToastMode() !== "all") return;
    if (repairedMarkers <= 0) return;

    console.warn("[ComfyInject] Repaired markers during bulk scan:", {
        repairedMessages,
        repairedMarkers,
    });
}

/**
 * Formats a marker position label within a message.
 * Only includes numbering when the message had multiple markers.
 * @param {number} markerNumber - 1-based marker number within the message
 * @param {number} totalMarkers - Total markers in the message
 * @returns {string}
 */
function formatMarkerPosition(markerNumber, totalMarkers) {
    return totalMarkers > 1 ? ` ${markerNumber}/${totalMarkers}` : "";
}

// A marker as it ends up in the rendered message.  [[IMG: ... ]] is not a
// markdown construct, so ST leaves it sitting in a text node untouched.
const MARKER_TEXT_REGEX = /\[\[IMG:\s*.+?\s*\]\]/gs;

// ST's sanitizer prefixes custom classes with "custom-" (see addDOMPurifyHooks
// in chats.js), so a marker rendered from message.mes carries the prefixed name
// while one we inserted ourselves keeps the raw one.  Both have to be matched.
const MARKER_INDEX_CLASS = /^(?:custom-)?comfyinject-idx-(\d+)$/;

/**
 * Returns the rendered text container of a message, if it is currently on screen.
 * @param {number} messageIndex
 * @returns {HTMLElement|null}
 */
function getMesText(messageIndex) {
    return document.querySelector(`[mesid="${messageIndex}"] .mes_text`);
}

/**
 * Builds the <img> element for a finished generation.
 * Kept in sync with buildImgTag(), which renders the stored HTML string.
 * @param {string} imageUrl
 * @param {string} prompt
 * @param {number} seed
 * @returns {HTMLImageElement}
 */
function createImageElement(imageUrl, prompt, seed) {
    const img = document.createElement("img");
    img.className = "comfyinject-image";
    img.src = imageUrl;
    img.dataset.prompt = prompt;
    img.dataset.seed = String(seed);
    return img;
}

/**
 * Builds the placeholder element shown while a marker's image is generating.
 * @param {number} markerIndex
 * @param {number} markerCount
 * @returns {HTMLSpanElement}
 */
function createPendingElement(markerIndex, markerCount) {
    const span = document.createElement("span");
    span.className = `comfyinject-pending comfyinject-idx-${markerIndex}`;
    span.textContent = `[Generating image ${markerIndex + 1}/${markerCount}...]`;
    return span;
}

/**
 * Builds the element shown when a marker produced no image.
 * @param {string} text
 * @returns {HTMLSpanElement}
 */
function createErrorElement(text) {
    const span = document.createElement("span");
    span.className = "comfyinject-error";
    span.textContent = text;
    return span;
}

/**
 * Replaces every [[IMG: ...]] marker in a rendered message with an element,
 * touching only the text nodes that hold a marker.
 *
 * This is what keeps the rest of the message safe: updateMessageBlock() would
 * rebuild all of .mes_text and discard anything other extensions attached to
 * it — LittleWhiteBox renders HTML code blocks into sandboxed iframes, and its
 * panel would be replaced by the raw code block with nothing left to rebuild it.
 * @param {HTMLElement} mesText - The message's .mes_text element
 * @param {() => Node} createNode - Called once per marker, in document order
 * @returns {number} How many markers were replaced
 */
function replaceMarkerText(mesText, createNode) {
    const walker = document.createTreeWalker(mesText, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let replaced = 0;

    for (const node of textNodes) {
        const text = node.nodeValue;
        if (!text?.includes("[[IMG:")) continue;

        const matches = [...text.matchAll(MARKER_TEXT_REGEX)];
        if (matches.length === 0) continue;

        // Build the elements in document order, then splice them in from the
        // back so the offsets of the earlier matches stay valid.
        const elements = matches.map(() => createNode());

        for (let i = matches.length - 1; i >= 0; i--) {
            const match = matches[i];
            node.splitText(match.index + match[0].length);
            const target = node.splitText(match.index);
            target.replaceWith(elements[i]);
        }

        replaced += matches.length;
    }

    return replaced;
}

/**
 * Returns the next free marker index for a rendered message — one past the
 * highest index already present in it.
 * @param {HTMLElement} mesText
 * @returns {number}
 */
function getNextMarkerIndex(mesText) {
    let next = 0;

    for (const element of mesText.querySelectorAll("[class*='comfyinject-idx-']")) {
        for (const className of element.classList) {
            const match = MARKER_INDEX_CLASS.exec(className);
            if (match) next = Math.max(next, Number(match[1]) + 1);
        }
    }

    return next;
}

/**
 * Points a rendered message at its markers without rebuilding it.
 *
 * Markers already in the DOM — placeholders the live stream inserted as it
 * streamed, or ones rendered back from message.mes — keep the index they were
 * created with.  Only markers still sitting in the message as literal text need
 * an element built for them, and they follow the markers already resolved, in
 * the same order parseImageMarkers() reports them.
 * @param {number} messageIndex
 * @param {number} markerCount
 */
function prepareMarkerSlots(messageIndex, markerCount) {
    const mesText = getMesText(messageIndex);
    if (!mesText) return;

    let nextIndex = getNextMarkerIndex(mesText);
    replaceMarkerText(mesText, () => createPendingElement(nextIndex++, markerCount));
}

/**
 * Returns the element currently standing in for one marker, if it is rendered.
 * @param {number} messageIndex
 * @param {number} markerIndex
 * @returns {Element|null}
 */
function getMarkerSlot(messageIndex, markerIndex) {
    const mesText = getMesText(messageIndex);
    if (!mesText) return null;

    return mesText.querySelector(`.comfyinject-idx-${markerIndex}, .custom-comfyinject-idx-${markerIndex}`);
}

let activeStream = null;
const LIVE_STREAM_SCAN_INTERVAL_MS = 500;

// True while a renderLiveStream() call is already queued for the next animation frame.
// Prevents queuing more than one rAF per frame.
let liveRenderScheduled = false;

// Tracks which message indices are currently being processed to prevent duplicate jobs.
const processingMessages = new Set();

// Incremented whenever the generation context is invalidated:
// new generation started, generation stopped/cancelled, or chat changed.
// processMessage() captures this at call time and discards results if it changed.
let activeGenerationId = 0;

// True between GENERATION_STARTED and GENERATION_ENDED/STOPPED for a visible
// generation.  A prompt rewrite must not run alongside one: both would be
// talking to the same API, and a new generation invalidates the message the
// rewrite is about to write to.
let generationInFlight = false;

// Set while an LLM prompt rewrite is in flight.  Only one at a time — a second
// generateRaw() would compete for the shared response-length setting.
let activeRewrite = null;

/**
 * Bumps the generation ID, invalidating any in-progress processMessage results,
 * and clears the per-message processing guard so new calls are not blocked.
 */
function bumpGenerationId() {
    activeGenerationId++;
    processingMessages.clear();
}

/**
 * Resets live stream marker tracking for a new generation.
 */
function resetLiveStream() {
    stopLiveStreamScanner();

    activeStream = {
        text: "",
        jobs: new Map(),
        scanner: setInterval(startLiveMarkerGenerations, LIVE_STREAM_SCAN_INTERVAL_MS),
    };
}

/**
 * Stops the live stream scanner without discarding already-started jobs.
 */
function stopLiveStreamScanner() {
    if (!activeStream?.scanner) return;

    clearInterval(activeStream.scanner);
    activeStream.scanner = null;
}

/**
 * Clears all live stream state for the current generation.
 */
function clearLiveStream() {
    stopLiveStreamScanner();
    activeStream = null;
}

/**
 * Schedules renderLiveStream() for the next animation frame.
 * Multiple calls within the same frame are coalesced into one render.
 *
 * ST fires STREAM_TOKEN_RECEIVED before it calls onProgressStreaming() to
 * update the DOM (they are consecutive awaits in the streaming loop).
 * Deferring to rAF guarantees we run after ST has written the formatted HTML
 * but before the browser paints, so the user only ever sees our version.
 */
function scheduleRenderLiveStream() {
    if (liveRenderScheduled) return;
    liveRenderScheduled = true;
    requestAnimationFrame(() => {
        liveRenderScheduled = false;
        if (activeStream?.jobs.size > 0) renderLiveStream();
    });
}

/**
 * Returns the best current message index to use while streaming.
 * During normal streaming ST has already created the live bot message.
 * @returns {number}
 */
function getLiveMessageIndex() {
    const context = SillyTavern.getContext();
    if (!Array.isArray(context.chat) || context.chat.length === 0) return 0;

    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (!context.chat[i]?.is_user) return i;
    }

    return context.chat.length - 1;
}

/**
 * Builds a stable key for one marker occurrence within the streamed reply.
 * Marker order is more reliable than raw marker text because final message
 * formatting can differ slightly from the stream buffer.
 * @param {number} markerIndex
 * @returns {string}
 */
function getMarkerJobKey(markerIndex) {
    return String(markerIndex);
}

/**
 * Updates the stream buffer from ST's stream event payload.
 * Current ST sends the full generated text so far; this also tolerates
 * providers/extensions that emit incremental chunks.
 * @param {string} text
 */
function updateStreamText(text) {
    if (!activeStream) resetLiveStream();

    const incoming = String(text ?? "");
    if (!incoming) return;

    if (!activeStream.text || incoming.startsWith(activeStream.text)) {
        activeStream.text = incoming;
    } else {
        activeStream.text += incoming;
    }

    // Schedule a render for the next animation frame.
    // ST updates the DOM *after* firing this event, so a direct call here
    // would read stale HTML.  rAF fires after ST's DOM write but before paint.
    if (activeStream.jobs.size > 0) scheduleRenderLiveStream();
}

/**
 * Starts ComfyUI jobs as soon as complete markers appear in streamed output.
 * Jobs are cached and consumed later by processMessage().
 */
function startLiveMarkerGenerations() {
    if (!activeStream?.text) return;

    const messageIndex = getLiveMessageIndex();
    const parsedMarkers = parseImageMarkers(activeStream.text, messageIndex);

    parsedMarkers.forEach((parsed, markerIndex) => {
        if (parsed.status !== "parsed") return;

        const key = getMarkerJobKey(markerIndex);
        if (activeStream.jobs.has(key)) return;

        const promise = generateParsedMarker(parsed, messageIndex);
        activeStream.jobs.set(key, { promise, result: null, used: false });

        promise.then(result => {
            const job = activeStream?.jobs.get(key);
            if (job) {
                job.result = result;
                renderLiveStream();
            }
        });

        console.log("[ComfyInject] Live marker detected, ComfyUI job started:", {
            messageIndex,
            markerNumber: markerIndex + 1,
        });
    });

    // Re-render the live message on every scan tick so placeholders and
    // completed images stay in sync with the streamed text.
    if (activeStream.jobs.size > 0) renderLiveStream();
}

/**
 * Returns a pre-started generation promise for a final rendered marker.
 * @param {object} parsed
 * @param {number} markerIndex
 * @returns {Promise<object>|null}
 */
function getLiveGeneration(parsed, markerIndex) {
    if (!activeStream?.jobs) return null;

    const key = getMarkerJobKey(markerIndex);
    const job = activeStream.jobs.get(key);
    if (!job || job.used) return null;

    job.used = true;
    console.log("[ComfyInject] Reusing live ComfyUI job:", {
        markerNumber: markerIndex + 1,
    });
    return job.promise;
}

/**
 * Re-renders the live streaming message with current job states.
 * Markers with completed jobs are replaced with images or error spans.
 * Markers with in-flight jobs are replaced with pending placeholder spans.
 *
 * Reads ST's already-formatted .mes_text innerHTML, replaces [[IMG:...]]
 * fragments with placeholders or images, and writes the result back.
 * Operating on the formatted HTML preserves ST's markdown styling
 * (coloured quotes, bold, etc.) and avoids overwriting message.mes so
 * processMessage still sees the raw markers when the stream ends.
 */
function renderLiveStream() {
    if (!activeStream) return;

    const messageIndex = getLiveMessageIndex();

    // Read ST's already-formatted HTML rather than the raw stream buffer.
    // [[IMG:...]] is not a markdown construct so it appears literally in the
    // rendered output.  Replacing only those fragments lets us keep ST's
    // surrounding formatting (coloured quotes, bold, etc.) intact.
    const msgNode = document.querySelector(`[mesid="${messageIndex}"] .mes_text`);
    if (!msgNode) return;

    const currentHtml = msgNode.innerHTML;

    const totalMarkers = (currentHtml.match(/\[\[IMG:\s*.+?\s*\]\]/gs) || []).length;
    if (totalMarkers === 0) return;

    let markerIdx = 0;
    const displayHtml = currentHtml.replace(/\[\[IMG:\s*.+?\s*\]\]/gs, () => {
        const i = markerIdx++;
        const key = getMarkerJobKey(i);
        const job = activeStream?.jobs.get(key);
        const markerPosition = formatMarkerPosition(i + 1, totalMarkers);

        if (!job || job.result === null) {
            // The index lets processMessage() pick this placeholder back up
            // after the stream ends instead of re-rendering the message.
            return `<span class="comfyinject-pending comfyinject-idx-${i}">[Generating image${markerPosition}...]</span>`;
        }

        const result = job.result;
        if (result?.status === "ok") {
            return buildImgTag(result.imageUrl, result.prompt, result.seed);
        }
        return `<span class="comfyinject-error">[Image generation failed${markerPosition ? `: marker${markerPosition}` : ""}]</span>`;
    });

    if (displayHtml !== currentHtml) msgNode.innerHTML = displayHtml;
}

/**
 * Builds one of the overlay buttons shown on a rendered image.
 * Icons carry fa-fw so every button ends up the same width regardless of glyph.
 * @param {string} className - Marker class, also used to detect an existing button
 * @param {string} title - Tooltip text
 * @param {string} icon - Full Font Awesome class list
 * @param {string} sendDate - The message's send_date
 * @param {number} imgIndex - Which image within the message (0-based)
 * @returns {HTMLDivElement}
 */
function makeImageButton(className, title, icon, sendDate, imgIndex) {
    const btn = document.createElement("div");
    btn.className = className;
    btn.dataset.senddate = sendDate;
    btn.dataset.imgindex = imgIndex;
    btn.title = title;
    btn.style.cssText = "cursor: pointer; background: rgba(0,0,0,0.6); color: white; border-radius: 4px; padding: 2px 8px; font-size: 12px; line-height: 1.4; text-align: center;";
    btn.innerHTML = `<i class="${icon}"></i>`;
    return btn;
}

/**
 * Adds the retry and prompt-rewrite buttons to all rendered comfyinject images
 * in a message.
 * This is done via DOM manipulation (not in message.mes) because
 * ST's HTML sanitizer strips custom divs when rendering messages.
 * Each button stores send_date and imgindex for its handler.
 * @param {number} index - The current message array index (for DOM lookup via mesid)
 */
function addRetryButtons(index) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    if (!message) return;

    const messageNode = document.querySelector(`[mesid="${index}"]`);
    if (!messageNode) return;

    // ST's sanitizer prefixes custom classes with "custom-" in messages rendered
    // from mes, while images we insert into the DOM ourselves keep the raw name.
    const images = messageNode.querySelectorAll(".comfyinject-image, .custom-comfyinject-image");
    if (images.length === 0) return;

    const sendDate = message.send_date;

    images.forEach((img, imgIndex) => {
        // Reuse the wrapper if an earlier pass already added one, so each button
        // can be checked for on its own.
        let wrapper = img.parentElement?.classList?.contains("comfyinject-wrapper") ? img.parentElement : null;

        if (!wrapper) {
            // Wrap the image in a relative container so we can position the buttons
            wrapper = document.createElement("div");
            wrapper.className = "comfyinject-wrapper";
            wrapper.style.cssText = "position: relative; display: inline-block;";
            img.parentElement.insertBefore(wrapper, img);
            wrapper.appendChild(img);
        }

        // The buttons stack in a flex column so they stay aligned as a pair. Sizing
        // them by hand with top offsets drifts between themes, whose icon line
        // heights differ.
        let actions = wrapper.querySelector(".comfyinject-actions");
        if (!actions) {
            actions = document.createElement("div");
            actions.className = "comfyinject-actions";
            actions.style.cssText = "position: absolute; top: 6px; right: 6px; display: flex; flex-direction: column; gap: 4px; z-index: 10;";
            wrapper.appendChild(actions);
        }

        // Buttons added by an earlier build hang off the wrapper directly
        for (const selector of [".comfyinject-retry", ".comfyinject-rewrite"]) {
            const existing = wrapper.querySelector(selector);
            if (existing && existing.parentElement !== actions) actions.appendChild(existing);
        }

        if (!actions.querySelector(".comfyinject-retry")) {
            const btn = makeImageButton("comfyinject-retry", "Regenerate with new seed", "fa-solid fa-fw fa-rotate", sendDate, imgIndex);

            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                e.preventDefault();
                await retryImage(sendDate, imgIndex, btn);
            });

            actions.appendChild(btn);
        }

        if (!actions.querySelector(".comfyinject-rewrite")) {
            const btn = makeImageButton("comfyinject-rewrite", "Rewrite the prompt with AI, then regenerate", "fa-solid fa-fw fa-wand-magic-sparkles", sendDate, imgIndex);

            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                e.preventDefault();
                await rewriteImagePrompt(sendDate, imgIndex, btn);
            });

            actions.appendChild(btn);
        }
    });
}

/**
 * Adds retry buttons to all rendered comfyinject images across the entire chat.
 * Called after scanning existing messages on chat load.
 */
function addAllRetryButtons() {
    const context = SillyTavern.getContext();
    for (let i = 0; i < context.chat.length; i++) {
        addRetryButtons(i);
    }
}

/**
 * Processes a single message by index.
 * If it contains [[IMG: ... ]] markers, generates the images sequentially,
 * injects <img> tags into both the DOM and the mes field,
 * saves metadata keyed by send_date, and calls saveChat().
 * @param {number} index - The message index in the chat array
 */
async function processMessage(index, options = {}) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    const { updateMessageBlock } = SillyTavern.getContext();
    const { suppressRepairNotifications = false, checkGenerationId = false } = options;

    if (!message) return { repairedCount: 0, totalCount: 0 };

    // Only process bot messages
    if (message.is_user) return { repairedCount: 0, totalCount: 0 };

    // Skip if no marker present
    if (!hasImageMarker(message.mes)) return { repairedCount: 0, totalCount: 0 };

    // Prevent concurrent processing of the same message index.
    // A second call for the same index (e.g. duplicate CHARACTER_MESSAGE_RENDERED)
    // would start redundant ComfyUI jobs for markers that are already in flight.
    if (processingMessages.has(index)) {
        console.log(`[ComfyInject] Skipping duplicate processMessage for index ${index}`);
        return { repairedCount: 0, totalCount: 0 };
    }

    // Snapshot the current generation ID so we can detect cancellation or a new
    // generation starting while we are awaiting ComfyUI results.
    const capturedGenId = activeGenerationId;
    processingMessages.add(index);

    try {
        console.log(`[ComfyInject] Processing message ${index}`);

        const originalSendDate = message.send_date;
        const parsedMarkers = parseImageMarkers(message.mes, index);
        const markerCount = parsedMarkers.length;

        if (markerCount === 0) return { repairedCount: 0, totalCount: 0 };

        // Replace each [[IMG:...]] marker with an indexed placeholder.
        // Jobs can complete out of order, so each needs a unique handle to target.
        // The closing `"` in the class name bounds the index so idx-1 won't match idx-10.
        let pidx = 0;
        message.mes = message.mes.replace(/\[\[IMG:\s*.+?\s*\]\]/gs, () => {
            const i = pidx++;
            return `<span class="comfyinject-pending comfyinject-idx-${i}">[Generating image ${i + 1}/${markerCount}...]</span>`;
        });

        // Mirror that in the rendered message by swapping the markers themselves
        // for placeholder elements.  updateMessageBlock() is deliberately not
        // used here: it rebuilds all of .mes_text, which takes out anything other
        // extensions have attached to the message (rendered HTML panels, etc).
        prepareMarkerSlots(index, markerCount);

        const useLiveGenerations = activeStream && index === getLiveMessageIndex();

        // Sparse results array — filled by handleJobResult as each job settles.
        const results = new Array(markerCount).fill(null);
        let repairedCount = 0;

        /**
         * Called synchronously when each job settles.
         * Swaps the matching indexed placeholder for the finished image and
         * updates message.mes, so the user sees each image as soon as it is
         * ready without the message being re-rendered.
         * @param {object} result
         * @param {number} markerIndex
         */
        const handleJobResult = (result, markerIndex) => {
            // Drop the result if the generation was cancelled or superseded.
            if (checkGenerationId && capturedGenId !== activeGenerationId) return;

            const currentMessage = context.chat[index];
            if (!currentMessage || currentMessage.send_date !== originalSendDate) return;

            const markerNumber = markerIndex + 1;
            const markerPosition = formatMarkerPosition(markerNumber, markerCount);
            let replacement;
            let replacementElement;

            if (result?.status === "ok") {
                if (hasMeaningfulRepair(result.repairMeta)) repairedCount++;
                results[markerIndex] = result;
                replacement = buildImgTag(result.imageUrl, result.prompt, result.seed);
                replacementElement = createImageElement(result.imageUrl, result.prompt, result.seed);

            } else if (result?.status === "parse_error") {
                const reason = result?.reason;
                let errorText;
                switch (reason) {
                    case "empty_prompt": errorText = `[Image marker${markerPosition} invalid: empty prompt]`; break;
                    case "empty_marker": errorText = `[Image marker${markerPosition} invalid: empty marker]`; break;
                    default:             errorText = `[Image marker${markerPosition} invalid]`; break;
                }
                console.warn("[ComfyInject] Image marker parse failed:", {
                    reason, rawMarker: result?.rawMarker || null,
                    messageIndex: index, markerNumber, totalMarkers: markerCount,
                });
                if (!suppressRepairNotifications) maybeShowParseFailureToast(errorText);
                replacement = `<span class="comfyinject-error">${errorText}</span>`;
                replacementElement = createErrorElement(errorText);

            } else if (result?.status === "generation_error") {
                const errorText = `[Image generation failed${markerPosition ? `: marker${markerPosition}` : ""}]`;
                console.error("[ComfyInject] Image generation failed:", {
                    messageIndex: index, markerNumber, totalMarkers: markerCount,
                });
                replacement = `<span class="comfyinject-error">${errorText}</span>`;
                replacementElement = createErrorElement(errorText);

            } else {
                const errorText = `[Image generation failed${markerPosition ? `: marker${markerPosition}` : ""}]`;
                console.error("[ComfyInject] Unexpected marker result shape:", {
                    result, messageIndex: index, markerNumber, totalMarkers: markerCount,
                });
                replacement = `<span class="comfyinject-error">${errorText}</span>`;
                replacementElement = createErrorElement(errorText);
            }

            // Target exactly the indexed placeholder — safe for out-of-order completion.
            currentMessage.mes = currentMessage.mes.replace(
                new RegExp(`<span[^>]*comfyinject-idx-${markerIndex}"[^>]*>[^<]*</span>`),
                replacement
            );

            // Swap that same marker's node in the rendered message, leaving the
            // rest of it — including anything other extensions put there — intact.
            const slot = getMarkerSlot(index, markerIndex);

            if (slot) {
                slot.replaceWith(replacementElement);
            } else if (getMesText(index)) {
                // The marker is on screen but has no single node to swap, which
                // happens when ST splits it with inline markup. Re-render as a
                // last resort: it costs other extensions their DOM work, but the
                // image still shows up.
                try { updateMessageBlock(index, currentMessage); } catch (_e) {}
            }
        };

        // Build one promise per marker.
        // Parse errors are handled synchronously; generation jobs call handleJobResult
        // as soon as ComfyUI responds, inserting the image without waiting for others.
        const jobPromises = parsedMarkers.map((parsed, markerIndex) => {
            if (parsed.status === "parse_error") {
                handleJobResult(parsed, markerIndex);
                return Promise.resolve();
            }

            const liveJob = useLiveGenerations ? getLiveGeneration(parsed, markerIndex) : null;
            const jobPromise = liveJob ?? generateParsedMarker(parsed, index);
            return jobPromise.then(result => handleJobResult(result, markerIndex));
        });

        if (useLiveGenerations) {
            clearLiveStream();
        }

        // Wait for all jobs to settle.  Each image was already inserted by handleJobResult.
        await Promise.all(jobPromises);

        // Post-await generation check — covers cancel / chat-change during the wait.
        if (checkGenerationId && capturedGenId !== activeGenerationId) {
            console.log(`[ComfyInject] Generation changed (${capturedGenId} → ${activeGenerationId}), cleaning up placeholders for message ${index}`);

            // Replace any placeholder spans that were never resolved (their jobs were
            // dropped by the cancellation check in handleJobResult).
            // We update in-memory only — no saveChat — so the original [[IMG:...]] markers
            // remain on disk and the user can retry by reloading or regenerating.
            const cancelledMessage = context.chat[index];
            if (cancelledMessage && cancelledMessage.send_date === originalSendDate) {
                const cleaned = cancelledMessage.mes.replace(
                    /<span[^>]*comfyinject-pending[^>]*>[^<]*<\/span>/g,
                    `<span class="comfyinject-error">[Image generation cancelled]</span>`
                );
                if (cleaned !== cancelledMessage.mes) {
                    cancelledMessage.mes = cleaned;

                    // Same edit in the rendered message, in place.
                    getMesText(index)
                        ?.querySelectorAll(".comfyinject-pending, .custom-comfyinject-pending")
                        .forEach(node => node.replaceWith(createErrorElement("[Image generation cancelled]")));
                }
            }

            return { repairedCount: 0, totalCount: markerCount };
        }

        // Message integrity check — covers deletion or swipe during the wait.
        const currentMessage = context.chat[index];
        if (!currentMessage || currentMessage.send_date !== originalSendDate) {
            console.warn("[ComfyInject] Message removed or replaced during generation, discarding save:", {
                messageIndex: index, originalSendDate,
            });
            return { repairedCount: 0, totalCount: markerCount };
        }

        // Add retry buttons now that all images are in the DOM.
        addRetryButtons(index);

        // Persist metadata keyed by send_date (only successful results).
        if (!context.chatMetadata[MODULE_NAME]) {
            context.chatMetadata[MODULE_NAME] = {};
        }
        const metadataArray = results
            .filter(r => r?.status === "ok")
            .map(r => ({
                seed: r.seed, ar: r.ar, shot: r.shot,
                promptId: r.promptId, filename: r.filename,
                effectiveAr: r.effectiveAr, effectiveShot: r.effectiveShot,
                resolution: r.resolution, shotTags: r.shotTags,
                repairMeta: r.repairMeta,
            }));

        context.chatMetadata[MODULE_NAME][currentMessage.send_date] = metadataArray;
        await context.saveMetadata();
        await context.saveChat();

        if (!suppressRepairNotifications) {
            maybeShowGroupedRepairToast(repairedCount, markerCount);
            maybeLogGroupedRepairWarning(index, repairedCount, markerCount);
        }

        const successCount = results.filter(r => r?.status === "ok").length;
        console.log(`[ComfyInject] Message ${index} saved with ${successCount} injected image(s)`);

        return { repairedCount, totalCount: markerCount };
    } finally {
        processingMessages.delete(index);
    }
}

/**
 * Scans all existing messages in the current chat and processes
 * any that still have an unprocessed [[IMG: ... ]] marker.
 * Called on APP_READY and CHAT_CHANGED.
 */
async function scanExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;

    console.log(`[ComfyInject] Scanning ${context.chat.length} existing messages`);

    let repairedMessages = 0;
    let repairedMarkers = 0;

    for (let i = 0; i < context.chat.length; i++) {
        const message = context.chat[i];
        if (!message.is_user && hasImageMarker(message.mes)) {
            const summary = await processMessage(i, { suppressRepairNotifications: true });

            if (summary?.repairedCount > 0) {
                repairedMessages++;
                repairedMarkers += summary.repairedCount;
            }
        }
    }

    maybeShowBulkRepairSummaryToast(repairedMessages, repairedMarkers);
    maybeLogBulkRepairSummaryWarning(repairedMessages, repairedMarkers);

    // Add retry buttons to all already-rendered images (including ones from previous sessions)
    addAllRetryButtons();
}

/**
 * Retries image generation for a specific image within a message with a new random seed.
 * Uses send_date to look up metadata (stable across deletions).
 * @param {string} sendDate - The send_date of the message to retry
 * @param {number} imgIndex - Which image within the message to retry (0-based)
 * @param {HTMLElement|null} retryBtn - The clicked retry button, if available
 */
async function retryImage(sendDate, imgIndex, retryBtn = null) {
    const context = SillyTavern.getContext();
    const { updateMessageBlock } = SillyTavern.getContext();

    if (!context.chatMetadata[MODULE_NAME]) {
        context.chatMetadata[MODULE_NAME] = {};
    }
    const metadata = context.chatMetadata[MODULE_NAME];

    // Find the current array index for this message
    const messageIndex = findIndexBySendDate(sendDate);
    if (messageIndex === -1) {
        console.warn("[ComfyInject] Retry skipped: message not found", { sendDate, imgIndex });
        return;
    }

    const message = context.chat[messageIndex];
    if (!message) {
        console.warn("[ComfyInject] Retry skipped: message missing", { messageIndex, imgIndex });
        return;
    }

    // Parse prompt from the img tag in mes (source of truth, not stored in metadata)
    const imgTags = [...message.mes.matchAll(/<img class="comfyinject-image"[^>]*>/g)];
    const targetTag = imgTags[imgIndex];
    if (!targetTag) {
        console.warn("[ComfyInject] Retry skipped: image tag not found", {
            messageIndex,
            imgIndex,
            imageCount: imgTags.length,
        });
        return;
    }

    const prompt = targetTag[0].match(/data-prompt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') || "";
    if (!prompt) {
        console.warn("[ComfyInject] Retry skipped: image prompt missing", { messageIndex, imgIndex });
        return;
    }

    // Look up metadata for supplementary fields (ar, shot)
    const images = getImageData(metadata, sendDate).length > 0
        ? getImageData(metadata, sendDate)
        : getImageData(metadata, messageIndex);
    const imageData = images[imgIndex] || {};

    const { ar, shot } = imageData;

    // Fall back to the same marker-level defaults used by the parser
    // if metadata is missing or incomplete.
    const retryAr = ar || "SQUARE";
    const retryShot = shot || "MEDIUM";

    // Generate a new random seed using the shared project-wide max safe integer range.
    const newSeed = Math.floor(Math.random() * 9007199254740991);

    // Show generating state on the retry button
    if (retryBtn) {
        retryBtn.innerHTML = `<i class="fa-solid fa-fw fa-spinner fa-spin"></i>`;
        retryBtn.style.pointerEvents = "none";
    }

    let result;
    try {
        result = await generateImage({
            prompt,
            ar: retryAr,
            shot: retryShot,
            seed: newSeed,
            messageIndex,
            bypassSeedLock: true,
        });
    } catch (err) {
        console.error(`[ComfyInject] Retry failed for message ${messageIndex} image ${imgIndex}:`, err);
        toastr.error("Image retry failed.", "ComfyInject");
        // Restore retry button
        if (retryBtn) {
            retryBtn.innerHTML = `<i class="fa-solid fa-fw fa-rotate"></i>`;
            retryBtn.style.pointerEvents = "auto";
        }
        return;
    }

    const { imageUrl, seed: effectiveSeed, promptId, filename, effectiveAr, effectiveShot, resolution, shotTags } = result;

    // Save the seed that was actually used so LOCK works
    saveLastSeed(effectiveSeed);

    // Update metadata — try send_date key first, fall back to index for legacy.
    // Guard against missing or malformed entries so retry does not recreate bad metadata.
    const metaKey = metadata[sendDate] ? sendDate : (metadata[messageIndex] ? messageIndex : sendDate);
    let metaEntry = metadata[metaKey];

    if (!metaEntry) {
        metaEntry = [];
        metadata[metaKey] = metaEntry;
    }

    if (Array.isArray(metaEntry)) {
        const existingEntry = metaEntry[imgIndex] && typeof metaEntry[imgIndex] === "object"
            ? metaEntry[imgIndex]
            : {};

        metaEntry[imgIndex] = {
            ...existingEntry,
            seed: effectiveSeed,
            ar: existingEntry.ar || retryAr,
            shot: existingEntry.shot || retryShot,
            promptId,
            filename,
            effectiveAr,
            effectiveShot,
            resolution,
            shotTags,
            repairMeta: existingEntry.repairMeta || null,
        };
    } else if (metaEntry && typeof metaEntry === "object") {
        metadata[metaKey] = {
            ...metaEntry,
            seed: effectiveSeed,
            ar: metaEntry.ar || retryAr,
            shot: metaEntry.shot || retryShot,
            promptId,
            filename,
            effectiveAr,
            effectiveShot,
            resolution,
            shotTags,
            repairMeta: metaEntry.repairMeta || null,
        };
    }

    // Replace the Nth img tag in mes (where N = imgIndex)
    const newImgTag = buildImgTag(imageUrl, prompt, effectiveSeed);
    let count = 0;
    message.mes = message.mes.replace(/<img class="comfyinject-image"[^>]*>/g, (match) => {
        if (count === imgIndex) {
            count++;
            return newImgTag;
        }
        count++;
        return match;
    });

    // Swap the rendered <img> in place rather than re-rendering the message.
    // updateMessageBlock() rebuilds all of .mes_text, which throws away DOM-only
    // work from other extensions — LittleWhiteBox replaces HTML code blocks with
    // sandboxed iframes, and the message would fall back to showing the raw HTML
    // as a code block until something else re-rendered it.
    const messageNode = document.querySelector(`[mesid="${messageIndex}"]`);
    const renderedImages = messageNode?.querySelectorAll(".comfyinject-image, .custom-comfyinject-image") ?? [];
    const renderedImage = renderedImages[imgIndex];

    if (renderedImage) {
        renderedImage.src = imageUrl;
        renderedImage.dataset.seed = String(effectiveSeed);
        renderedImage.dataset.prompt = prompt;

        // The button survives the in-place update, so clear its spinner here.
        if (retryBtn) {
            retryBtn.innerHTML = `<i class="fa-solid fa-fw fa-rotate"></i>`;
            retryBtn.style.pointerEvents = "auto";
        }
    } else {
        // Image isn't in the DOM (message not rendered, or outside the rendered
        // window), so fall back to a full re-render to keep mes and DOM in sync.
        try {
            updateMessageBlock(messageIndex, message);
        } catch (e) {
            // ST's reasoning handler may crash on some messages, that's okay
        }

        // Re-add retry buttons since updateMessageBlock wipes the DOM
        addRetryButtons(messageIndex);
    }

    // Persist
    await context.saveMetadata();
    await context.saveChat();
}

/**
 * Rewrites one image's prompt with the LLM following the user's own preset
 * rules, then regenerates the image with it.
 *
 * AR, SHOT and seed are kept, so the only thing that changes is how the image is
 * described.  The rewritten prompt replaces data-prompt in the message, which
 * means later retries and the model's next-turn context (via the outbound
 * interceptor) use it too.
 * @param {string} sendDate - The send_date of the message holding the image
 * @param {number} imgIndex - Which image within the message (0-based)
 * @param {HTMLElement|null} rewriteBtn - The clicked button, if available
 */
async function rewriteImagePrompt(sendDate, imgIndex, rewriteBtn = null) {
    const context = SillyTavern.getContext();
    const { updateMessageBlock } = SillyTavern.getContext();

    if (activeRewrite) {
        toastr.info("A prompt rewrite is already running.", "ComfyInject");
        return;
    }

    if (generationInFlight || processingMessages.size > 0) {
        toastr.warning("Wait for the current generation to finish first.", "ComfyInject");
        return;
    }

    const messageIndex = findIndexBySendDate(sendDate);
    const message = messageIndex === -1 ? null : context.chat[messageIndex];
    if (!message) {
        console.warn("[ComfyInject] Rewrite skipped: message not found", { sendDate, imgIndex });
        return;
    }

    // The prompt lives in the img tag in mes — metadata never stores it
    const imgTags = [...message.mes.matchAll(/<img class="comfyinject-image"[^>]*>/g)];
    const previousTag = imgTags[imgIndex]?.[0];
    if (!previousTag) {
        console.warn("[ComfyInject] Rewrite skipped: image tag not found", { messageIndex, imgIndex, imageCount: imgTags.length });
        return;
    }

    const prompt = previousTag.match(/data-prompt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') || "";
    if (!prompt) {
        console.warn("[ComfyInject] Rewrite skipped: image prompt missing", { messageIndex, imgIndex });
        return;
    }

    const storedSeed = parseInt(previousTag.match(/data-seed="([^"]*)"/)?.[1] ?? "", 10);
    const seed = Number.isFinite(storedSeed) ? storedSeed : Math.floor(Math.random() * 9007199254740991);

    // Supplementary fields come from metadata, using the same lookup as retry
    if (!context.chatMetadata[MODULE_NAME]) {
        context.chatMetadata[MODULE_NAME] = {};
    }
    const metadata = context.chatMetadata[MODULE_NAME];
    const images = getImageData(metadata, sendDate).length > 0
        ? getImageData(metadata, sendDate)
        : getImageData(metadata, messageIndex);
    const imageData = images[imgIndex] || {};
    const previousMetaEntry = structuredClone(imageData);

    const ar = imageData.ar || "SQUARE";
    const shot = imageData.shot || "MEDIUM";

    // Every image in the message, so the model can keep the framing varied and
    // the character consistent across markers
    const siblings = imgTags.map(([tag], index) => ({
        prompt: tag.match(/data-prompt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') || "",
        ar: images[index]?.ar || "SQUARE",
        shot: images[index]?.shot || "MEDIUM",
    }));

    // Both buttons on this image go busy for the whole run: a seed re-roll would
    // race the rewrite for the same picture.
    const setBusy = (busy) => {
        const buttons = rewriteBtn?.parentElement?.querySelectorAll(".comfyinject-retry, .comfyinject-rewrite") ?? [];

        buttons.forEach(button => {
            button.style.pointerEvents = busy ? "none" : "auto";
            button.style.opacity = busy ? "0.6" : "1";
        });

        if (rewriteBtn) {
            rewriteBtn.innerHTML = busy
                ? `<i class="fa-solid fa-fw fa-spinner fa-spin"></i>`
                : `<i class="fa-solid fa-fw fa-wand-magic-sparkles"></i>`;
        }
    };

    activeRewrite = { sendDate, imgIndex };
    setBusy(true);

    try {
        let rewritten;
        try {
            const response = await rewritePromptWithLlm({
                prompt,
                ar,
                shot,
                mes: message.mes,
                imgIndex,
                siblings,
            });

            console.log("[ComfyInject] Rewrite rules source:", response.rulesSource);
            rewritten = response.rewritten;
        } catch (error) {
            console.error("[ComfyInject] Prompt rewrite request failed:", error);

            // generateRaw aborts when the user hits stop — that is not a failure
            if (/cancel|abort|stop event/i.test(String(error?.message ?? ""))) {
                toastr.warning("Prompt rewrite cancelled.", "ComfyInject");
            } else {
                toastr.error(`Prompt rewrite failed: ${error?.message || error}`, "ComfyInject");
            }
            return;
        }

        if (!rewritten) {
            toastr.error("The model did not return a usable prompt — keeping the original.", "ComfyInject");
            return;
        }

        if (rewritten === prompt) {
            toastr.info("The model returned the same prompt — no image was generated.", "ComfyInject");
            return;
        }

        // The LLM call can take a minute, so re-check that the message still
        // holds the image we are about to replace
        const currentIndex = findIndexBySendDate(sendDate);
        const currentMessage = currentIndex === -1 ? null : context.chat[currentIndex];
        const currentTag = currentMessage
            ? [...currentMessage.mes.matchAll(/<img class="comfyinject-image"[^>]*>/g)][imgIndex]?.[0]
            : null;

        if (!currentMessage || currentTag !== previousTag || generationInFlight) {
            toastr.warning("The message changed while rewriting — nothing was applied.", "ComfyInject");
            return;
        }

        let result;
        try {
            result = await generateImage({
                prompt: rewritten,
                ar,
                shot,
                seed,
                messageIndex: currentIndex,
                bypassSeedLock: true,
            });
        } catch (error) {
            console.error(`[ComfyInject] Rewrite image generation failed for message ${currentIndex} image ${imgIndex}:`, error);
            toastr.error("Image regeneration failed — the prompt was left unchanged.", "ComfyInject");
            return;
        }

        const { imageUrl, seed: effectiveSeed, promptId, filename, effectiveAr, effectiveShot, resolution, shotTags } = result;

        // Save the seed that was actually used so LOCK works
        saveLastSeed(effectiveSeed);

        // Update metadata, same key fallback retryImage uses
        const metaKey = metadata[sendDate] ? sendDate : (metadata[currentIndex] ? currentIndex : sendDate);
        let metaEntry = metadata[metaKey];

        if (!metaEntry) {
            metaEntry = [];
            metadata[metaKey] = metaEntry;
        }

        if (Array.isArray(metaEntry)) {
            const existingEntry = metaEntry[imgIndex] && typeof metaEntry[imgIndex] === "object"
                ? metaEntry[imgIndex]
                : {};

            metaEntry[imgIndex] = {
                ...existingEntry,
                seed: effectiveSeed,
                ar: existingEntry.ar || ar,
                shot: existingEntry.shot || shot,
                promptId,
                filename,
                effectiveAr,
                effectiveShot,
                resolution,
                shotTags,
                repairMeta: existingEntry.repairMeta || null,
            };
        } else if (metaEntry && typeof metaEntry === "object") {
            metadata[metaKey] = {
                ...metaEntry,
                seed: effectiveSeed,
                ar: metaEntry.ar || ar,
                shot: metaEntry.shot || shot,
                promptId,
                filename,
                effectiveAr,
                effectiveShot,
                resolution,
                shotTags,
                repairMeta: metaEntry.repairMeta || null,
            };
        }

        // Store the rewritten prompt on the image it was written for
        const newImgTag = buildImgTag(imageUrl, rewritten, effectiveSeed);
        let count = 0;
        currentMessage.mes = currentMessage.mes.replace(/<img class="comfyinject-image"[^>]*>/g, (match) => {
            if (count === imgIndex) {
                count++;
                return newImgTag;
            }
            count++;
            return match;
        });

        // Swap the rendered image in place, the same way retry does
        const renderedImage = document.querySelector(`[mesid="${currentIndex}"]`)
            ?.querySelectorAll(".comfyinject-image, .custom-comfyinject-image")?.[imgIndex];

        if (renderedImage) {
            renderedImage.src = imageUrl;
            renderedImage.dataset.seed = String(effectiveSeed);
            renderedImage.dataset.prompt = rewritten;
        } else {
            try {
                updateMessageBlock(currentIndex, currentMessage);
            } catch (e) {
                // ST's reasoning handler may crash on some messages, that's okay
            }

            addRetryButtons(currentIndex);
        }

        await context.saveMetadata();
        await context.saveChat();

        toastr.info("Prompt rewritten and image regenerated. Click to undo.", "ComfyInject", {
            timeOut: 15000,
            extendedTimeOut: 4000,
            closeButton: true,
            onclick: () => undoRewrite(sendDate, imgIndex, previousTag, previousMetaEntry),
        });
    } finally {
        activeRewrite = null;
        setBusy(false);
    }
}

/**
 * Puts back the image tag and metadata entry that a rewrite replaced.
 *
 * The whole tag is restored — image, prompt and seed — because the picture on
 * screen was generated from the rewritten prompt; restoring only the text would
 * leave the stored prompt and the visible image disagreeing.
 * @param {string} sendDate - The send_date of the message
 * @param {number} imgIndex - Which image within the message (0-based)
 * @param {string} previousTag - The img tag as it was before the rewrite
 * @param {object} previousMetaEntry - The metadata entry as it was before the rewrite
 */
async function undoRewrite(sendDate, imgIndex, previousTag, previousMetaEntry) {
    const context = SillyTavern.getContext();
    const { updateMessageBlock } = SillyTavern.getContext();

    const messageIndex = findIndexBySendDate(sendDate);
    const message = messageIndex === -1 ? null : context.chat[messageIndex];
    const imgTags = message ? [...message.mes.matchAll(/<img class="comfyinject-image"[^>]*>/g)] : [];

    if (!imgTags[imgIndex]) {
        toastr.warning("That image is no longer available to undo.", "ComfyInject");
        return;
    }

    let count = 0;
    message.mes = message.mes.replace(/<img class="comfyinject-image"[^>]*>/g, (match) => {
        if (count === imgIndex) {
            count++;
            return previousTag;
        }
        count++;
        return match;
    });

    const metadata = context.chatMetadata[MODULE_NAME];
    const metaKey = metadata?.[sendDate] ? sendDate : (metadata?.[messageIndex] ? messageIndex : sendDate);
    if (Array.isArray(metadata?.[metaKey]) && Object.keys(previousMetaEntry ?? {}).length > 0) {
        metadata[metaKey][imgIndex] = previousMetaEntry;
    }

    const renderedImage = document.querySelector(`[mesid="${messageIndex}"]`)
        ?.querySelectorAll(".comfyinject-image, .custom-comfyinject-image")?.[imgIndex];

    if (renderedImage) {
        renderedImage.src = previousTag.match(/src="([^"]*)"/)?.[1] ?? "";
        renderedImage.dataset.prompt = previousTag.match(/data-prompt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') ?? "";
        renderedImage.dataset.seed = previousTag.match(/data-seed="([^"]*)"/)?.[1] ?? "";
    } else {
        try {
            updateMessageBlock(messageIndex, message);
        } catch (e) {
            // ST's reasoning handler may crash on some messages, that's okay
        }

        addRetryButtons(messageIndex);
    }

    await context.saveMetadata();
    await context.saveChat();

    toastr.success("Restored the previous prompt and image.", "ComfyInject");
}

/**
 * Registers all SillyTavern event listeners.
 * Called once from index.js on load.
 */
export function initDom() {
    const { eventSource, event_types } = SillyTavern.getContext();

    // Start watching streamed text as soon as a visible generation begins.
    eventSource.on(event_types.GENERATION_STARTED, (type, _params, isDryRun) => {
        if (type === "quiet" || isDryRun) {
            clearLiveStream();
            return;
        }

        // New generation supersedes any in-progress results from a previous one.
        generationInFlight = true;
        bumpGenerationId();
        resetLiveStream();
    });

    // ST emits the current streamed text frequently. Keep this handler cheap;
    // the timer started in resetLiveStream() does marker scanning.
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (text) => {
        updateStreamText(text);
    });

    eventSource.on(event_types.GENERATION_ENDED, () => {
        generationInFlight = false;
        stopLiveStreamScanner();
    });

    // User cancelled — discard all in-progress jobs and live stream state.
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        generationInFlight = false;
        bumpGenerationId();
        clearLiveStream();
    });

    // Process new bot messages as they are rendered.
    // checkGenerationId: true so cancellation/retry/new-generation discards results.
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (index) => {
        await processMessage(index, { checkGenerationId: true });
    });

    // Re-scan when chat changes — clear everything first so no stale jobs survive.
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        bumpGenerationId();
        clearLiveStream();
        await scanExistingMessages();
    });

    // Re-add retry buttons after swipes and edits since ST re-renders the message DOM
    const reAddRetryButtons = (index) => setTimeout(() => addRetryButtons(index), 100);
    eventSource.on(event_types.MESSAGE_SWIPED, reAddRetryButtons);
    eventSource.on(event_types.MESSAGE_UPDATED, reAddRetryButtons);
    eventSource.on(event_types.MESSAGE_EDITED, reAddRetryButtons);

    console.log("[ComfyInject] DOM listener initialized");
}

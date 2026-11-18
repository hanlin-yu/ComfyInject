// Tests for the pure helpers behind the "rewrite the prompt with AI" feature.
//
//   node --test test/rewriteRules.test.mjs
//
// rewriteRules.js deliberately imports nothing from SillyTavern, so it runs
// as-is in node.  The ST-facing halves (rewrite.js, dom.js) cannot be imported
// here — they touch SillyTavern/document at call time.

import test from "node:test";
import assert from "node:assert/strict";

import {
    IMG_TAG_REGEX,
    buildRewriteMessages,
    decodeHtmlEntities,
    extractNarrativeWindow,
    findImageTagOffsets,
    neutralizeMacros,
    parseImgTag,
    sanitizeRewrittenPrompt,
} from "../src/rewriteRules.js";

const LONG_PROMPT = "safe, 1girl, solo, long silver hair, purple eyes, blue hair ribbon, serafuku, white shirt, sitting, reading, library, window light";
const VSS = "An eye-level medium shot framing one girl reading at a desk, soft window light falling across the page.";

const imgTag = (i) => `<img class="comfyinject-image" src="http://comfy/view?filename=${i}.png" data-prompt="prompt ${i}" data-seed="${i}" />`;

test("parseImgTag reads prompt and seed, decoding escaped quotes", () => {
    const tag = `<img class="comfyinject-image" src="x" data-prompt="a &quot;quoted&quot; cat" data-seed="42" />`;
    assert.deepEqual(parseImgTag(tag), { prompt: 'a "quoted" cat', seed: "42" });
});

test("findImageTagOffsets returns every tag in order", () => {
    const mes = `before ${imgTag(1)} middle ${imgTag(2)} after`;
    const offsets = findImageTagOffsets(mes);

    assert.equal(offsets.length, 2);
    assert.equal(mes.slice(offsets[0].start, offsets[0].end), imgTag(1));
    assert.equal(mes.slice(offsets[1].start, offsets[1].end), imgTag(2));
    assert.ok(offsets[0].end < offsets[1].start);
});

test("decodeHtmlEntities handles the entities ST stores", () => {
    assert.equal(decodeHtmlEntities("&quot;a&quot; &amp; &lt;b&gt; &#39;c&#39;&nbsp;end"), `"a" & <b> 'c' end`);
});

test("extractNarrativeWindow centres on the target image and hides markup", () => {
    const mes = `First scene prose. ${imgTag(1)} Second scene prose here. ${imgTag(2)} Third scene prose. ${imgTag(3)}`;
    const window = extractNarrativeWindow(mes, 1, 30);

    assert.match(window, /\[image\]/);
    assert.match(window, /Second scene prose/);
    assert.doesNotMatch(window, /data-prompt/);
    assert.doesNotMatch(window, /<img/);
});

test("extractNarrativeWindow falls back to the whole message without a target", () => {
    assert.equal(extractNarrativeWindow("just prose", 3, 20), "just prose");
});

test("neutralizeMacros breaks macro syntax without touching the text", () => {
    assert.equal(neutralizeMacros("a {{getvar::x}} b"), "a { {getvar::x} } b");
    assert.equal(neutralizeMacros("plain text"), "plain text");
});

test("sanitizeRewrittenPrompt keeps a clean prompt as-is", () => {
    assert.equal(sanitizeRewrittenPrompt(LONG_PROMPT), LONG_PROMPT);
    assert.equal(sanitizeRewrittenPrompt(`  ${LONG_PROMPT}\n\n${VSS}  `), `${LONG_PROMPT}\n\n${VSS}`);
});

test("sanitizeRewrittenPrompt unwraps a marker the model echoed back", () => {
    const raw = `[[IMG: ${LONG_PROMPT} | SQUARE | MEDIUM | 123 ]]`;
    assert.equal(sanitizeRewrittenPrompt(raw), LONG_PROMPT);
});

test("sanitizeRewrittenPrompt cuts everything after a pipe", () => {
    assert.equal(sanitizeRewrittenPrompt(`${LONG_PROMPT} | SQUARE`), LONG_PROMPT);
    assert.equal(sanitizeRewrittenPrompt(`${LONG_PROMPT}\n| SHOT: MEDIUM`), LONG_PROMPT);
});

test("sanitizeRewrittenPrompt strips fences, labels, quotes and reasoning", () => {
    assert.equal(sanitizeRewrittenPrompt(`\`\`\`\n${LONG_PROMPT}\n\`\`\``), LONG_PROMPT);
    assert.equal(sanitizeRewrittenPrompt(`PROMPT: ${LONG_PROMPT}`), LONG_PROMPT);
    assert.equal(sanitizeRewrittenPrompt(`"${LONG_PROMPT}"`), LONG_PROMPT);
    assert.equal(sanitizeRewrittenPrompt(`<thinking>\nmaybe this\n</thinking>\n${LONG_PROMPT}`), LONG_PROMPT);
});

test("sanitizeRewrittenPrompt removes angle brackets that would truncate the img tag", () => {
    assert.equal(sanitizeRewrittenPrompt(`${LONG_PROMPT}, <lora:style>`), `${LONG_PROMPT}, lora:style`);
    assert.equal(sanitizeRewrittenPrompt(`${LONG_PROMPT} > ${VSS}`).includes(">"), false);
});

test("sanitizeRewrittenPrompt rejects unusable responses", () => {
    assert.equal(sanitizeRewrittenPrompt(""), null);
    assert.equal(sanitizeRewrittenPrompt("   \n  "), null);
    assert.equal(sanitizeRewrittenPrompt("safe, 1girl, solo"), null, "too short to be a real prompt");
    assert.equal(sanitizeRewrittenPrompt("A".repeat(80)), null, "no lowercase tag text");
    assert.equal(sanitizeRewrittenPrompt(null), null);
    assert.equal(sanitizeRewrittenPrompt(undefined), null);
    assert.equal(sanitizeRewrittenPrompt(42), null);
});

test("buildRewriteMessages puts the rules in the system prompt verbatim", () => {
    const rulesText = "TAG RULES\n- lowercase only\n- safety tier first";
    const { systemPrompt, prompt } = buildRewriteMessages({
        rulesText,
        prompt: LONG_PROMPT,
        ar: "SQUARE",
        shot: "MEDIUM",
        cardText: "A student who lives in the library.",
        excerpt: "She turned the page slowly.",
        siblings: [{ prompt: LONG_PROMPT, ar: "SQUARE", shot: "MEDIUM" }],
        targetIndex: 0,
    });

    assert.match(systemPrompt, /=== SPECIFICATION ===/);
    assert.ok(systemPrompt.includes(rulesText), "rules appear verbatim");
    assert.match(systemPrompt, /No pipes/);
    assert.doesNotMatch(systemPrompt, /CLOSE shot:/, "no CLOSE line for a MEDIUM target");

    assert.match(prompt, /TARGET MARKER/);
    assert.match(prompt, /SHOT: MEDIUM/);
    assert.ok(prompt.includes("A student who lives in the library."));
    assert.ok(prompt.includes("She turned the page slowly."));
    assert.match(prompt, /<- TARGET/);
});

test("buildRewriteMessages adds the CLOSE guidance only for CLOSE targets", () => {
    const build = (shot) => buildRewriteMessages({
        rulesText: "rules",
        prompt: LONG_PROMPT,
        ar: "SQUARE",
        shot,
        cardText: "",
        excerpt: "",
        siblings: [],
        targetIndex: 0,
    });

    assert.match(build("CLOSE").systemPrompt, /exactly ONE local part/);
    assert.doesNotMatch(build("WIDE").systemPrompt, /exactly ONE local part/);
    assert.match(build("CLOSE").prompt, /\(not available\)/, "empty card and excerpt are labelled");
});

test("buildRewriteMessages truncates sibling prompts and marks the target", () => {
    const long = "x".repeat(500);
    const { prompt } = buildRewriteMessages({
        rulesText: "rules",
        prompt: LONG_PROMPT,
        ar: "SQUARE",
        shot: "MEDIUM",
        cardText: "",
        excerpt: "",
        siblings: [
            { prompt: long, ar: "PORTRAIT", shot: "CLOSE" },
            { prompt: "target prompt", ar: "SQUARE", shot: "MEDIUM" },
        ],
        targetIndex: 1,
        siblingPromptLimit: 40,
    });

    assert.match(prompt, /1\. \[PORTRAIT \/ CLOSE\] x{40}…/);
    assert.match(prompt, /2\. \[SQUARE \/ MEDIUM\] target prompt {2}<- TARGET/);
});

test("IMG_TAG_REGEX matches only injected image tags", () => {
    const matches = `a ${imgTag(1)} b <img class="other" src="x" />`.match(IMG_TAG_REGEX);
    assert.equal(matches.length, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    fillerRetention,
    processTranscript,
    wordErrorRate,
} from "../src/shared/TranscriptProcessor";
import { validateVad, DEFAULT_VAD } from "../src/shared/voice";

test("original output is untouched and fillers are lexical, bounded words", () => {
    const raw = " Um, I like the umbrella, uh, and right now I am ready. ";
    const result = processTranscript(raw);
    assert.equal(result.raw, raw);
    assert.deepEqual(result.fillers, [
        { word: "um", count: 1 },
        { word: "uh", count: 1 },
    ]);
    assert.equal(
        result.cleaned,
        "I like the umbrella, and right now I am ready.",
    );
});
test("WER measures substitutions, insertions and deletions, normalized case/punctuation", () => {
    assert.equal(wordErrorRate("Hello, WORLD!", "hello world"), 0);
    assert.equal(wordErrorRate("a b c", "a x c"), 1 / 3);
    assert.equal(wordErrorRate("a b", "a b c"), 0.5);
    assert.equal(wordErrorRate("a b", "a"), 0.5);
    assert.equal(wordErrorRate("a", "a b c"), 2);
    assert.equal(wordErrorRate("", "anything"), null);
});
test("filler retention counts repeated occurrences and cannot exceed 100%", () => {
    assert.equal(fillerRetention("um um uh words", "um words"), 1 / 3);
    assert.equal(fillerRetention("um words", "um um um words"), 1);
    assert.equal(fillerRetention("words", "uh words"), null);
});
test("VAD settings reject missing values, NaN, infinities and out-of-range values", () => {
    validateVad(DEFAULT_VAD);
    for (const threshold of [NaN, Infinity, -0.1, 1.1]) {
        assert.throws(() => validateVad({ ...DEFAULT_VAD, threshold }));
    }
    assert.throws(() => validateVad({} as typeof DEFAULT_VAD));
});

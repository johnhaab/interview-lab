import type { Filler } from "./voice";

const fillerPattern = /\b(?:um+|uh+|erm+|er|hmm+|mm-hmm)\b/gi;

interface ProcessedTranscript {
    raw: string;
    cleaned: string;
    fillers: Filler[];
}

export function processTranscript(raw: string): ProcessedTranscript {
    const counts = new Map<string, number>();
    for (const match of raw.matchAll(fillerPattern)) {
        const word = match[0].toLowerCase();
        counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const cleaned = raw
        .replace(fillerPattern, "")
        .replace(/\s+([,.!?;:])/g, "$1")
        .replace(/([,.!?;:])(?:\s*[,;:])+/g, "$1")
        .replace(/^[\s,;:]+/, "")
        .replace(/\s+/g, " ")
        .trim();
    const fillers = [...counts].map(([word, count]) => ({ word, count }));
    return { raw, cleaned, fillers };
}

export function words(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

export function wordErrorRate(
    reference: string,
    hypothesis: string,
): number | null {
    const referenceWords = words(reference);
    const hypothesisWords = words(hypothesis);
    if (referenceWords.length === 0) {
        return null;
    }

    let previous = Array.from(
        { length: hypothesisWords.length + 1 },
        (_, index) => index,
    );
    for (
        let referenceIndex = 1;
        referenceIndex <= referenceWords.length;
        referenceIndex++
    ) {
        const current = [referenceIndex];
        for (
            let hypothesisIndex = 1;
            hypothesisIndex <= hypothesisWords.length;
            hypothesisIndex++
        ) {
            current[hypothesisIndex] = Math.min(
                current[hypothesisIndex - 1] + 1,
                previous[hypothesisIndex] + 1,
                previous[hypothesisIndex - 1] +
                    Number(
                        referenceWords[referenceIndex - 1] !==
                            hypothesisWords[hypothesisIndex - 1],
                    ),
            );
        }
        previous = current;
    }
    return previous[hypothesisWords.length] / referenceWords.length;
}

export function fillerRetention(
    reference: string,
    hypothesis: string,
): number | null {
    const expected = processTranscript(reference).fillers;
    const actual = new Map(
        processTranscript(hypothesis).fillers.map((filler) => [
            filler.word,
            filler.count,
        ]),
    );
    const total = expected.reduce((count, filler) => count + filler.count, 0);
    if (total === 0) {
        return null;
    }

    const retained = expected.reduce((count, filler) => {
        return count + Math.min(filler.count, actual.get(filler.word) ?? 0);
    }, 0);
    return retained / total;
}

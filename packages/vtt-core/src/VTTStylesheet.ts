/**
 * A WebVTT STYLE block.
 *
 * The raw contents of the STYLE block are retained verbatim as CSS text and
 * exposed read-only. The `cssRules` accessor provides a lightweight,
 * environment independent view of the rule list so consumers do not need a
 * CSSOM implementation (e.g. in Node) to inspect the stylesheet.
 */
export default class VTTStylesheet {
    readonly #cssText: string;

    constructor(cssText: string) {
        this.#cssText = cssText;
    }

    /** The raw CSS text of the STYLE block. Read-only. */
    get cssText() {
        return this.#cssText;
    }

    /**
     * A read-only list of the CSS rules contained in the STYLE block.
     *
     * Each rule is returned as its raw text (selector list plus declaration
     * block). CSS comments and at-rules that do not contain blocks are ignored.
     * Parsing is performed lazily and never mutates `cssText`.
     */
    get cssRules(): readonly string[] {
        // Pass 1: remove CSS comments, preserving the rest of the text.
        const text = this.#cssText;
        let stripped = "";
        let inComment = false;
        for (let i = 0; i < text.length; i++) {
            if (!inComment && text[i] === "/" && text[i + 1] === "*") {
                inComment = true;
                i++;
                continue;
            }
            if (inComment) {
                if (text[i] === "*" && text[i + 1] === "/") {
                    inComment = false;
                    i++;
                }
                continue;
            }
            stripped += text[i];
        }

        // Pass 2: split on balanced top-level declaration blocks.
        const rules: string[] = [];
        let depth = 0;
        let blockStart = 0;
        for (let i = 0; i < stripped.length; i++) {
            if (stripped[i] === "{") {
                depth++;
            } else if (stripped[i] === "}" && depth > 0) {
                depth--;
                if (depth === 0) {
                    const rule = stripped.slice(blockStart, i + 1).trim();
                    if (rule !== "") rules.push(rule);
                    blockStart = i + 1;
                }
            }
        }
        return Object.freeze(rules);
    }
}

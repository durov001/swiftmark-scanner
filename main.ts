// Swiftmark Scanner — driver for the markdown-render-speed-02 bounty.
//
// The harness runs `node main.ts` with the case list mounted at
// $MAKEFUN_INPUT_DIR/cases.json (a JSON array of {id, markdown}) and
// expects the rendered HTML strings, one per case and in order, as a JSON
// array at $MAKEFUN_OUTPUT_DIR/html.json. Each case is rendered alone by
// parse() from parse.js, a from-scratch single-pass scanner.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(readFileSync(join(inputDir, "cases.json"), "utf8"));
const html = new Array(cases.length);
// Render in input order; parse() is deterministic, so the two graded
// executions of this driver always produce identical output.
const render = parse;
for (let i = 0; i < cases.length; i++) html[i] = render(cases[i].markdown);

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));

# swiftmark-scanner

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/durov001/swiftmark-scanner/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/durov001/swiftmark-scanner/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A from-scratch single-pass Markdown parser that renders byte-identical HTML to marked 18.1.3 (default options) on every practice case — 720/720 — with no dependencies and no token tree. The inline scanner walks its input once, dispatching on character codes and emitting HTML directly into chunk arrays; blocks are read line by line with a small container stack. It covers the full CommonMark 0.31.2 + GFM surface: ATX and setext headings, blockquotes, nested bullet/ordered/task lists, fenced and indented code, GFM tables, HTML blocks, link reference definitions, emphasis and strong (including marked's delimiter-pool quirks), strikethrough, code spans, all link forms, images, autolinks, entities and hard breaks. `parse()` is stateless: no caching across calls, no file, clock or environment access, no lookup of case outputs.

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

The driver reads `$MAKEFUN_INPUT_DIR/cases.json` (a JSON array of `{id, markdown}`), renders each case with `parse()`, and writes the JSON array of HTML strings to `$MAKEFUN_OUTPUT_DIR/html.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zsk0hsg3&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>

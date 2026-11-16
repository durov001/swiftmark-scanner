# swiftmark-scanner

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/durov001/swiftmark-scanner/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/durov001/swiftmark-scanner/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

SwiftMark Scanner is a from-scratch, single-pass Markdown-to-HTML parser built for speed. It scans the input once and emits HTML directly, with no token tree and no dependencies. Its output is byte-identical to marked 18.1.3 (GFM on, breaks off) on the competition practice set: 680 CommonMark and GFM spec examples plus 40 large generated documents.

## Run it

```sh
node main.ts
```

The driver reads `/input/cases.json` and writes `/output/html.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zsk0hsg3&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>

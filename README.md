# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shincanx/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shincanx/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and mend reads each one as SPEC.md says, finds the lines each edit names at the first of three matching tiers (exact, trailing whitespace, leading and trailing whitespace, with re-indentation at the third tier), and writes every change or none. It handles creates, deletes, moves and changes, CRLF files and files without a final line break, `--check` dry runs, and `--strict` exact matching, and reports each failed edit instead of stopping at the first.

## Run it

```sh
node main.ts [options] [PATCH]
```

`main.ts` (Node 22, standard library only) is the whole tool; `SPEC.md` is the specification it implements. `runner.ts` and `check.ts` are the kit's trial runner and practice checker: `node check.ts ../program/generator/practice.json` runs the 100 public practice checks.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

# dsh-touchstone

> **The missing evaluation half of DeepSeek Harness's self-evolution.**
> You changed something — did it actually get better? Run the same **golden cases** against the current config and a **candidate**, score them, and get a before→after report. **Keep it if it improved; revert if it did not.**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin · MIT · works on desktop **and** web

[English](README.md) | [简体中文](README.zh-CN.md)

---

## Contents

- [What it is](#what-it-is)
- [Why you want it](#why-you-want-it)
- [Quick start (5 minutes)](#quick-start-5-minutes)
- [A worked example](#a-worked-example)
- [The four ideas](#the-four-ideas)
- [How to write checks](#how-to-write-checks)
- [What a run does](#what-a-run-does)
- [Settings and where data lives](#settings-and-where-data-lives)
- [What it does *not* do (limits)](#what-it-does-not-do-limits)
- [FAQ](#faq)
- [Development](#development)

---

## What it is

A **touchstone** for your agent. Whenever you make a change — add a house rule, swap a prompt, tweak a preset — instead of going on a hunch, it runs that change against the **same set of golden cases**, side by side with "before", and hands you a scorecard:

```
case            current   candidate   change
lead-with-answer   0%       100%      +100%
```

and closes with an **evidence-based** verdict: **✅ Better, keep it.** / **❌ Regressed, revert.** / **➖ No real difference.**

The score only speaks for *these* cases — **the final call is still yours.**

## Why you want it

DSH's whole bet is "everything is a plugin": prompts, tools, presets, even the agent loop are meant to be swapped at will. And the official account names the missing piece:

> DSH has already split the agent into locatable, replaceable components — **but it still lacks a complete learning loop: propose a change, and use Eval to judge whether that change actually worked.**

The ecosystem already has **undo / rollback** (recover from a bad change) but **no evaluation** (measure before you commit). dsh-touchstone fills exactly that gap.

It is deliberately thin: it only uses the public **`ctx.llm.stream()`** seam, never patches the harness, and depends on no internal services — so it runs on both DSH 0.1.x (web) and 0.2 (desktop).

## Quick start (5 minutes)

1. **Install** (pick a profile):
   ```shell
   dsh plugin --profile desktop add dsh-touchstone      # desktop app
   dsh plugin --profile web add dsh-touchstone          # web UI
   ```
   Restart DSH afterwards.

2. **Open it**: Settings (desktop: bottom-left **account menu → 设置**, or `Ctrl + ,`) → click **🪨 试金石** on the left.

3. **Add a case** — under "金标准用例 (golden cases)", click **+ 加一条用例**:
   - **name**: for you, e.g. "lead with the answer".
   - **prompt**: the sentence you would send to the agent, e.g. "Introduce artificial intelligence in one sentence."
   - **check**: click **+ 加一条检查项**, choose **必须包含 (must contain)**, and type the word you expect.

4. **Add a candidate** — under "候选方案", click **+ 加一个候选**:
   - **name**, e.g. "add a prefix rule".
   - **prompt**: the text you want to try, e.g. "Every answer must begin with exactly the four characters 「笔记：」."
   - **mode**: `append` (on top of current) or `replace`.

5. **Run**: click **跑一遍 (Run)** next to the candidate.

6. **Read the report** — scroll to **对账 (Report)** for per-case scores and the verdict.

> 💡 Fields **save on blur**: after typing, click elsewhere (or press Tab) and it saves automatically.

## A worked example

**You want** to add an "opening format" rule, but you don't know if the model will obey it.

| Field | Value |
|---|---|
| case · name | `opening format` |
| case · prompt | `Introduce artificial intelligence in one sentence.` |
| case · check | `must contain` → `笔记：` |
| candidate · name | `prefix marker` |
| candidate · prompt | `Every answer must begin with exactly 「笔记：」, then continue normally.` |
| candidate · mode | `append` |

Click **Run**. A few seconds later:

```
prefix marker        current 0% → candidate 100%
case             current   candidate   change
opening format      0%        100%     +100%
✅ Better, keep it.
```

**It adds evidence to the sentence you otherwise would not have**: not "I think it works", but "under the current config the instruction had no effect; under the candidate it did."

## The four ideas

| Idea | What | Note |
|---|---|---|
| **Case** | one prompt + some checks | a question you want the agent to stay solid on |
| **Check** | an assertion about the output | must contain / must not contain / regex / LLM judge |
| **Candidate (variant)** | a prompt you want to try | append or replace; the control is the built-in "current (no change)" |
| **Report** | candidate mean − baseline mean | per-case delta + overall verdict |

## How to write checks

| Kind | Decision | When to use |
|---|---|---|
| **must contain** | the output contains this text | cheapest and most reproducible; "a word / conclusion / format must appear" |
| **must not contain** | the output does **not** contain this text | prohibitions, e.g. "no 'Sorry'" |
| **regex** | the output matches | format checks, e.g. `^笔记：` |
| **LLM judge** | a second model call answers `PASS` / `FAIL` + one line | subjective criteria, e.g. "conclusion first, then reasons" |

> **Rule of thumb:** prefer rule checks over the LLM judge — rule scores are the most trustworthy and reproducible; the judge is also a model, with its own bias.
> Checks can carry a **weight** (default 1); the score is a weighted pass rate.

## What a run does

1. Take every **enabled** case × the candidates you ticked (plus the always-on control "current").
2. For each pair, build one model call — `system` = the candidate's prompt, `messages` = the case prompt — and collect text and usage via `ctx.llm.stream()`.
3. Score: rule checks **in-process**; the LLM judge makes **one more model call**.
4. Store the run and return the report.

The whole thing **only reads config and calls the model** — it never touches your files.

## Settings and where data lives

- **Which model to run** — configure `provider` / `model` / `temperature` / `maxOutput` for `dsh-touchstone` in DSH settings, plus optional **judge** model (`judgeProvider` / `judgeModel`; blank = same as the runner).
- **Data** — `$DSH_HOME/touchstone/bench.json` (`DSH_HOME` defaults to `~/.dsh`); stores cases, candidates, and the last **40 runs**.
- To reset, delete that file (it is recreated).

## What it does *not* do (limits)

- This is a **text-level** evaluation: it compares "the model's output under the same prompt", **not** a full agent loop.
  - Best for: **changing a prompt / a house rule / a preset's wording.**
  - Not for: "changing a tool's implementation" that needs real side effects — it gives no evidence there.
- **The judge is also a model** and has bias; rule checks are the most reproducible. Treat the score as evidence, not a verdict.
- The score only speaks for **your cases** — write them poorly and you measure the wrong thing.

## FAQ

**Q: How long / how expensive is a run?**
A: One model call per case × candidate (plus one more if you use an LLM judge). Few cases, short outputs → fast and cheap. Start with one or two cases.

**Q: Can I compare two candidates instead of candidate-vs-current?**
A: Each candidate is compared against "current". For candidate-vs-candidate, read the two reports side by side (same cases, same baseline).

**Q: Why did my input box garble Chinese?**
A: An early development build had this bug — the input posted on every keystroke and wrote the server value back, which fights the IME. **This version is fixed**: text edits stay local and save on blur.

**Q: Will it touch my files?**
A: No. It only reads config and calls the model.

## Development

```shell
npm install
npm run build      # src/index.ts -> lib/index.js ; src/client/index.ts -> lib/client.js
npm run typecheck
npm test           # pure-logic unit tests (run against the built bundles; no DSH needed)
```

- **Host half** (`src/index.ts`): storage + run engine + routes + settings schema.
- **Browser half** (`src/client/index.ts`): the "试金石" settings page.
- Local iteration: `node build.mjs --watch`, then refresh the page (client half reloads instantly).

---

## Authors & license

- **Author: Hwayn (幻弈)**
- **Collaborator: Yucheng Xiao (肖宇成)** — direction, requirements, testing
- License: MIT

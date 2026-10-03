/**
 * Unit tests for 试金石's pure engine pieces — run against the *built* bundles.
 *
 *   node test/touchstone.test.mjs
 *
 * The host half is plain ESM, so it imports directly. The client half is emitted as
 * `window.__ModuleLoader__.load({ id, factory })`, so we stub that loader and run the factory.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const host = await import(pathToFileURL(join(here, "..", "lib", "index.js")).href);
const { composeSystem, scoreLocal, totalOf, diff, firstLine } = host;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log("  PASS", name); }
  else { failed += 1; console.log("  FAIL", name); }
}

// 1 · composeSystem — the three modes
{
  const v = (mode, systemText) => ({ id: "x", name: "x", mode, systemText });
  check("baseline ignores the candidate text", composeSystem("base", v("baseline", "IGNORED")) === "base");
  check("append keeps the base and adds the candidate", composeSystem("base", v("append", "new")) === "base\n\nnew");
  check("append with no base is just the candidate", composeSystem("", v("append", "new")) === "new");
  check("replace drops the base", composeSystem("base", v("replace", "new")) === "new");
}

// 2 · rule scoring — the four kinds
{
  const out = "结论：可以。记得先备份。";
  const s = scoreLocal(out, [
    { id: "a", kind: "must", value: "结论" },
    { id: "b", kind: "must", value: "不存在" },
    { id: "c", kind: "mustNot", value: "禁止" },
    { id: "d", kind: "mustNot", value: "备份" },
    { id: "e", kind: "regex", value: "先\\s*备份" },
    { id: "f", kind: "regex", value: "([" },
    { id: "g", kind: "llm", value: "judge me" },
  ]);
  const by = Object.fromEntries(s.map((x) => [x.checkId, x.pass]));
  check("must hits", by.a === true);
  check("must misses", by.b === false);
  check("mustNot stays quiet when absent", by.c === true);
  check("mustNot fires when present", by.d === false);
  check("regex matches", by.e === true);
  check("a broken regex fails without throwing", by.f === false);
  check("llm checks are not graded locally", by.g === undefined);
}

// 3 · totalOf — weighted
{
  const checks = [
    { id: "a", kind: "must", value: "x", weight: 3 },
    { id: "b", kind: "must", value: "y", weight: 1 },
  ];
  const scores = [
    { checkId: "a", kind: "must", pass: true, detail: "" },
    { checkId: "b", kind: "must", pass: false, detail: "" },
  ];
  check("weighted total is 3/4", totalOf(scores, checks) === 0.75);
  check("no scores means no total", totalOf([], checks) === null);
}

// 4 · diff — better / worse / same
{
  const cases = [
    { id: "c1", name: "一" },
    { id: "c2", name: "二" },
  ];
  const run = (variantId, totals) => totals.map((t, i) => ({ caseId: `c${i + 1}`, variantId, total: t }));
  const better = diff(run("baseline", [0.5, 0.5]), run("v", [1, 0.5]), cases);
  check("improvement is (better)", better.verdict === "better" && better.rows[0].delta === 0.5);
  const worse = diff(run("baseline", [1, 1]), run("v", [0.5, 1]), cases);
  check("regression is (worse)", worse.verdict === "worse");
  const same = diff(run("baseline", [1, 0.5]), run("v", [1, 0.5]), cases);
  check("no change is (same)", same.verdict === "same");
}

// 5 · firstLine
{
  check("firstLine grabs the first non-empty line", firstLine("\n\n# 标题\n正文") === "# 标题");
  check("firstLine never returns empty", firstLine("   ") === "(untitled)");
}

// 6 · the client bundle still declares the right id and an apply()
{
  let spec = null;
  globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s; } } };
  globalThis.document = { getElementById: () => null, createElement: () => ({}), head: { append() {} } };
  const React = { createElement: (...a) => ({ a }), useState: (v) => [v, () => {}], useEffect: () => {}, useSyncExternalStore: (_s, g) => g() };
  await import(pathToFileURL(join(here, "..", "lib", "client.js")).href);
  check("client bundle registers id dsh-touchstone", spec?.id === "dsh-touchstone");
  const mod = spec.factory((id) => { if (id === "react") return React; throw new Error("unexpected require " + id); });
  check("client bundle exports apply()", typeof mod.apply === "function");
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

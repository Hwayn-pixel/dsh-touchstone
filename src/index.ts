/// <reference types="node" />
/**
 * dsh-touchstone — Host half.
 *
 * Touchstone closes the *evaluation* half of DSH's self-evolution. This half is the test bench:
 *
 *   1. **Cases** — a prompt plus checks (must contain / must not contain / regex / LLM judge).
 *   2. **Candidates** — a system prompt to try, either appended to the current one or replacing it;
 *      the control is the built-in "current (no change)".
 *   3. **Run** — for each case × candidate, call the model once with the candidate's system prompt
 *      and the case's user prompt, and collect the text and usage.
 *   4. **Score** — rule checks decide in-process; the LLM judge costs one more model call and only
 *      has to answer PASS or FAIL.
 *   5. **Report** — per-case before → after deltas plus an overall verdict: keep it, or revert.
 *
 * The engine only borrows the public `ctx.llm.stream()` seam; it never patches the harness and
 * depends on no internal services, so it works on both DSH 0.1.x and 0.2.
 */
import z from "@deepseek-ai/schemastery";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const name = "dsh-touchstone";
export const SETTINGS_NAMESPACE = "ui-touchstone";

const ROUTE_PREFIX = "/dsh-touchstone";
const RUNS_KEEP = 40;
const DEFAULT_MAX_OUTPUT = 800;
const JUDGE_MAX_OUTPUT = 200;

export interface Check {
  id: string;
  kind: "must" | "mustNot" | "regex" | "llm";
  value: string;
  weight?: number;
}
export interface Case {
  id: string;
  name: string;
  prompt: string;
  system?: string;
  checks: Check[];
  enabled: boolean;
}
export interface Variant {
  id: string;
  name: string;
  note?: string;
  mode: "baseline" | "append" | "replace";
  systemText?: string;
  temperature?: number;
}
export interface Score {
  checkId: string;
  kind: string;
  pass: boolean;
  detail: string;
}
export interface CaseRun {
  caseId: string;
  variantId: string;
  ok: boolean;
  output: string;
  finish: string;
  usage: unknown;
  scores: Score[];
  total: number | null;
  error?: string;
}
export interface RunRecord {
  id: string;
  at: number;
  label: string;
  provider: string;
  model: string;
  caseNames: Record<string, string>;
  variantNames: Record<string, string>;
  results: CaseRun[];
}
export interface State {
  cases: Case[];
  variants: Variant[];
  runs: RunRecord[];
}

/** The built-in control. Its display name is localized by the client; `name` here is a fallback. */
export const BASELINE_VARIANT: Variant = { id: "baseline", name: "current (no change)", mode: "baseline" };

export const TouchstoneSchema = z
  .object({
    provider: z.string().default("deepseek-official").description("Provider used to run cases (blank = the harness default)"),
    model: z.string().default("deepseek-flash").description("Model used to run cases"),
    judgeProvider: z.string().default("").description("Provider for the judge model (blank = same as the runner)"),
    judgeModel: z.string().default("").description("Judge model (blank = same as the runner)"),
    temperature: z.number().default(0.2).description("Sampling temperature for runs (lower = more reproducible)"),
    maxOutput: z.number().default(DEFAULT_MAX_OUTPUT).description("Max output tokens per case"),
  })
  .description("dsh-touchstone: evaluate whether a change actually improved the agent");

interface SettingsLike {
  get(ns: string): unknown;
  register?(ns: string, schema: unknown): unknown;
}
interface HostContext {
  get?(name: string): unknown;
  inject(services: readonly string[], fn: (ctx: HostContext) => void): unknown;
  effect(fn: () => unknown, label?: string): unknown;
}
interface Cfg {
  provider: string;
  model: string;
  judgeProvider: string;
  judgeModel: string;
  temperature: number;
  maxOutput: number;
}
const CFG_DEFAULTS: Cfg = {
  provider: "deepseek-official",
  model: "deepseek-flash",
  judgeProvider: "",
  judgeModel: "",
  temperature: 0.2,
  maxOutput: DEFAULT_MAX_OUTPUT,
};

// ── the bench (storage) ─────────────────────────────────────────────────────
let state: State = { cases: [], variants: [], runs: [] };

function benchFile(): string {
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "touchstone", "bench.json");
}
function load(): void {
  try {
    const parsed = JSON.parse(readFileSync(benchFile(), "utf8"));
    if (parsed && typeof parsed === "object") {
      state = {
        cases: Array.isArray(parsed.cases) ? parsed.cases : [],
        variants: Array.isArray(parsed.variants) ? parsed.variants : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      };
    }
  } catch {
    /* first run */
  }
}
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function persist(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(benchFile()), { recursive: true });
      writeFileSync(benchFile(), JSON.stringify(state, null, 1), "utf8");
    } catch {
      /* the bench is a convenience, never a failure */
    }
  }, 150);
}

function readCfg(settings: SettingsLike | undefined): Cfg {
  try {
    const raw = settings?.get(SETTINGS_NAMESPACE);
    if (raw && typeof raw === "object") return { ...CFG_DEFAULTS, ...(raw as Cfg) };
  } catch {
    /* the settings service may not be attached yet */
  }
  return CFG_DEFAULTS;
}

// ── pure helpers (exercised by the test suite) ──────────────────────────────
export function firstLine(text: string, max = 60): string {
  const line = String(text ?? "").split(/\r?\n/).map((r) => r.trim()).find((r) => r.length) ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line || "(untitled)";
}

/** Compose the system prompt a variant asks for, over the case's own base text. */
export function composeSystem(baseText: string | undefined, variant: Variant): string {
  const base = String(baseText ?? "").trim();
  if (variant.mode === "baseline") return base;
  const added = String(variant.systemText ?? "").trim();
  if (variant.mode === "replace") return added;
  return [base, added].filter(Boolean).join("\n\n");
}

function weightOf(check: Check): number {
  const w = Number(check?.weight);
  return Number.isFinite(w) && w > 0 ? w : 1;
}

/** Rule checks that need no model. Returns one Score per non-LLM check. */
export function scoreLocal(output: string, checks: Check[]): Score[] {
  const text = String(output ?? "");
  const out: Score[] = [];
  for (const check of checks ?? []) {
    if (check.kind === "llm") continue;
    if (check.kind === "must") {
      const pass = text.toLowerCase().includes(String(check.value ?? "").toLowerCase());
      out.push({ checkId: check.id, kind: check.kind, pass, detail: pass ? "found" : `missing "${check.value}"` });
    } else if (check.kind === "mustNot") {
      const hit = text.toLowerCase().includes(String(check.value ?? "").toLowerCase());
      out.push({ checkId: check.id, kind: check.kind, pass: !hit, detail: hit ? `must not contain "${check.value}"` : "clean" });
    } else if (check.kind === "regex") {
      let pass = false;
      let detail = "";
      try {
        pass = new RegExp(String(check.value ?? ""), "i").test(text);
        detail = pass ? "matched" : `no match /${check.value}/`;
      } catch (error) {
        detail = `invalid regex: ${String((error as Error)?.message ?? error)}`;
      }
      out.push({ checkId: check.id, kind: check.kind, pass, detail });
    }
  }
  return out;
}

/** Weighted pass fraction over every check's score, or null when there is nothing to score. */
export function totalOf(scores: Score[], checks: Check[]): number | null {
  if (!scores.length) return null;
  const weights = new Map(checks.map((c) => [c.id, weightOf(c)]));
  let got = 0;
  let all = 0;
  for (const score of scores) {
    const w = weights.get(score.checkId) ?? 1;
    all += w;
    if (score.pass) got += w;
  }
  return all > 0 ? got / all : null;
}

/** Per-case before→after, plus an aggregate verdict. */
export function diff(baseline: CaseRun[], candidate: CaseRun[], cases: Case[]): {
  rows: { caseId: string; name: string; before: number | null; after: number | null; delta: number }[];
  before: number;
  after: number;
  verdict: "better" | "worse" | "same";
} {
  const names = new Map(cases.map((c) => [c.id, c.name]));
  const before = new Map(baseline.map((r) => [r.caseId, r]));
  const rows = candidate.map((run) => {
    const b = before.get(run.caseId);
    const bv = b?.total ?? null;
    const av = run.total ?? null;
    const delta = (av ?? 0) - (bv ?? 0);
    return { caseId: run.caseId, name: names.get(run.caseId) ?? run.caseId, before: bv, after: av, delta };
  });
  const avg = (list: (number | null)[]) => {
    const vals = list.filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  const bAvg = avg(rows.map((r) => r.before));
  const aAvg = avg(rows.map((r) => r.after));
  const verdict = Math.abs(aAvg - bAvg) < 0.0001 ? "same" : aAvg > bAvg ? "better" : "worse";
  return { rows, before: bAvg, after: aAvg, verdict };
}

// ── the engine ──────────────────────────────────────────────────────────────
interface LlmLike {
  stream(options: unknown): AsyncIterable<any>;
}

function userMessage(text: string): unknown {
  return {
    id: "touchstone-" + randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "dsh-touchstone" },
  };
}

/** One model call: stream the text and usage back out. */
export async function callModel(
  llm: LlmLike,
  cfg: Cfg,
  input: { system?: string; user: string; temperature?: number; maxOutput?: number; signal?: AbortSignal },
): Promise<{ text: string; finish: string; usage: unknown }> {
  const options: Record<string, unknown> = {
    provider: cfg.provider,
    model: cfg.model,
    messages: [userMessage(input.user)],
    temperature: input.temperature ?? cfg.temperature,
    maxTokens: input.maxOutput ?? cfg.maxOutput,
  };
  if (input.system) options.system = input.system;
  if (input.signal) options.signal = input.signal;

  let text = "";
  let blocks = "";
  let finish = "stop";
  let usage: unknown = null;
  for await (const chunk of llm.stream(options)) {
    if (chunk?.type === "text-delta") text += chunk.text ?? "";
    else if (chunk?.type === "block-end" && chunk.block?.type === "text") blocks += chunk.block.text ?? "";
    else if (chunk?.type === "usage") usage = chunk.usage;
    else if (chunk?.type === "finish") finish = chunk.reason?.kind ?? "stop";
  }
  // Prefer the deltas; fall back to assembled blocks if a provider only emits those.
  return { text: text || blocks, finish, usage };
}

async function judge(llm: LlmLike, cfg: Cfg, rubric: string, output: string, signal?: AbortSignal): Promise<{ pass: boolean; detail: string }> {
  const judgeCfg: Cfg = { ...cfg, provider: cfg.judgeProvider || cfg.provider, model: cfg.judgeModel || cfg.model };
  const system =
    "You are a strict grader. Read the RUBRIC and the CANDIDATE OUTPUT. " +
    "Answer with PASS or FAIL on the first line, then one short sentence of reason. Output nothing else.";
  const user = `RUBRIC:\n${rubric}\n\nCANDIDATE OUTPUT:\n${output}`;
  const { text } = await callModel(llm, judgeCfg, { system, user, temperature: 0, maxOutput: JUDGE_MAX_OUTPUT, signal });
  const head = text.trim().split(/\r?\n/)[0]?.toUpperCase() ?? "";
  const pass = head.includes("PASS") && !head.includes("FAIL");
  return { pass, detail: text.trim().slice(0, 200) || "(the judge said nothing)" };
}

/** Run one case against one variant: call the model, then score rule checks and any LLM judge. */
export async function runCase(llm: LlmLike, cfg: Cfg, testCase: Case, variant: Variant, signal?: AbortSignal): Promise<CaseRun> {
  const system = composeSystem(testCase.system, variant);
  const base: CaseRun = { caseId: testCase.id, variantId: variant.id, ok: false, output: "", finish: "", usage: null, scores: [], total: null };
  try {
    const { text, finish, usage } = await callModel(llm, cfg, { system, user: testCase.prompt, temperature: variant.temperature, signal });
    base.output = text;
    base.finish = finish;
    base.usage = usage;
    const scores = scoreLocal(text, testCase.checks);
    for (const check of testCase.checks ?? []) {
      if (check.kind !== "llm") continue;
      const verdict = await judge(llm, cfg, String(check.value ?? ""), text, signal);
      scores.push({ checkId: check.id, kind: "llm", pass: verdict.pass, detail: verdict.detail });
    }
    base.scores = scores;
    base.total = totalOf(scores, testCase.checks);
    base.ok = true;
  } catch (error) {
    base.error = String((error as Error)?.message ?? error);
  }
  return base;
}

function readBody(req: any, limit = 1_000_000): Promise<any> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { resolve({}); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

export function apply(ctx: HostContext): void {
  load();

  ctx.inject(["settings"], (settingsCtx) => {
    (settingsCtx as unknown as { settings: SettingsLike }).settings.register?.(SETTINGS_NAMESPACE, TouchstoneSchema);
  });

  const settingsOf = (): SettingsLike | undefined => (ctx.get ? ctx.get("settings") : undefined) as SettingsLike | undefined;
  const llmOf = (): LlmLike | undefined => (ctx.get ? ctx.get("llm") : undefined) as LlmLike | undefined;

  ctx.inject(["webServer"], (httpCtx) => {
    const server = (
      httpCtx as unknown as {
        webServer: {
          register(route: { kind: "prefix"; path: string; handler: (req: any, res: any) => void | Promise<void> }): () => void;
        };
      }
    ).webServer;

    httpCtx.effect(
      () =>
        server.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: async (req: any, res: any) => {
            const url = new URL(req.url ?? "/", "http://local");
            const ok = (status: number, body: unknown) => {
              res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify(body));
            };
            const cfg = readCfg(settingsOf());
            try {
              // GET /dsh-touchstone/state — cases, candidates, and run summaries.
              if (req.method === "GET" && url.pathname === `${ROUTE_PREFIX}/state`) {
                return ok(200, {
                  ok: true,
                  provider: cfg.provider,
                  model: cfg.model,
                  cases: state.cases,
                  variants: [BASELINE_VARIANT, ...state.variants],
                  runs: state.runs.map((r) => ({ id: r.id, at: r.at, label: r.label, count: r.results.length })),
                });
              }

              // GET /dsh-touchstone/runs?id=… — one full run.
              if (req.method === "GET" && url.pathname === `${ROUTE_PREFIX}/runs`) {
                const id = url.searchParams.get("id");
                if (id) {
                  const run = state.runs.find((r) => r.id === id);
                  return run ? ok(200, { ok: true, run }) : ok(404, { ok: false, error: "run not found" });
                }
                return ok(200, { ok: true, runs: state.runs.map((r) => ({ id: r.id, at: r.at, label: r.label, count: r.results.length })) });
              }

              // POST /dsh-touchstone/cases — upsert one case.
              if (req.method === "POST" && url.pathname === `${ROUTE_PREFIX}/cases`) {
                const body = await readBody(req);
                const incoming = body?.case ?? body;
                const one: Case = {
                  id: String(incoming?.id || randomUUID()),
                  name: String(incoming?.name ?? "").slice(0, 120) || firstLine(incoming?.prompt ?? ""),
                  prompt: String(incoming?.prompt ?? ""),
                  system: incoming?.system ? String(incoming.system) : undefined,
                  checks: Array.isArray(incoming?.checks)
                    ? incoming.checks.map((c: any) => ({ id: String(c?.id || randomUUID()), kind: c?.kind, value: String(c?.value ?? ""), weight: Number(c?.weight) || undefined }))
                    : [],
                  enabled: incoming?.enabled !== false,
                };
                if (!one.prompt.trim()) return ok(400, { ok: false, error: "a case needs a prompt" });
                const at = state.cases.findIndex((c) => c.id === one.id);
                if (at >= 0) state.cases[at] = one; else state.cases.push(one);
                persist();
                return ok(200, { ok: true, case: one });
              }

              // DELETE /dsh-touchstone/cases?id=…
              if (req.method === "DELETE" && url.pathname === `${ROUTE_PREFIX}/cases`) {
                const id = url.searchParams.get("id") ?? "";
                state.cases = state.cases.filter((c) => c.id !== id);
                persist();
                return ok(200, { ok: true, count: state.cases.length });
              }

              // POST /dsh-touchstone/variants — upsert one candidate.
              if (req.method === "POST" && url.pathname === `${ROUTE_PREFIX}/variants`) {
                const body = await readBody(req);
                const incoming = body?.variant ?? body;
                const one: Variant = {
                  id: String(incoming?.id || randomUUID()),
                  name: String(incoming?.name ?? "").slice(0, 120) || "candidate",
                  note: incoming?.note ? String(incoming.note) : undefined,
                  mode: incoming?.mode === "replace" ? "replace" : "append",
                  systemText: String(incoming?.systemText ?? ""),
                  temperature: Number.isFinite(Number(incoming?.temperature)) ? Number(incoming.temperature) : undefined,
                };
                if (one.id === BASELINE_VARIANT.id) return ok(400, { ok: false, error: "the built-in control cannot be edited" });
                const at = state.variants.findIndex((v) => v.id === one.id);
                if (at >= 0) state.variants[at] = one; else state.variants.push(one);
                persist();
                return ok(200, { ok: true, variant: one });
              }

              // DELETE /dsh-touchstone/variants?id=…
              if (req.method === "DELETE" && url.pathname === `${ROUTE_PREFIX}/variants`) {
                const id = url.searchParams.get("id") ?? "";
                state.variants = state.variants.filter((v) => v.id !== id);
                persist();
                return ok(200, { ok: true, count: state.variants.length });
              }

              // POST /dsh-touchstone/run — run baseline + each selected candidate across the enabled cases.
              if (req.method === "POST" && url.pathname === `${ROUTE_PREFIX}/run`) {
                const llm = llmOf();
                if (!llm || typeof llm.stream !== "function") return ok(503, { ok: false, error: "the llm service is not ready" });
                const body = await readBody(req);
                const wantedVariants: string[] = Array.isArray(body?.variantIds) ? body.variantIds.map(String) : state.variants.map((v) => v.id);
                const caseIds: string[] | null = Array.isArray(body?.caseIds) ? body.caseIds.map(String) : null;
                const targetCases = state.cases.filter((c) => c.enabled !== false && (!caseIds || caseIds.includes(c.id)));
                if (!targetCases.length) return ok(400, { ok: false, error: "no enabled cases to run" });
                const variants: Variant[] = [BASELINE_VARIANT, ...state.variants.filter((v) => wantedVariants.includes(v.id))];
                const result: CaseRun[] = [];
                for (const variant of variants) {
                  for (const testCase of targetCases) {
                    result.push(await runCase(llm, cfg, testCase, variant));
                  }
                }
                const record: RunRecord = {
                  id: randomUUID(),
                  at: Date.now(),
                  label: String(body?.label ?? "").slice(0, 120) || `${variants.length - 1} candidate(s) × ${targetCases.length} case(s)`,
                  provider: cfg.provider,
                  model: cfg.model,
                  caseNames: Object.fromEntries(targetCases.map((c) => [c.id, c.name])),
                  variantNames: Object.fromEntries(variants.map((v) => [v.id, v.name])),
                  results: result,
                };
                state.runs.unshift(record);
                state.runs = state.runs.slice(0, RUNS_KEEP);
                persist();
                return ok(200, { ok: true, run: record });
              }

              // GET /dsh-touchstone/report?run=&variant= — before→after for one candidate.
              if (req.method === "GET" && url.pathname === `${ROUTE_PREFIX}/report`) {
                const run = state.runs.find((r) => r.id === url.searchParams.get("run"));
                if (!run) return ok(404, { ok: false, error: "run not found" });
                const variantId = url.searchParams.get("variant") ?? "";
                const baseline = run.results.filter((r) => r.variantId === BASELINE_VARIANT.id);
                const candidate = run.results.filter((r) => r.variantId === variantId);
                const cases = state.cases;
                return ok(200, { ok: true, variantId, variantName: run.variantNames[variantId] ?? variantId, ...diff(baseline, candidate, cases) });
              }

              return ok(404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
            } catch (error) {
              return ok(500, { ok: false, error: String((error as Error)?.message ?? error) });
            }
          },
        }),
      "dsh-touchstone: bench routes",
    );
  });
}

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
/** The built-in control. Its display name is localized by the client; `name` here is a fallback. */
export const BASELINE_VARIANT = { id: "baseline", name: "current (no change)", mode: "baseline" };
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
const CFG_DEFAULTS = {
    provider: "deepseek-official",
    model: "deepseek-flash",
    judgeProvider: "",
    judgeModel: "",
    temperature: 0.2,
    maxOutput: DEFAULT_MAX_OUTPUT,
};
// ── the bench (storage) ─────────────────────────────────────────────────────
let state = { cases: [], variants: [], runs: [] };
function benchFile() {
    return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "touchstone", "bench.json");
}
function load() {
    try {
        const parsed = JSON.parse(readFileSync(benchFile(), "utf8"));
        if (parsed && typeof parsed === "object") {
            state = {
                cases: Array.isArray(parsed.cases) ? parsed.cases : [],
                variants: Array.isArray(parsed.variants) ? parsed.variants : [],
                runs: Array.isArray(parsed.runs) ? parsed.runs : [],
            };
        }
    }
    catch {
        /* first run */
    }
}
let flushTimer = null;
function persist() {
    if (flushTimer)
        clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        try {
            mkdirSync(dirname(benchFile()), { recursive: true });
            writeFileSync(benchFile(), JSON.stringify(state, null, 1), "utf8");
        }
        catch {
            /* the bench is a convenience, never a failure */
        }
    }, 150);
}
function readCfg(settings) {
    try {
        const raw = settings?.get(SETTINGS_NAMESPACE);
        if (raw && typeof raw === "object")
            return { ...CFG_DEFAULTS, ...raw };
    }
    catch {
        /* the settings service may not be attached yet */
    }
    return CFG_DEFAULTS;
}
// ── pure helpers (exercised by the test suite) ──────────────────────────────
export function firstLine(text, max = 60) {
    const line = String(text ?? "").split(/\r?\n/).map((r) => r.trim()).find((r) => r.length) ?? "";
    return line.length > max ? line.slice(0, max) + "…" : line || "(untitled)";
}
/** Compose the system prompt a variant asks for, over the case's own base text. */
export function composeSystem(baseText, variant) {
    const base = String(baseText ?? "").trim();
    if (variant.mode === "baseline")
        return base;
    const added = String(variant.systemText ?? "").trim();
    if (variant.mode === "replace")
        return added;
    return [base, added].filter(Boolean).join("\n\n");
}
function weightOf(check) {
    const w = Number(check?.weight);
    return Number.isFinite(w) && w > 0 ? w : 1;
}
/** Rule checks that need no model. Returns one Score per non-LLM check. */
export function scoreLocal(output, checks) {
    const text = String(output ?? "");
    const out = [];
    for (const check of checks ?? []) {
        if (check.kind === "llm")
            continue;
        if (check.kind === "must") {
            const pass = text.toLowerCase().includes(String(check.value ?? "").toLowerCase());
            out.push({ checkId: check.id, kind: check.kind, pass, detail: pass ? "found" : `missing "${check.value}"` });
        }
        else if (check.kind === "mustNot") {
            const hit = text.toLowerCase().includes(String(check.value ?? "").toLowerCase());
            out.push({ checkId: check.id, kind: check.kind, pass: !hit, detail: hit ? `must not contain "${check.value}"` : "clean" });
        }
        else if (check.kind === "regex") {
            let pass = false;
            let detail = "";
            try {
                pass = new RegExp(String(check.value ?? ""), "i").test(text);
                detail = pass ? "matched" : `no match /${check.value}/`;
            }
            catch (error) {
                detail = `invalid regex: ${String(error?.message ?? error)}`;
            }
            out.push({ checkId: check.id, kind: check.kind, pass, detail });
        }
    }
    return out;
}
/** Weighted pass fraction over every check's score, or null when there is nothing to score. */
export function totalOf(scores, checks) {
    if (!scores.length)
        return null;
    const weights = new Map(checks.map((c) => [c.id, weightOf(c)]));
    let got = 0;
    let all = 0;
    for (const score of scores) {
        const w = weights.get(score.checkId) ?? 1;
        all += w;
        if (score.pass)
            got += w;
    }
    return all > 0 ? got / all : null;
}
/** Per-case before→after, plus an aggregate verdict. */
export function diff(baseline, candidate, cases) {
    const names = new Map(cases.map((c) => [c.id, c.name]));
    const before = new Map(baseline.map((r) => [r.caseId, r]));
    const rows = candidate.map((run) => {
        const b = before.get(run.caseId);
        const bv = b?.total ?? null;
        const av = run.total ?? null;
        const delta = (av ?? 0) - (bv ?? 0);
        return { caseId: run.caseId, name: names.get(run.caseId) ?? run.caseId, before: bv, after: av, delta };
    });
    const avg = (list) => {
        const vals = list.filter((v) => typeof v === "number");
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };
    const bAvg = avg(rows.map((r) => r.before));
    const aAvg = avg(rows.map((r) => r.after));
    const verdict = Math.abs(aAvg - bAvg) < 0.0001 ? "same" : aAvg > bAvg ? "better" : "worse";
    return { rows, before: bAvg, after: aAvg, verdict };
}
function userMessage(text) {
    return {
        id: "touchstone-" + randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "dsh-touchstone" },
    };
}
/** One model call: stream the text and usage back out. */
export async function callModel(llm, cfg, input) {
    const options = {
        provider: cfg.provider,
        model: cfg.model,
        messages: [userMessage(input.user)],
        temperature: input.temperature ?? cfg.temperature,
        maxTokens: input.maxOutput ?? cfg.maxOutput,
    };
    if (input.system)
        options.system = input.system;
    if (input.signal)
        options.signal = input.signal;
    let text = "";
    let blocks = "";
    let finish = "stop";
    let usage = null;
    for await (const chunk of llm.stream(options)) {
        if (chunk?.type === "text-delta")
            text += chunk.text ?? "";
        else if (chunk?.type === "block-end" && chunk.block?.type === "text")
            blocks += chunk.block.text ?? "";
        else if (chunk?.type === "usage")
            usage = chunk.usage;
        else if (chunk?.type === "finish")
            finish = chunk.reason?.kind ?? "stop";
    }
    // Prefer the deltas; fall back to assembled blocks if a provider only emits those.
    return { text: text || blocks, finish, usage };
}
async function judge(llm, cfg, rubric, output, signal) {
    const judgeCfg = { ...cfg, provider: cfg.judgeProvider || cfg.provider, model: cfg.judgeModel || cfg.model };
    const system = "You are a strict grader. Read the RUBRIC and the CANDIDATE OUTPUT. " +
        "Answer with PASS or FAIL on the first line, then one short sentence of reason. Output nothing else.";
    const user = `RUBRIC:\n${rubric}\n\nCANDIDATE OUTPUT:\n${output}`;
    const { text } = await callModel(llm, judgeCfg, { system, user, temperature: 0, maxOutput: JUDGE_MAX_OUTPUT, signal });
    const head = text.trim().split(/\r?\n/)[0]?.toUpperCase() ?? "";
    const pass = head.includes("PASS") && !head.includes("FAIL");
    return { pass, detail: text.trim().slice(0, 200) || "(the judge said nothing)" };
}
/** Run one case against one variant: call the model, then score rule checks and any LLM judge. */
export async function runCase(llm, cfg, testCase, variant, signal) {
    const system = composeSystem(testCase.system, variant);
    const base = { caseId: testCase.id, variantId: variant.id, ok: false, output: "", finish: "", usage: null, scores: [], total: null };
    try {
        const { text, finish, usage } = await callModel(llm, cfg, { system, user: testCase.prompt, temperature: variant.temperature, signal });
        base.output = text;
        base.finish = finish;
        base.usage = usage;
        const scores = scoreLocal(text, testCase.checks);
        for (const check of testCase.checks ?? []) {
            if (check.kind !== "llm")
                continue;
            const verdict = await judge(llm, cfg, String(check.value ?? ""), text, signal);
            scores.push({ checkId: check.id, kind: "llm", pass: verdict.pass, detail: verdict.detail });
        }
        base.scores = scores;
        base.total = totalOf(scores, testCase.checks);
        base.ok = true;
    }
    catch (error) {
        base.error = String(error?.message ?? error);
    }
    return base;
}
function readBody(req, limit = 1_000_000) {
    return new Promise((resolve) => {
        let size = 0;
        const chunks = [];
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit) {
                resolve({});
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => { try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        }
        catch {
            resolve({});
        } });
        req.on("error", () => resolve({}));
    });
}
export function apply(ctx) {
    load();
    ctx.inject(["settings"], (settingsCtx) => {
        settingsCtx.settings.register?.(SETTINGS_NAMESPACE, TouchstoneSchema);
    });
    const settingsOf = () => (ctx.get ? ctx.get("settings") : undefined);
    const llmOf = () => (ctx.get ? ctx.get("llm") : undefined);
    ctx.inject(["webServer"], (httpCtx) => {
        const server = httpCtx.webServer;
        httpCtx.effect(() => server.register({
            kind: "prefix",
            path: ROUTE_PREFIX,
            handler: async (req, res) => {
                const url = new URL(req.url ?? "/", "http://local");
                const ok = (status, body) => {
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
                        const one = {
                            id: String(incoming?.id || randomUUID()),
                            name: String(incoming?.name ?? "").slice(0, 120) || firstLine(incoming?.prompt ?? ""),
                            prompt: String(incoming?.prompt ?? ""),
                            system: incoming?.system ? String(incoming.system) : undefined,
                            checks: Array.isArray(incoming?.checks)
                                ? incoming.checks.map((c) => ({ id: String(c?.id || randomUUID()), kind: c?.kind, value: String(c?.value ?? ""), weight: Number(c?.weight) || undefined }))
                                : [],
                            enabled: incoming?.enabled !== false,
                        };
                        if (!one.prompt.trim())
                            return ok(400, { ok: false, error: "a case needs a prompt" });
                        const at = state.cases.findIndex((c) => c.id === one.id);
                        if (at >= 0)
                            state.cases[at] = one;
                        else
                            state.cases.push(one);
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
                        const one = {
                            id: String(incoming?.id || randomUUID()),
                            name: String(incoming?.name ?? "").slice(0, 120) || "candidate",
                            note: incoming?.note ? String(incoming.note) : undefined,
                            mode: incoming?.mode === "replace" ? "replace" : "append",
                            systemText: String(incoming?.systemText ?? ""),
                            temperature: Number.isFinite(Number(incoming?.temperature)) ? Number(incoming.temperature) : undefined,
                        };
                        if (one.id === BASELINE_VARIANT.id)
                            return ok(400, { ok: false, error: "the built-in control cannot be edited" });
                        const at = state.variants.findIndex((v) => v.id === one.id);
                        if (at >= 0)
                            state.variants[at] = one;
                        else
                            state.variants.push(one);
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
                        if (!llm || typeof llm.stream !== "function")
                            return ok(503, { ok: false, error: "the llm service is not ready" });
                        const body = await readBody(req);
                        const wantedVariants = Array.isArray(body?.variantIds) ? body.variantIds.map(String) : state.variants.map((v) => v.id);
                        const caseIds = Array.isArray(body?.caseIds) ? body.caseIds.map(String) : null;
                        const targetCases = state.cases.filter((c) => c.enabled !== false && (!caseIds || caseIds.includes(c.id)));
                        if (!targetCases.length)
                            return ok(400, { ok: false, error: "no enabled cases to run" });
                        const variants = [BASELINE_VARIANT, ...state.variants.filter((v) => wantedVariants.includes(v.id))];
                        const result = [];
                        for (const variant of variants) {
                            for (const testCase of targetCases) {
                                result.push(await runCase(llm, cfg, testCase, variant));
                            }
                        }
                        const record = {
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
                        if (!run)
                            return ok(404, { ok: false, error: "run not found" });
                        const variantId = url.searchParams.get("variant") ?? "";
                        const baseline = run.results.filter((r) => r.variantId === BASELINE_VARIANT.id);
                        const candidate = run.results.filter((r) => r.variantId === variantId);
                        const cases = state.cases;
                        return ok(200, { ok: true, variantId, variantName: run.variantNames[variantId] ?? variantId, ...diff(baseline, candidate, cases) });
                    }
                    return ok(404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
                }
                catch (error) {
                    return ok(500, { ok: false, error: String(error?.message ?? error) });
                }
            },
        }), "dsh-touchstone: bench routes");
    });
}

window.__ModuleLoader__.load({
	id: "dsh-touchstone",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
/**
 * dsh-touchstone — Browser half.
 *
 * One settings page ("Touchstone"):
 *   · Golden cases  — a prompt plus checks (must contain / must not / regex / LLM judge)
 *   · Candidates    — a prompt under test (append to current, or replace); the control is "Current"
 *   · Run           — run every case against current and each candidate
 *   · Report        — per-case before → after, plus an overall verdict: keep it, or revert
 *
 * UI copy is localized: Chinese browsers get Chinese, everyone else gets English.
 *
 * `React.createElement` rather than JSX: this file is transpiled straight to CommonJS for the
 * client-module loader, which has no JSX pass.
 */
const React = require("react");
const h = React.createElement;
/** Pick a language from the browser: Chinese if the UI language looks Chinese, English otherwise. */
const LANG = typeof navigator !== "undefined" && /^zh/i.test(String(navigator.language || "")) ? "zh" : "en";
/** Inline bilingual string. */
function t(zh, en) {
    return LANG === "zh" ? zh : en;
}
const NS = "ui-touchstone";
const ROUTE = "/dsh-touchstone";
const STYLE_ID = "dsh-touchstone-style";
exports.inject = ["slots", "remote"];
// ── a tiny shared store the whole UI reads ──────────────────────────────────
let state = { cases: [], variants: [], runs: [], provider: "", model: "", status: "cold" };
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const getState = () => state;
let inflight = null;
function refresh() {
    if (inflight)
        return inflight;
    inflight = (async () => {
        try {
            const json = await fetch(`${ROUTE}/state`, { cache: "no-store" }).then((r) => r.json());
            if (json?.ok)
                state = { ...state, cases: json.cases ?? [], variants: json.variants ?? [], runs: json.runs ?? [], provider: json.provider ?? "", model: json.model ?? "", status: "ready" };
            else
                state = { ...state, status: "error", error: json?.error };
        }
        catch (error) {
            state = { ...state, status: "error", error: String(error?.message ?? error) };
        }
        finally {
            inflight = null;
            emit();
        }
    })();
    return inflight;
}
async function api(method, path, body) {
    const res = await fetch(`${ROUTE}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    await refresh();
    return json;
}
function useStore() {
    return React.useSyncExternalStore(subscribe, getState, getState);
}
function useCold() {
    React.useEffect(() => { if (state.status === "cold")
        void refresh(); }, []);
}
function uid() {
    return Math.random().toString(36).slice(2, 9);
}
const CSS = `
.dshTs{--t-r-sm:10px;--t-r-md:14px;--t-r-lg:20px;--t-pill:999px;
  --t-tone:rgba(128,128,128,.055);--t-tone-2:rgba(128,128,128,.10);--t-tone-3:rgba(128,128,128,.16);
  --t-line:1px solid rgba(128,128,128,.18);--t-accent:rgba(48,126,222,.9);--t-ok:#4f9d6a;--t-bad:#d0604c;--t-warn:#e2a13c;
  display:flex;flex-direction:column;gap:14px;font-size:13.5px;line-height:1.65}
.dshTs-card{background:var(--t-tone);border-radius:var(--t-r-md);padding:15px 17px}
.dshTs-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshTs-h{font-size:15px;font-weight:600}
.dshTs-sub{font-size:12px;opacity:.62}
.dshTs-grow{flex:1}
.dshTs-btn{border:var(--t-line);border-radius:var(--t-r-sm);padding:4px 11px;font:inherit;font-size:12.5px;background:transparent;color:inherit;cursor:pointer;transition:background .18s ease}
.dshTs-btn:hover{background:var(--t-tone-2)}
.dshTs-btn:disabled{opacity:.45;cursor:default}
.dshTs-btn--go{border-color:transparent;background:var(--t-accent);color:#fff}
.dshTs-btn--go:hover{background:var(--t-accent);filter:brightness(1.06)}
.dshTs-btn--x{border:0;opacity:.55;padding:2px 7px}
.dshTs-in,.dshTs-ta,.dshTs-sel{font:inherit;font-size:12.5px;padding:6px 10px;border-radius:var(--t-r-sm);border:var(--t-line);background:var(--t-tone);color:inherit}
.dshTs-in:hover,.dshTs-ta:hover,.dshTs-sel:hover{background:var(--t-tone-2)}
.dshTs-in{flex:1;min-width:120px}
.dshTs-ta{width:100%;min-height:70px;resize:vertical;line-height:1.6;font-family:inherit;margin-top:7px}
.dshTs-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshTs-item{border:var(--t-line);border-radius:var(--t-r-md);padding:12px 13px;margin-top:9px}
.dshTs-chk{display:flex;align-items:center;gap:7px;margin-top:7px}
.dshTs-pill{font-size:11px;padding:1px 8px;border-radius:var(--t-pill);background:var(--t-tone-3)}
.dshTs-ok{color:var(--t-ok)}.dshTs-bad{color:var(--t-bad)}.dshTs-warn{color:var(--t-warn)}
.dshTs-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12.5px}
.dshTs-table td,.dshTs-table th{padding:6px 8px;border-bottom:var(--t-line);text-align:left}
.dshTs-empty{opacity:.6;font-size:12.5px;padding:6px 0}
.dshTs-verdict{margin-top:10px;padding:10px 12px;border-radius:var(--t-r-md);background:var(--t-tone-2);font-size:13px}
`;
function ensureStyle() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
}
function pct(v) {
    return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}
function clock(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// ── one check row ───────────────────────────────────────────────────────────
function CheckRow(props) {
    const { check } = props;
    return h("div", { className: "dshTs-chk" }, h("select", { className: "dshTs-sel", value: check.kind, onChange: (e) => props.onChange({ kind: e.target.value }) }, h("option", { value: "must" }, t("必须包含", "must contain")), h("option", { value: "mustNot" }, t("必须不含", "must not contain")), h("option", { value: "regex" }, t("匹配正则", "matches regex")), h("option", { value: "llm" }, t("模型裁判", "LLM judge"))), h("input", {
        className: "dshTs-in",
        value: check.value,
        placeholder: check.kind === "llm"
            ? t("裁判标准，例如：结论先给，再给理由", "Judge rubric, e.g. lead with the conclusion, then reasons")
            : check.kind === "regex"
                ? t("正则，例如：先\\s*结论", "Regex, e.g. ^Note:")
                : t("要检查的文字", "Text to look for"),
        onChange: (e) => props.onChange({ value: e.target.value }),
    }), h("button", { className: "dshTs-btn dshTs-btn--x", onClick: props.onRemove, title: t("删掉这条检查", "Remove this check") }, "×"));
}
// ── one case ────────────────────────────────────────────────────────────────
//
// NOTE: text fields are DRAFTED locally and committed on blur. A controlled input that posts on
// every keystroke fights the IME — the round-trip overwrites the field mid-composition and CJK text
// comes out garbled. Type locally, save on blur.
function CaseCard(props) {
    const { testCase } = props;
    const [draft, setDraft] = React.useState(testCase);
    React.useEffect(() => { setDraft(testCase); }, [testCase.id]);
    const commit = () => void api("POST", "/cases", draft);
    const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
    const saveNow = (patch) => { setDraft((d) => ({ ...d, ...patch })); void api("POST", "/cases", { ...draft, ...patch }); };
    return h("div", { className: "dshTs-item", onBlur: commit }, h("div", { className: "dshTs-row" }, h("input", { type: "checkbox", checked: draft.enabled !== false, onChange: (e) => saveNow({ enabled: e.target.checked }) }), h("input", { className: "dshTs-in", value: draft.name, placeholder: t("给用例起个名（比如：先说结论）", "Case name (e.g. lead with the answer)"), onChange: (e) => set({ name: e.target.value }) }), h("span", { className: "dshTs-pill" }, t(`${draft.checks?.length ?? 0} 项检查`, `${draft.checks?.length ?? 0} checks`)), h("button", { className: "dshTs-btn dshTs-btn--x", onMouseDown: (e) => e.preventDefault(), onClick: () => void api("DELETE", `/cases?id=${encodeURIComponent(draft.id)}`), title: t("删掉这条用例", "Delete this case") }, "×")), h("textarea", { className: "dshTs-ta", value: draft.prompt, placeholder: t("把你丢给 agent 的那句话写在这…", "The sentence you send to the agent…"), onChange: (e) => set({ prompt: e.target.value }) }), ...(draft.checks ?? []).map((check, i) => h(CheckRow, {
        key: check.id,
        check,
        onChange: (patch) => set({ checks: draft.checks.map((c, j) => (j === i ? { ...c, ...patch } : c)) }),
        onRemove: () => saveNow({ checks: draft.checks.filter((_, j) => j !== i) }),
    })), h("button", { className: "dshTs-btn", style: { marginTop: 8 }, onMouseDown: (e) => e.preventDefault(), onClick: () => saveNow({ checks: [...(draft.checks ?? []), { id: uid(), kind: "must", value: "" }] }) }, t("+ 加一条检查", "+ Add a check")));
}
// ── one candidate ───────────────────────────────────────────────────────────
function VariantCard(props) {
    const { variant } = props;
    if (variant.mode === "baseline") {
        return h("div", { className: "dshTs-item", style: { opacity: 0.85 } }, h("div", { className: "dshTs-row" }, h("span", { className: "dshTs-pill" }, t("对照组", "control")), h("b", null, t("现状（不改）", "Current (no change)")), h("span", { className: "dshTs-sub" }, t("每个候选都和它比", "every candidate is compared against it"))));
    }
    const [draft, setDraft] = React.useState(variant);
    React.useEffect(() => { setDraft(variant); }, [variant.id]);
    const commit = () => void api("POST", "/variants", draft);
    const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
    const saveNow = (patch) => { setDraft((d) => ({ ...d, ...patch })); void api("POST", "/variants", { ...draft, ...patch }); };
    return h("div", { className: "dshTs-item", onBlur: commit }, h("div", { className: "dshTs-row" }, h("input", { className: "dshTs-in", value: draft.name, placeholder: t("给候选起个名（比如：加个开场标记）", "Candidate name (e.g. add a prefix rule)"), onChange: (e) => set({ name: e.target.value }) }), h("select", { className: "dshTs-sel", value: draft.mode, onChange: (e) => saveNow({ mode: e.target.value }) }, h("option", { value: "append" }, t("追加到现状", "append to current")), h("option", { value: "replace" }, t("整篇替换", "replace entirely"))), h("button", { className: "dshTs-btn dshTs-btn--x", onMouseDown: (e) => e.preventDefault(), onClick: () => void api("DELETE", `/variants?id=${encodeURIComponent(draft.id)}`), title: t("删掉这个候选", "Delete this candidate") }, "×")), h("textarea", { className: "dshTs-ta", value: draft.systemText ?? "", placeholder: t("要试的提示词，可以直接写一条家规，例如：回答前先给结论。", "The prompt under test — e.g. always lead with the conclusion."), onChange: (e) => set({ systemText: e.target.value }) }));
}
// ── report ──────────────────────────────────────────────────────────────────
function ReportView(props) {
    const { run } = props;
    const variants = Array.from(new Set(run.results.map((r) => r.variantId))).filter((v) => v !== "baseline");
    return h("div", null, ...variants.map((vid) => {
        const baseline = new Map(run.results.filter((r) => r.variantId === "baseline").map((r) => [r.caseId, r]));
        const cand = run.results.filter((r) => r.variantId === vid);
        const rows = cand.map((r) => {
            const b = baseline.get(r.caseId);
            return { caseId: r.caseId, name: run.caseNames[r.caseId] ?? r.caseId, before: b?.total ?? null, after: r.total, delta: (r.total ?? 0) - (b?.total ?? 0) };
        });
        const avg = (list) => { const v = list.filter((x) => typeof x === "number"); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
        const bAvg = avg(rows.map((r) => r.before));
        const aAvg = avg(rows.map((r) => r.after));
        const verdict = Math.abs(aAvg - bAvg) < 1e-6 ? "same" : aAvg > bAvg ? "better" : "worse";
        return h("div", { className: "dshTs-item", key: vid }, h("div", { className: "dshTs-row" }, h("b", null, run.variantNames[vid] ?? vid), h("span", { className: "dshTs-sub" }, t(`现状 ${pct(bAvg)} → 候选 ${pct(aAvg)}`, `current ${pct(bAvg)} → candidate ${pct(aAvg)}`))), h("table", { className: "dshTs-table" }, h("thead", null, h("tr", null, h("th", null, t("用例", "case")), h("th", null, t("现状", "current")), h("th", null, t("候选", "candidate")), h("th", null, t("变化", "change")))), h("tbody", null, ...rows.map((r) => h("tr", { key: r.caseId }, h("td", null, r.name), h("td", null, pct(r.before)), h("td", null, pct(r.after)), h("td", { className: r.delta > 0 ? "dshTs-ok" : r.delta < 0 ? "dshTs-bad" : undefined }, (r.delta > 0 ? "+" : "") + Math.round(r.delta * 100) + "%"))))), h("div", { className: "dshTs-verdict" }, verdict === "better" ? h("span", { className: "dshTs-ok" }, t("✅ 变好了，可以留。", "✅ Improved — keep it.")) : verdict === "worse" ? h("span", { className: "dshTs-bad" }, t("❌ 退步了，建议撤。", "❌ Regressed — revert.")) : h("span", { className: "dshTs-warn" }, t("➖ 没什么差别。", "➖ No real difference.")), h("span", { className: "dshTs-sub" }, t(" 分数只说明这批用例上的表现，最后拍板的还是你。", " The score speaks only for these cases; the call is still yours."))));
    }));
}
// ── settings page ───────────────────────────────────────────────────────────
function TouchstonePanel() {
    const store = useStore();
    const [busy, setBusy] = React.useState(false);
    const [picked, setPicked] = React.useState([]);
    const [run, setRun] = React.useState(null);
    const [runId, setRunId] = React.useState("");
    useCold();
    const candidates = store.variants.filter((v) => v.mode !== "baseline");
    const selected = picked.length ? picked : candidates.map((v) => v.id);
    const doRun = async () => {
        setBusy(true);
        try {
            const json = await api("POST", "/run", { variantIds: selected });
            if (json?.ok) {
                setRun(json.run);
                setRunId(json.run.id);
            }
        }
        finally {
            setBusy(false);
        }
    };
    const loadRun = async (id) => {
        const json = await fetch(`${ROUTE}/runs?id=${encodeURIComponent(id)}`, { cache: "no-store" }).then((r) => r.json());
        if (json?.ok) {
            setRun(json.run);
            setRunId(id);
        }
    };
    return h("div", { className: "dshTs" }, h("div", { className: "dshTs-card" }, h("div", { className: "dshTs-head" }, h("div", { className: "dshTs-h" }, t("🪨 试金石", "🪨 Touchstone")), h("span", { className: "dshTs-sub" }, "dsh-touchstone"), h("div", { className: "dshTs-grow" }), h("button", { className: "dshTs-btn", onClick: () => void refresh() }, t("刷新", "Refresh"))), h("div", { className: "dshTs-sub", style: { marginTop: 4 } }, t(`改一版，到底变好没有？—— 同一批用例，分别按「现状」和「候选」各跑一次，打分、对账；好就留，不好就撤。（跑测会调用模型，当前用：${store.provider || "?"} / ${store.model || "?"}）`, `Did the change actually help? Run the same cases against current and each candidate, score them, and read the report — keep it if better, revert if not. (A run calls the model; using ${store.provider || "?"} / ${store.model || "?"}.)`)), h("div", { className: "dshTs-row", style: { marginTop: 10 } }, h("span", { className: "dshTs-sub" }, t("候选：", "Candidates:")), candidates.length === 0 ? h("span", { className: "dshTs-sub" }, t("（还没有候选——先在下面「候选方案」里建一个）", "(none yet — add one under Candidates below)")) : null, ...candidates.map((v) => h("label", { key: v.id, className: "dshTs-row", style: { gap: 5 } }, h("input", { type: "checkbox", checked: selected.includes(v.id), onChange: (e) => setPicked(e.target.checked ? [...selected, v.id] : selected.filter((x) => x !== v.id)) }), h("span", { className: "dshTs-sub" }, v.name))), h("button", { className: "dshTs-btn dshTs-btn--go", disabled: busy || !candidates.length, onClick: () => void doRun() }, busy ? t("跑着呢…", "Running…") : t("跑一遍", "Run")))), h("div", { className: "dshTs-card" }, h("div", { className: "dshTs-head" }, h("div", { className: "dshTs-h" }, t("金标准用例", "Golden cases")), h("div", { className: "dshTs-grow" }), h("button", { className: "dshTs-btn", onClick: () => void api("POST", "/cases", { name: "", prompt: "", checks: [] }) }, t("+ 加一条用例", "+ Add a case"))), h("div", { className: "dshTs-sub", style: { marginTop: 4 } }, t("写一句你希望 agent 稳得住的问题，再挂上检查项。最省事、最可复现的是「必须包含」。", "Write a question you want the agent to stay solid on, then attach checks. The cheapest and most reproducible kind is 'must contain'.")), store.cases.length === 0 ? h("div", { className: "dshTs-empty" }, t("还没有用例。点右上角「+ 加一条用例」——先想一个你老被坑的场景，把它写成一句话。", "No cases yet. Click '+ Add a case' — start from a scenario that keeps tripping you up, and write it as one sentence.")) : null, ...store.cases.map((c) => h(CaseCard, { key: c.id, testCase: c }))), h("div", { className: "dshTs-card" }, h("div", { className: "dshTs-head" }, h("div", { className: "dshTs-h" }, t("候选方案", "Candidates")), h("div", { className: "dshTs-grow" }), h("button", { className: "dshTs-btn", onClick: () => void api("POST", "/variants", { name: t("新候选", "New candidate"), mode: "append", systemText: "" }) }, t("+ 加一个候选", "+ Add a candidate"))), h("div", { className: "dshTs-sub", style: { marginTop: 4 } }, t("一份候选 = 一条你想加的家规、或一段想换掉的提示词。每个候选都和对照「现状（不改）」比。", "A candidate is a house rule you want to add, or a prompt you want to swap. Each is compared against the control, 'Current (no change)'.")), ...store.variants.map((v) => h(VariantCard, { key: v.id, variant: v }))), h("div", { className: "dshTs-card" }, h("div", { className: "dshTs-head" }, h("div", { className: "dshTs-h" }, t("对账", "Report")), h("div", { className: "dshTs-grow" }), store.runs.length ? h("select", { className: "dshTs-sel", value: runId, onChange: (e) => void loadRun(e.target.value) }, h("option", { value: "" }, t("选一次跑测…", "Pick a run…")), ...store.runs.map((r) => h("option", { key: r.id, value: r.id }, `${clock(r.at)} · ${r.label}`))) : null), run ? h(ReportView, { run }) : h("div", { className: "dshTs-empty" }, t("跑完之后，这里会给出逐条用例的「改动前 → 改动后」，以及一句整体结论。", "Once you run, this shows each case's before → after and an overall verdict."))));
}
function apply(ctx) {
    ensureStyle();
    ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "touchstone", order: 28, label: () => t("试金石", "Touchstone"), inject: () => ({}) }, TouchstonePanel));
}


		return module.exports;
	}
});

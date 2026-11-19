// Разбивка контекста сессии Codex по категориям, как /context у Claude.
// Codex такой разбивки не отдаёт: собираем то, что модель видит сейчас (история после последнего сжатия,
// описания инструментов, системный промпт), оцениваем размер каждой части и масштабируем к точному
// input_tokens последнего хода. Без импортов: этот же файл гоняется на сервере через `node -e`.
// Использование: node codex-context.mjs <rollout.jsonl>  →  JSON в stdout.
import fs from "node:fs";
import readline from "node:readline";

const file = process.argv.at(-1);
// ponytail: оценка ~4 символа на токен (кириллица плотнее, но доли выравнивает масштаб к точному итогу).
const est = (s) => Math.ceil((typeof s === "string" ? s.length : JSON.stringify(s ?? "").length) / 4);
const IMAGE = 1500;

let meta = null, history = [], usage = null;
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  const head = line.slice(0, 160);
  if (head.includes('"type":"session_meta"')) { try { meta = JSON.parse(line).payload; } catch {} }
  else if (head.includes('"type":"compacted"')) { try { history = [...(JSON.parse(line).payload.replacement_history ?? [])]; } catch {} }
  else if (head.includes('"type":"response_item"')) { try { history.push(JSON.parse(line).payload); } catch {} }
  else if (line.includes('"last_token_usage"')) { try { usage = JSON.parse(line).payload.info; } catch {} }
}

const cats = {}, mcp = {}, memory = [], skills = [], prompt = {}, tools = {}, heavy = [];
const add = (cat, n) => { cats[cat] = (cats[cat] ?? 0) + n; };
const part = (name, n) => { prompt[name] = (prompt[name] ?? 0) + n; add("System prompt", n); };

const calls = {};
// Рассуждения прошлых ходов API в контекст не возвращает: копим только с последнего сообщения человека.
let reasoning = 0;
for (const it of history) {
  const t = it?.type;
  if (t === "additional_tools") {
    for (const ns of it.tools ?? []) {
      const n = est(ns);
      if (/^mcp__/.test(ns.name ?? "")) { add("MCP tools", n); mcp[ns.name.replace(/^mcp__/, "")] = (mcp[ns.name.replace(/^mcp__/, "")] ?? 0) + n; }
      else { add("System tools", n); tools[ns.name ?? "functions"] = (tools[ns.name ?? "functions"] ?? 0) + n; }
    }
  } else if (t === "message") {
    for (const c of it.content ?? []) {
      if (c.type === "input_image") { add("Images", IMAGE); continue; }
      const tx = c.text ?? "", n = est(tx);
      if (it.role === "developer") {
        const tag = tx.match(/^\s*<([a-z_\-]+)>/)?.[1];
        if (tag === "skills_instructions") {
          add("Skills", n);
          for (const m of tx.matchAll(/^- ([^:\n]+): (.*)$/gm)) skills.push({ name: m[1].trim(), tokens: est(m[0]) });
        } else part(tag ?? (/^You are Codex/.test(tx) ? "Инструкции Codex" : "Прочие инструкции"), n);
      } else if (it.role === "user" && /^# AGENTS\.md instructions for /.test(tx)) {
        add("Memory files", n); memory.push({ path: tx.match(/^# AGENTS\.md instructions for (.+)$/m)?.[1] ?? "AGENTS.md", tokens: n });
      } else if (it.role === "user" && /^\s*<environment_context>/.test(tx)) part("environment_context", n);
      else { add("Messages", n); if (it.role === "user") reasoning = 0; }
    }
  } else if (t === "function_call" || t === "custom_tool_call") {
    const n = est(it.arguments ?? it.input ?? ""); add("Tool calls", n);
    calls[it.call_id] = { name: [it.namespace, it.name].filter(Boolean).join("."), tokens: n, arg: String(it.arguments ?? it.input ?? "").replace(/\s+/g, " ").slice(0, 80) };
  } else if (t === "function_call_output" || t === "custom_tool_call_output") {
    const out = it.output, imgs = Array.isArray(out) ? out.filter((x) => x.type === "input_image").length : 0;
    const n = est(Array.isArray(out) ? out.filter((x) => x.type !== "input_image").map((x) => x.text ?? "").join("") : out) + imgs * IMAGE;
    add("Tool calls", n);
    const c = calls[it.call_id];
    heavy.push({ name: c?.name ?? it.name ?? "инструмент", arg: c?.arg ?? "", tokens: n + (c?.tokens ?? 0) });
  } else if (t === "reasoning") reasoning += Math.ceil(((it.encrypted_content ?? "").length * 3) / 4 / 4) + est(it.summary ?? []);
  else if (t === "compaction") add("Compacted history", Math.ceil(((it.encrypted_content ?? "").length * 3) / 4 / 4));
  else if (t) add("Other", est(it));
}

if (reasoning) add("Reasoning", reasoning);

// Базовые инструкции из session_meta Codex обычно дублирует первым сообщением developer: считаем один раз.
const base = meta?.base_instructions?.text ?? meta?.base_instructions;
if (typeof base === "string" && !prompt["Инструкции Codex"]) part("Инструкции Codex", est(base));

// Масштаб к точному итогу последнего хода: доли из оценки, сумма из счётчика Codex.
const last = usage?.last_token_usage, window = usage?.model_context_window ?? meta?.context_window ?? null;
const sum = Object.values(cats).reduce((a, b) => a + b, 0) || 1;
// Оценка больше итога — сжимаем доли; меньше — остаток показываем отдельно (Codex на сервере не пишет описания инструментов).
const k = last?.input_tokens ? Math.min(1, last.input_tokens / sum) : 1;
if (last?.input_tokens > sum) cats.Unaccounted = last.input_tokens - sum;
const sc = (n) => Math.round(n * k);
const used = last?.input_tokens ? last.input_tokens + (last.output_tokens ?? 0) : Math.round(sum);
const list = Object.entries(cats).map(([name, n]) => ({ name, tokens: sc(n) })).sort((a, b) => b.tokens - a.tokens);
if (last?.output_tokens) list.push({ name: "Last reply", tokens: last.output_tokens });
if (window) list.push({ name: "Free space", tokens: Math.max(0, window - used) });
const byTokens = (o) => Object.entries(o).map(([name, n]) => ({ name, tokens: sc(n) })).sort((a, b) => b.tokens - a.tokens);
process.stdout.write(JSON.stringify({
  at: Date.now(), estimated: true, used, window, cats: list,
  mcp: byTokens(mcp),
  tools: byTokens(tools), prompt: byTokens(prompt),
  memory: memory.map((m) => ({ type: "AGENTS.md", path: m.path, tokens: sc(m.tokens) })),
  skills: skills.map((s) => ({ name: s.name, source: "", tokens: sc(s.tokens) })).sort((a, b) => b.tokens - a.tokens),
  heavy: heavy.sort((a, b) => b.tokens - a.tokens).slice(0, 10).map((h) => ({ ...h, tokens: sc(h.tokens) })),
  cached: last?.cached_input_tokens ?? 0, session: usage?.total_token_usage?.total_tokens ?? 0,
}));

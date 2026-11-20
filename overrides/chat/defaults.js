// Модель новой сессии по агенту (окно настроек панели, ygg-settings): data/herdr-chat/settings.json → <агент>.model,
// «провайдер/id» как в выборе модели. Список моделей для настроек каждый чат кладёт в data/herdr-chat/models.json:
// его отдаёт сам агент, руками ничего не поддерживается (пользователь, 21.11.2026).
import { readTextFile, writeTextFile } from "herdr";
import { stateDir } from "./connection.js";

const read = async (p) => { try { return JSON.parse((await readTextFile(p)) ?? "{}") ?? {}; } catch { return {}; } };
const SETTINGS = () => `${stateDir()}/settings.json`;
const MODELS = () => `${stateDir()}/models.json`;

export async function rememberModels(agent, models) {
  const list = (models ?? []).filter((m) => m?.provider && m?.id && !/^default$/i.test(m.id)).map((m) => ({ value: `${m.provider}/${m.id}`, label: m.name || m.id }));
  if (!agent || !list.length) return;
  const all = await read(MODELS());
  if (JSON.stringify(all[agent]) === JSON.stringify(list)) return;
  all[agent] = list;
  await writeTextFile(MODELS(), JSON.stringify(all, null, 2));
}

export async function defaultModel(agent) {
  const m = (await read(SETTINGS()))?.[agent]?.model;
  return typeof m === "string" && m.includes("/") ? m : null;
}

// Один раз на копию чата, когда хост ответил: список моделей в кэш, а новой сессии (без файла и сообщений) — модель
// по умолчанию, если она задана и не совпадает с текущей.
export function applyDefaults(v, cx) {
  const s = v.store.state;
  if (v.sub || v.defaultsDone || !v.store.loaded || !s.model) return;
  v.defaultsDone = true;
  const agent = v.providerId();
  const fresh = !v.store.items.length && !v.conn?.o?.session; // у новой сессии хост сразу заводит свой файл, по нему не судим
  cx.spawn(async (cx) => {
    try { rememberModels(agent, (await v.req("models", {}, cx))?.models); } catch {}
    if (!fresh) return;
    const want = await defaultModel(agent);
    if (!want || want === `${s.model.provider}/${s.model.id}`) return;
    const i = want.indexOf("/");
    v.fire("set_model", { provider: want.slice(0, i), modelId: want.slice(i + 1) }, cx);
  });
}

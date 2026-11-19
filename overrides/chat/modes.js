// Общий вид режимов подтверждения для всех агентов (как в окне «Новая сессия», мод ygg-new):
// id режима у агента → общий ключ, название, пояснение, значок. Незнакомый id (custom у Codex) — как назвал агент.
const LOOK = {
  ask: { icon: "hand", name: "Спрашивать", tip: "Спрашивает разрешение перед правками и командами" },
  edits: { icon: "file-pen", name: "Принимать правки", tip: "Правит файлы сам, перед командами спрашивает" },
  auto: { icon: "shield-check", name: "Авто", tip: "Решает сам по каждому действию, спрашивает только про рискованное" },
  review: { icon: "user-check", name: "Авто с ревьюером", tip: "Как Авто, но на запросы разрешений отвечает агент-ревьюер" },
  read: { icon: "eye", name: "Только чтение", tip: "Читает файлы, перед правками и командами спрашивает" },
  plan: { icon: "list-checks", name: "План", tip: "Только читает и предлагает план, без правок" },
  full: { icon: "shield-alert", name: "Полный доступ", tip: "Без песочницы и без вопросов: любые файлы и интернет", color: "#fea362" },
};
const KEY = { default: "ask", untrusted: "ask", acceptEdits: "edits", auto: "auto", "auto-review": "review", "read-only": "read", plan: "plan", full: "full", bypassPermissions: "full" };
const ORDER = Object.keys(LOOK);

export function modeLook(m) {
  const key = KEY[m?.id];
  return key ? { id: m.id, key, ...LOOK[key] } : { id: m?.id, key: m?.id, icon: "shield", name: m?.label ?? m?.id ?? "Режим", tip: m?.description ?? "" };
}
export function modeList(modes) {
  const rank = (m) => { const i = ORDER.indexOf(KEY[m.id]); return i < 0 ? ORDER.length : i; };
  return [...modes].sort((a, b) => rank(a) - rank(b)).map(modeLook);
}

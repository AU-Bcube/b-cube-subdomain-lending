const dateTime = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });
const date = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" });

export function formatDateTime(ms: number | null | undefined): string {
  return ms == null ? "-" : dateTime.format(ms);
}

export function formatDate(ms: number | null | undefined): string {
  return ms == null ? "-" : date.format(ms);
}

/** `<input type="date">` 값(YYYY-MM-DD)을 로컬 자정 기준 ms로. 비어 있으면 undefined. */
export function dateInputToMs(value: string, addDays = 0): number | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + addDays);
  return d.getTime();
}

/** 남은 일수 (올림). 지났으면 0. */
export function daysUntil(ms: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((ms - now) / (24 * 60 * 60 * 1000)));
}

/**
 * 冲突摘要：对比本窗口持有的旧记录与库中最新记录，
 * 产出「字段名：旧值 → 新值」的可读行，供冲突对话框展示。
 */

export interface DiffField<T> {
  key: keyof T & string;
  label: string;
  format?: (value: unknown) => string;
}

const DEFAULT_FORMAT = (v: unknown) => {
  if (v === undefined || v === null || v === '') return '（空）';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

export function diffRecords<T extends object>(
  before: T,
  after: T,
  fields: DiffField<T>[],
): string[] {
  const lines: string[] = [];
  for (const field of fields) {
    const oldVal = (before as Record<string, unknown>)[field.key];
    const newVal = (after as Record<string, unknown>)[field.key];
    const fmt = field.format ?? DEFAULT_FORMAT;
    if (fmt(oldVal) !== fmt(newVal)) {
      lines.push(`${field.label}：${fmt(oldVal)} → ${fmt(newVal)}`);
    }
  }
  return lines;
}

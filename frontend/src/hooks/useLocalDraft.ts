import { useCallback, useEffect, useRef, useState } from 'react';

const KEY_PREFIX = 'gbmeteorite:draft:';

export interface UseLocalDraftOptions {
  /**
   * 附加维度（如样本 id）。维度变化时自动丢弃上一维度的草稿，
   * 避免样本详情页从 A 样本切到 B 样本时带入 A 的切片录入草稿。
   */
  resetKey?: string;
}

/**
 * 表单草稿落 localStorage、切页恢复、提交成功后清理。
 * 被 /samples/new、/analysis 与 /samples/:id 就地表单消费。
 *
 * 关键约定：只有真正写入成功后调用方才应调用 clear()；
 * 校验失败、编号冲突、乐观锁落后、IndexedDB 异常等情况下草稿原样保留，
 * 关掉窗口重开仍可恢复接着录。
 */
export function useLocalDraft<T extends object>(
  draftKey: string,
  initialValue: T,
  options?: UseLocalDraftOptions,
) {
  const storageKey = KEY_PREFIX + draftKey;
  const [value, setValue] = useState<T>(() => readDraft<T>(storageKey) ?? initialValue);
  const [restored, setRestored] = useState<boolean>(() => readDraft<T>(storageKey) !== null);
  const initialRef = useRef(initialValue);
  const resetKey = options?.resetKey;
  const prevResetKey = useRef(resetKey);

  // resetKey（如详情页样本 id）变化：回到初始值并清掉旧维度草稿
  useEffect(() => {
    if (prevResetKey.current === resetKey) return;
    prevResetKey.current = resetKey;
    clearDraft(storageKey);
    setValue(initialRef.current);
    setRestored(false);
  }, [resetKey, storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* 隐私模式下写入失败时静默降级 */
    }
  }, [storageKey, value]);

  const patch = useCallback((p: Partial<T>) => {
    setValue((prev) => ({ ...prev, ...p }));
    setRestored(false);
  }, []);

  const reset = useCallback(() => {
    setValue(initialRef.current);
    setRestored(false);
    clearDraft(storageKey);
  }, [storageKey]);

  const clear = useCallback(() => {
    clearDraft(storageKey);
  }, [storageKey]);

  return { value, setValue, patch, reset, clear, restored, storageKey };
}

export function readDraft<T>(storageKey: string): T | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function clearDraft(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* ignore */
  }
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { getTabId, isTabAlive } from '../utils/tab';

const KEY_PREFIX = 'gbmeteorite:draft:';

interface DraftSlot<T> {
  /** 写入该槽的窗口 */
  tab: string;
  updatedAt: number;
  data: T;
}

/**
 * 表单草稿（被 /samples/new、/analysis 与样本详情的就地表单消费）。
 *
 * 多窗口协作策略：
 *  - 每个窗口写各自的槽位 `gbmeteorite:draft:<key>:<tabId>`，
 *    两人同时录同一类表单也不会把对方的草稿覆盖掉；
 *  - 窗口仍开着时只读本窗口槽；本窗口无槽时，若有其它窗口
 *    关闭后遗留（心跳过期）的未提交草稿，则接续最新的一份继续录；
 *  - 接续后原遗留槽并入本窗口槽，重开页面仍是这份内容；
 *  - 写入失败（编号冲突 / 记录已被对方改等）时槽位原样保留，
 *    刷新或重开页面仍可恢复；只有提交成功后才由 commit() 清掉。
 */
export function useLocalDraft<T extends object>(draftKey: string, initialValue: T) {
  const storageKey = KEY_PREFIX + draftKey;
  const tabId = getTabId();
  const slotKey = `${storageKey}:${tabId}`;

  const adopt = useCallback(
    (): { data: T; source: 'self' | 'adopted' | 'legacy' | null; orphanKey?: string } => {
      const mine = readSlot<T>(slotKey);
      if (mine) return { data: mergeDraft(initialValue, mine.data), source: 'self' };

      // 接续已关闭窗口遗留的未提交草稿（心跳已过期的槽位）
      const orphan = latestOrphanSlot<T>(storageKey, tabId);
      if (orphan) {
        // 原遗留槽清掉，内容改由本窗口槽接管，避免下次重复接续
        clearDraft(orphan.slotKey);
        return {
          data: mergeDraft(initialValue, orphan.slot.data),
          source: 'adopted',
          orphanKey: orphan.slotKey,
        };
      }

      // 兼容旧版本共用一个 localStorage 键的草稿；接续后清掉，防止重复恢复
      const legacy = readDraft<T>(storageKey);
      if (legacy !== null && !isEmptyDraft(initialValue, legacy)) {
        clearDraft(storageKey);
        return { data: mergeDraft(initialValue, legacy), source: 'legacy' };
      }
      return { source: null, data: initialValue };
    },
    // initialValue 为组件 useMemo 产物，挂载后保持稳定即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storageKey, slotKey, tabId],
  );

  const initial0 = useRef(adopt());
  const [value, setValue] = useState<T>(initial0.current.data);
  const [restored, setRestored] = useState<boolean>(initial0.current.source !== null);
  const [restoredSource, setRestoredSource] = useState<string | null>(initial0.current.source);
  const initialRef = useRef(initialValue);
  initialRef.current = initialValue;

  useEffect(() => {
    try {
      // 内容回到初始态时不落槽，避免留下一堆空槽干扰接续判断
      if (sameJson(value, initialRef.current)) {
        localStorage.removeItem(slotKey);
      } else {
        const slot: DraftSlot<T> = { tab: tabId, updatedAt: Date.now(), data: value };
        localStorage.setItem(slotKey, JSON.stringify(slot));
      }
    } catch {
      /* 隐私模式下写入失败时静默降级 */
    }
  }, [slotKey, tabId, value]);

  const patch = useCallback((p: Partial<T>) => {
    setValue((prev) => ({ ...prev, ...p }));
    setRestored(false);
    setRestoredSource(null);
  }, []);

  /** 提交失败后的现场保留（状态与槽位都不动） */
  const keep = useCallback(() => {
    setRestored(false);
  }, []);

  const reset = useCallback(() => {
    setValue(initialRef.current);
    setRestored(false);
    setRestoredSource(null);
    clearDraft(slotKey);
  }, [slotKey]);

  /** 保存成功后调用：清掉本窗口槽位并回到初始表单 */
  const commit = useCallback(() => {
    clearDraft(slotKey);
    setValue(initialRef.current);
    setRestored(false);
    setRestoredSource(null);
  }, [slotKey]);

  const clear = useCallback(() => {
    clearDraft(slotKey);
  }, [slotKey]);

  return {
    value,
    setValue,
    patch,
    reset,
    commit,
    clear,
    keep,
    restored,
    restoredSource,
    storageKey,
  };
}

function readSlot<T>(slotKey: string): DraftSlot<T> | null {
  try {
    const raw = localStorage.getItem(slotKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftSlot<T>;
    if (!parsed || typeof parsed !== 'object' || parsed.data === undefined) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 找一份其它窗口关闭后遗留的、内容非空的最新草稿；顺手清空同 key 的空槽 */
function latestOrphanSlot<T>(
  storageKey: string,
  selfTab: string,
): { slot: DraftSlot<T>; slotKey: string } | null {
  let best: { slot: DraftSlot<T>; slotKey: string } | null = null;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(`${storageKey}:`) || key === `${storageKey}:${selfTab}`) continue;
      const slot = readSlot<T>(key);
      if (!slot || slot.tab === selfTab) continue;
      if (isTabAlive(slot.tab)) continue; // 对方窗口还开着，不碰人家的草稿
      // 槽内容与初始态相同，说明没有未提交内容，清掉即可
      if (isEmptyDraftInternal(slot.data)) {
        localStorage.removeItem(key);
        continue;
      }
      if (!best || slot.updatedAt > best.slot.updatedAt) best = { slot, slotKey: key };
    }
  } catch {
    /* localStorage 不可用时忽略 */
  }
  return best;
}

/** 用旧草稿覆盖时，补齐初始态里新增的字段（表单结构迭代后的安全网） */
function mergeDraft<T extends object>(base: T, data: unknown): T {
  if (!data || typeof data !== 'object') return base;
  return { ...base, ...(data as Partial<T>) };
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function isEmptyDraftInternal(data: unknown): boolean {
  if (!data || typeof data !== 'object') return true;
  return Object.keys(data as object).length === 0;
}

function isEmptyDraft<T>(initial: T, data: T): boolean {
  return sameJson(data, initial) || isEmptyDraftInternal(data);
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

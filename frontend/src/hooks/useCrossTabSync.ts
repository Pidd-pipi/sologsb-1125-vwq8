import { useEffect } from 'react';
import { useSampleStore } from '../stores/sampleStore';
import { subscribeChanges } from '../db/sync';

/**
 * 跨窗口数据同步：
 *  1. 另一个窗口写入并广播后，本窗口静默重拉四张表，样本总览、样本详情、
 *     切片库、分析检测、发现地分布以及所有 useMemo 统计立即跟随更新；
 *  2. 窗口重新可见 / 重新聚焦时再补拉一次，兜底 BroadcastChannel 与
 *     storage 事件都错过的极端情况。
 *
 * 短时间内多条通知合并为一次重拉。
 */
export function useCrossTabSync(): void {
  const refresh = useSampleStore((s) => s.refresh);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 120);
    };

    const unsubscribe = subscribeChanges(schedule);

    const onVisible = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', schedule);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', schedule);
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);
}

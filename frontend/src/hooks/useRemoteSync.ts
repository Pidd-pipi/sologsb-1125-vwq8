import { useEffect, useRef } from 'react';
import { useSampleStore } from '../stores/sampleStore';
import { subscribeRemoteChanges, type ChangeMessage } from '../utils/syncBus';
import { useToastStore } from '../stores/uiStore';

const NOTIFY_THROTTLE_MS = 1500;

const ACTION_LABEL: Record<ChangeMessage['action'], string> = {
  add: '登记',
  update: '修改',
  delete: '删除',
  refresh: '更新',
};

const TABLE_LABEL: Record<ChangeMessage['table'], string> = {
  samples: '样本',
  finds: '发现地',
  sections: '切片',
  analysis: '检测记录',
  all: '档案',
};

/**
 * 订阅其它窗口的数据变更：
 *  - 变更到达后重查 IndexedDB 并整体替换 zustand 快照，
 *    样本总览 / 详情 / 切片库 / 分析检测 / 发现地分布及其统计随之重算；
 *  - 突发多条消息合并为一次重查，提示条按时间窗节流，避免打扰；
 *  - 订阅不依赖 loaded：首屏加载期间到达的变更先记 dirty，
 *    加载完成后补一次重查，杜绝「首次读取与订阅之间」的漏消息窗口。
 */
export function useRemoteSync() {
  const loaded = useSampleStore((s) => s.loaded);
  const pendingTimer = useRef<number | null>(null);
  const pendingMsg = useRef<ChangeMessage | null>(null);
  const inflight = useRef(false);
  const dirtyDuringLoad = useRef(false);
  const lastNotifyAt = useRef(0);

  useEffect(() => {
    const flush = async () => {
      pendingTimer.current = null;
      const msg = pendingMsg.current;
      pendingMsg.current = null;
      if (!msg) return;
      if (inflight.current) {
        // 上一轮重查未结束，稍后再试，避免漏掉窗口内最后一条
        pendingMsg.current = msg;
        pendingTimer.current = window.setTimeout(flush, 60);
        return;
      }
      inflight.current = true;
      try {
        await useSampleStore.getState().refreshFromRemote();
        const now = Date.now();
        if (now - lastNotifyAt.current >= NOTIFY_THROTTLE_MS) {
          lastNotifyAt.current = now;
          useToastStore.getState().notify(
            `另一个窗口${ACTION_LABEL[msg.action]}了${TABLE_LABEL[msg.table]}，本页数据已同步刷新`,
            'info',
          );
        }
      } catch {
        // 重查失败保留当前快照，下一条变更到来时自然重试
        pendingMsg.current = msg;
      } finally {
        inflight.current = false;
      }
    };

    // 挂载即订阅（早于首屏 loadAll 完成），任何窗口写入都不会漏
    const unsubscribe = subscribeRemoteChanges((msg) => {
      if (!useSampleStore.getState().loaded) {
        dirtyDuringLoad.current = true;
        return;
      }
      pendingMsg.current = msg; // 合并窗口内连续变更，只按最后一条重查
      if (pendingTimer.current === null) {
        pendingTimer.current = window.setTimeout(flush, 120);
      }
    });

    return () => {
      unsubscribe();
      if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    };
  }, []);

  // 首屏数据就绪后：若加载期间已有别的窗口写入，补一次重查
  useEffect(() => {
    if (!loaded) return;
    if (dirtyDuringLoad.current) {
      dirtyDuringLoad.current = false;
      void useSampleStore.getState().refreshFromRemote();
    }
  }, [loaded]);
}

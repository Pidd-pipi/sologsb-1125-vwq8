/**
 * 跨窗口数据变更通知。
 *
 * 标本室常有两个窗口同时编目：A 窗口写入 IndexedDB 后广播一条变更，
 * B 窗口收到后静默重拉本地库，使样本总览 / 详情 / 切片库 / 分析检测 /
 * 发现地分布及其统计立即跟随更新，而不必刷新页面。
 *
 * 主通道是 BroadcastChannel；在不支持的浏览器上回落到 localStorage 的
 * storage 事件（storage 事件只在其他窗口触发，天然不会自收）。
 */

export type ChangeTable = 'samples' | 'finds' | 'sections' | 'analysis' | 'all';

export interface DataChangeMessage {
  /** 发送窗口标识，用于忽略自己发出的消息 */
  tabId: string;
  /** 本次写入触及的表（删除样本会级联到全部表） */
  tables: ChangeTable[];
  at: number;
}

const CHANNEL_NAME = 'gbmeteorite-db-changes';
const FALLBACK_KEY = 'gbmeteorite:changes';

function isDataChangeMessage(v: unknown): v is DataChangeMessage {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.tabId === 'string' &&
    typeof m.at === 'number' &&
    Array.isArray(m.tables) &&
    m.tables.every((t) => typeof t === 'string')
  );
}

/** 每个窗口一个稳定标识 */
export const TAB_ID = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channel = null;
    }
  }
  return channel;
}

/** 通知其他窗口：本窗口已写入指定表 */
export function broadcastChange(tables: ChangeTable[]): void {
  const message: DataChangeMessage = { tabId: TAB_ID, tables, at: Date.now() };

  const bc = getChannel();
  if (bc) {
    try {
      bc.postMessage(message);
      return;
    } catch {
      /* 落到 localStorage 兜底 */
    }
  }

  try {
    // 同窗口收不到 storage 事件，只会通知其他窗口
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(message));
  } catch {
    /* 隐私模式下静默降级：其他窗口可在重新聚焦时按可见性事件补拉 */
  }
}

/**
 * 订阅其他窗口的数据变更。返回退订函数。
 * 已经见过的消息会去重，避免双通道同时收到同一条通知。
 */
export function subscribeChanges(handler: (message: DataChangeMessage) => void): () => void {
  const seen = new Set<number>();
  const deliver = (raw: unknown) => {
    if (!isDataChangeMessage(raw)) return;
    if (raw.tabId === TAB_ID || seen.has(raw.at)) return;
    seen.add(raw.at);
    if (seen.size > 100) seen.clear();
    handler(raw);
  };

  const bc = getChannel();
  const onMessage = (ev: MessageEvent) => deliver(ev.data);
  bc?.addEventListener('message', onMessage);

  const onStorage = (ev: StorageEvent) => {
    if (ev.key !== FALLBACK_KEY || !ev.newValue) return;
    try {
      deliver(JSON.parse(ev.newValue));
    } catch {
      /* 忽略无法解析的兜底消息 */
    }
  };
  window.addEventListener('storage', onStorage);

  return () => {
    bc?.removeEventListener('message', onMessage);
    window.removeEventListener('storage', onStorage);
  };
}

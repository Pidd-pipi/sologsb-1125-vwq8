/**
 * 跨窗口数据变更总线。
 *
 * 主通道为 BroadcastChannel（同源各 tab 间实时收发）；
 * 浏览器不支持时降级为 localStorage 的 storage 事件（其它窗口写入才会触发）。
 *
 * 只负责通知「库已被改」，具体数据由收到方自己重新查 IndexedDB，
 * 因此消息丢一两条也没关系——后续写入仍会再次触发刷新。
 */
import { getTabId } from './tab';

export type ChangeTable = 'samples' | 'finds' | 'sections' | 'analysis' | 'all';
export type ChangeAction = 'add' | 'update' | 'delete' | 'refresh';

export interface ChangeMessage {
  /** 发送窗口 id，用于过滤自己的消息 */
  origin: string;
  action: ChangeAction;
  table: ChangeTable;
  /** 受影响记录 id（批量操作可省略） */
  id?: string;
  /** 与本窗口同批次写入的表，收到方可据此判断联动范围（仅提示用） */
  related?: ChangeTable[];
  at: number;
}

const CHANNEL_NAME = 'gbmeteorite-db-changes';
const FALLBACK_KEY = 'gbmeteorite:change-ping';

type Listener = (msg: ChangeMessage) => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;
let started = false;

function dispatch(msg: ChangeMessage): void {
  if (msg.origin === getTabId()) return;
  listeners.forEach((l) => l(msg));
}

/** 订阅其它窗口的数据变更通知，返回退订函数 */
export function subscribeRemoteChanges(listener: Listener): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function ensureStarted(): void {
  if (started) return;
  started = true;

  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<ChangeMessage>) => {
      if (event.data) dispatch(event.data);
    };
  } else if (typeof window !== 'undefined' && window.addEventListener) {
    // 降级：本窗口不会收到自己的 storage 事件，天然只收其它窗口
    window.addEventListener('storage', (e) => {
      if (e.key !== FALLBACK_KEY || !e.newValue) return;
      try {
        dispatch(JSON.parse(e.newValue) as ChangeMessage);
      } catch {
        /* 忽略无法解析的降级消息 */
      }
    });
  }
}

/**
 * 写完库后广播一条变更通知（其它窗口据此重查）。
 * origin 一般自动取本窗口 id，测试可显式指定。
 */
export function publishChange(
  msg: Omit<ChangeMessage, 'origin' | 'at'> & { origin?: string },
): void {
  const full: ChangeMessage = { origin: getTabId(), at: Date.now(), ...msg };
  try {
    if (channel) {
      channel.postMessage(full);
    } else if (typeof localStorage !== 'undefined') {
      // storage 事件只在值变化时触发，附上时间戳保证连续操作也能送达
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(full));
    }
  } catch {
    /* 广播失败不影响本地已落库的数据 */
  }
  // 进程内桥：同页其它订阅点（如测试与未来的同页多工作区）也能感知；
  // dispatch 内仍按 origin 过滤，自己发的不会回到自己
  dispatch(full);
}

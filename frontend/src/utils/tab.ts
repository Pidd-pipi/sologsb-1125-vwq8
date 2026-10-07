/**
 * 浏览器窗口（tab）身份与会话心跳。
 * 用于跨窗口同步时区分消息来源，以及草稿分槽恢复。
 */

const TAB_ID_KEY = 'gbmeteorite:tab-id';
const HEARTBEAT_KEY = 'gbmeteorite:tab-heartbeats';
const HEARTBEAT_TTL = 12_000;
let cachedId: string | null = null;

/** 取本窗口稳定 id（sessionStorage 保活；隐私模式下降级为内存 id） */
export function getTabId(): string {
  if (cachedId) return cachedId;
  const fallback = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    let id = sessionStorage.getItem(TAB_ID_KEY);
    if (!id) {
      id = fallback;
      sessionStorage.setItem(TAB_ID_KEY, id);
    }
    cachedId = id;
  } catch {
    cachedId = fallback;
  }
  return cachedId;
}

/** 仅供测试：重置缓存的窗口身份 */
export function __resetTabIdForTest(id?: string): void {
  cachedId = id ?? null;
  if (id) {
    try {
      sessionStorage.setItem(TAB_ID_KEY, id);
    } catch {
      /* ignore */
    }
  }
}

function readBeats(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(HEARTBEAT_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function writeBeats(beats: Record<string, number>): void {
  try {
    localStorage.setItem(HEARTBEAT_KEY, JSON.stringify(beats));
  } catch {
    /* 隐私模式静默降级 */
  }
}

/** 登记一次本窗口心跳；顺带清理过期窗口的心跳 */
export function beat(): void {
  try {
    const now = Date.now();
    const beats = readBeats();
    for (const [id, at] of Object.entries(beats)) {
      if (now - at > HEARTBEAT_TTL * 2) delete beats[id];
    }
    beats[getTabId()] = now;
    writeBeats(beats);
  } catch {
    /* ignore */
  }
}

/** 判断某个窗口是否仍然开着（心跳未过期） */
export function isTabAlive(tabId: string): boolean {
  if (tabId === getTabId()) return true;
  const at = readBeats()[tabId];
  return typeof at === 'number' && Date.now() - at <= HEARTBEAT_TTL;
}

/** 启动心跳定时器，返回停止函数（挂在 AppShell） */
export function startHeartbeat(intervalMs = 5000): () => void {
  beat();
  const timer = window.setInterval(beat, intervalMs);
  return () => window.clearInterval(timer);
}

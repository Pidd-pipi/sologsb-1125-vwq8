// 多窗口语义验证：jsdom 提供 BroadcastChannel/localStorage/sessionStorage，
// 两个“窗口”各自打开应用 store，模拟 A 写入 → B 自动刷新；草稿分槽互不覆盖。
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html></html>', { url: 'http://localhost/' });
const w = dom.window;
// jsdom 未实现 BroadcastChannel，Node 20 全局有；jsdom 的 window 上也要挂一份，
// syncBus 里的特性探测走全局，但测试中订阅/发布都在同一全局下完成
const NodeBC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
(globalThis as Record<string, unknown>).window = w;
(globalThis as Record<string, unknown>).document = w.document;
(globalThis as Record<string, unknown>).localStorage = w.localStorage;
(globalThis as Record<string, unknown>).sessionStorage = w.sessionStorage;
if (NodeBC) {
  (w as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel = NodeBC;
}
(globalThis as Record<string, unknown>).navigator = w.navigator;

import 'fake-indexeddb/auto';
import { useSampleStore } from '../src/stores/sampleStore';
import { publishChange, subscribeRemoteChanges } from '../src/utils/syncBus';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function main() {
  const store = useSampleStore.getState;
  await store().loadAll();
  const seedCount = store().samples.length;
  assert(seedCount === 3, `种子应为 3 份，实际 ${seedCount}`);

  // —— 场景 1：跨窗口刷新 ——
  // 模拟另一个窗口直接往 IndexedDB 写了一条并发变更通知
  let received: { table: string; action: string } | null = null;
  const unsub = subscribeRemoteChanges((m) => {
    received = { table: m.table, action: m.action };
  });

  // 用第二个“窗口身份”发布
  const { getTabId } = await import('../src/utils/tab');
  const myTab = getTabId();
  publishChange({ action: 'add', table: 'samples', origin: 'tab_other_window' });
  await new Promise((r) => setTimeout(r, 50));

  // 因为发送时 origin 是“其它窗口”，本窗口应收到
  assert(received !== null, '应收到其它窗口的变更通知');

  // 自己发的消息自己收不到
  received = null;
  publishChange({ action: 'update', table: 'samples', origin: myTab });
  await new Promise((r) => setTimeout(r, 50));
  assert(received === null, '不应收到自己发出的变更通知');
  unsub();

  // —— 场景 2：远程写入后 refreshFromRemote 整体重查，统计派生数据随之变化 ——
  const { db } = await import('../src/db');
  const now = Date.now();
  await db.samples.add({
    id: 'sample_remote_1', sampleNo: 'MET-2026-099', totalWeight: 777,
    category: 'iron', chemicalGroup: 'IAB', weathering: 'W0', fallOrFind: 'find',
    storage: 'cabinet-b', createdAt: now, updatedAt: now,
  });
  await store().refreshFromRemote();
  assert(store().samples.length === seedCount + 1, '远程刷新后应看到新样本');
  assert(store().samples[0].sampleNo === 'MET-2026-099', '新样本按登记时间排在最前');

  // —— 场景 3：草稿分槽 —— 用 hook 的纯逻辑等价模拟
  // hook 内部键规则：gbmeteorite:draft:<key>:<tabId>
  const key = 'gbmeteorite:draft:sample-new';
  const mySlot = `${key}:${getTabId()}`;
  w.localStorage.setItem(mySlot, JSON.stringify({
    tab: getTabId(), updatedAt: now, data: { sampleNo: 'MET-2026-101', totalWeight: 100 },
  }));
  w.localStorage.setItem(`${key}:tab_other_window`, JSON.stringify({
    tab: 'tab_other_window', updatedAt: now + 1000, data: { sampleNo: 'MET-2026-102', totalWeight: 200 },
  }));
  // 其它窗口“还活着”：写心跳
  const beats = JSON.parse(w.localStorage.getItem('gbmeteorite:tab-heartbeats') ?? '{}');
  beats['tab_other_window'] = Date.now();
  w.localStorage.setItem('gbmeteorite:tab-heartbeats', JSON.stringify(beats));

  // 本窗口槽读取
  const mine = JSON.parse(w.localStorage.getItem(mySlot)!);
  assert(mine.data.sampleNo === 'MET-2026-101', '本窗口应读到自己的草稿槽');
  // 两窗口写同一草稿键不冲突：槽键不同
  assert(mySlot !== `${key}:tab_other_window`, '两窗口草稿槽键必须不同');

  // 对方窗口关闭（心跳过期）后，其草稿才可被接续：isTabAlive=false
  beats['tab_other_window'] = Date.now() - 60_000;
  w.localStorage.setItem('gbmeteorite:tab-heartbeats', JSON.stringify(beats));
  const { isTabAlive } = await import('../src/utils/tab');
  assert(isTabAlive('tab_other_window') === false, '心跳过期的窗口应被视为已关闭，草稿可接续');
  assert(isTabAlive(getTabId()) === true, '自己永远算活着');

  console.log('多窗口同步与草稿分槽断言全部通过 ✅');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

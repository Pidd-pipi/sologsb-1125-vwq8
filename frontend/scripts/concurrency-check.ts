// 节点级并发验证：fake-indexeddb 模拟 IndexedDB，直接驱动 store 动作
import 'fake-indexeddb/auto';
import { useSampleStore } from '../src/stores/sampleStore';
import { db, DuplicateNoError, StaleWriteError, RecordGoneError } from '../src/db';

// BroadcastChannel 在 node 中不存在，syncBus 已做存在性判断
// @ts-expect-error 测试无需真实定时器
globalThis.window ??= {
  setInterval: (fn: TimerHandler, ms: number) => setInterval(fn, ms),
  clearInterval: (t: number) => clearInterval(t),
  setTimeout: (fn: TimerHandler, ms: number) => setTimeout(fn, ms),
  addEventListener: () => {},
} as unknown as Window & typeof globalThis;

async function main() {
  const s = useSampleStore.getState;
  await s().loadAll();

  const baseSample = () => ({
    sampleNo: 'MET-2026-010',
    totalWeight: 500,
    category: 'chondrite' as const,
    chemicalGroup: 'H' as const,
    weathering: 'W1' as const,
    fallOrFind: 'find' as const,
    storage: 'cabinet-a' as const,
  });

  // 1. 同编号两次登记：第二次必须被 DuplicateNoError 拦下
  await s().registerSample(baseSample());
  let blocked = false;
  try {
    await s().registerSample({ ...baseSample(), totalWeight: 999 });
  } catch (e) {
    blocked = e instanceof DuplicateNoError;
  }
  console.assert(blocked, 'FAIL 同编号第二次登记应被撞号错误拦下');
  const dupRow = await db.samples.where('sampleNo').equals('MET-2026-010').toArray();
  console.assert(dupRow.length === 1 && dupRow[0].totalWeight === 500,
    'FAIL 撞号时第一条数据不能被第二条覆盖');

  // 2. 乐观锁：拿着旧 updatedAt 更新被拒，force 才能覆盖
  const [row] = dupRow;
  await db.samples.update(row.id, { note: '窗口A改的', updatedAt: Date.now() + 1000 });
  let stale = false;
  try {
    await s().updateSample(row.id, { note: '窗口B想覆盖' }, { expectedUpdatedAt: row.updatedAt });
  } catch (e) {
    stale = e instanceof StaleWriteError;
  }
  console.assert(stale, 'FAIL 旧版本保存应抛 StaleWriteError');
  const afterStale = await db.samples.get(row.id);
  console.assert(afterStale?.note === '窗口A改的', 'FAIL 冲突保存不能覆盖对方内容');

  // 拿最新版本后 force=true 可覆盖
  await s().updateSample(row.id, { note: '窗口B确认覆盖' }, {
    expectedUpdatedAt: (await db.samples.get(row.id))!.updatedAt,
  });
  console.assert((await db.samples.get(row.id))?.note === '窗口B确认覆盖',
    'FAIL 基于最新版本应可正常保存');

  // 3. 更新/新增已删除记录 → RecordGoneError
  await s().registerSample({ ...baseSample(), sampleNo: 'MET-2026-011' });
  const gone = await db.samples.where('sampleNo').equals('MET-2026-011').first();
  await s().removeSample(gone!.id);
  let goneErr = false;
  try {
    await s().updateSample(gone!.id, { note: 'x' });
  } catch (e) {
    goneErr = e instanceof RecordGoneError;
  }
  console.assert(goneErr, 'FAIL 更新已删除样本应抛 RecordGoneError');

  // 级联删除：find/section/analysis 一并清掉
  const { sampleId } = await s().registerSample(
    { ...baseSample(), sampleNo: 'MET-2026-012' },
    { placeName: 'P', region: 'R', longitude: 1, latitude: 2,
      coordinateSource: 'gps' as const, environment: 'desert' as const, finder: 'f' },
  );
  await s().addSection({ sectionNo: 'TS-2026-099', sampleId, thickness: 30,
    preparation: 'resin' as const, minerals: { olivine: 1, pyroxene: 1, feldspar: 1, metal: 97 },
    micrographs: [], quality: 'good' as const });
  await s().addAnalysis({ sampleId, target: 'sample' as const, method: 'microprobe' as const,
    fa: 1, fs: 2, ni: 3, kamaciteBandwidth: 0.1, testedAt: '2026-01-01' });
  await s().removeSample(sampleId);
  console.assert(
    (await db.finds.where('sampleId').equals(sampleId).count()) === 0 &&
    (await db.sections.where('sampleId').equals(sampleId).count()) === 0 &&
    (await db.analysis.where('sampleId').equals(sampleId).count()) === 0,
    'FAIL 删除样本应级联清理关联记录');

  // 4. 切片编号撞号
  const { sampleId: s2 } = await s().registerSample({ ...baseSample(), sampleNo: 'MET-2026-013' });
  await s().addSection({ sectionNo: 'TS-X-1', sampleId: s2, thickness: 30,
    preparation: 'resin' as const, minerals: { olivine: 1, pyroxene: 1, feldspar: 1, metal: 97 },
    micrographs: [], quality: 'good' as const });
  let secDup = false;
  try {
    await s().addSection({ sectionNo: 'TS-X-1', sampleId: s2, thickness: 60,
      preparation: 'epoxy' as const, minerals: { olivine: 1, pyroxene: 1, feldspar: 1, metal: 97 },
      micrographs: [], quality: 'fair' as const });
  } catch (e) {
    secDup = e instanceof DuplicateNoError;
  }
  console.assert(secDup, 'FAIL 同切片编号应被拦下');

  // 5. nextSampleSeq 直接查库：即使内存快照被清空也能给出正确序号
  useSampleStore.setState({ samples: [] });
  const seq = await s().nextSampleSeq();
  console.assert(seq === 14, `FAIL nextSampleSeq 应为 14，实际 ${seq}`);

  // 6. 给不存在的样本挂发现/切片/检测 → RecordGoneError
  for (const op of [
    () => s().addFind({ sampleId: 'ghost', placeName: 'p', region: 'r', longitude: 0, latitude: 0,
      coordinateSource: 'gps' as const, environment: 'desert' as const, finder: 'f' }),
    () => s().addAnalysis({ sampleId: 'ghost', target: 'sample' as const, method: 'sem-eds' as const,
      fa: 1, fs: 1, ni: 1, kamaciteBandwidth: 1, testedAt: '2026-01-01' }),
  ]) {
    let g = false;
    try { await op(); } catch (e) { g = e instanceof RecordGoneError; }
    console.assert(g, 'FAIL 给已删除样本挂记录应被拒');
  }

  console.log('全部并发断言通过 ✅');
}

main().catch((e) => { console.error(e); process.exit(1); });

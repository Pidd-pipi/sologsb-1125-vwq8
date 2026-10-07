import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db, DB_NAME } from '../frontend/src/db/index';
import type { MeteoriteSample } from '../frontend/src/types/sample';
import type { ThinSection } from '../frontend/src/types/section';
import type { FindRecord } from '../frontend/src/types/find';
import type { AnalysisRecord } from '../frontend/src/types/analysis';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

/** 按 v3 schema 造一个含重号、缺 updatedAt 的旧库 */
async function buildV3Database() {
  // 确保全新
  await new Promise<void>((resolve) => indexedDB.deleteDatabase(DB_NAME).onsuccess = () => resolve());

  const v3 = new Dexie(DB_NAME);
  v3.version(1).stores({
    samples: 'id, sampleNo, category, chemicalGroup, totalWeight, createdAt',
    finds: 'id, sampleId, region, createdAt',
    sections: 'id, sectionNo, sampleId, thickness, createdAt',
  });
  v3.version(2).stores({
    samples: 'id, sampleNo, category, chemicalGroup, totalWeight, createdAt',
    finds: 'id, sampleId, region, createdAt',
    sections: 'id, sectionNo, sampleId, thickness, createdAt',
    analysis: 'id, sampleId, sectionId, method, testedAt, createdAt',
  });
  v3.version(3).stores({
    samples: 'id, sampleNo, category, chemicalGroup, totalWeight, createdAt, updatedAt',
    finds: 'id, sampleId, region, createdAt',
    sections: 'id, sectionNo, sampleId, thickness, createdAt',
    analysis: 'id, sampleId, sectionId, method, testedAt, createdAt',
  });

  const now = 1_700_000_000_000;
  await v3.table('samples').bulkAdd([
    // 两条重号样本，createdAt 不同：早的保留 001，晚的应变 -dup2
    {
      id: 's1', sampleNo: 'MET-2024-001', totalWeight: 10, category: 'chondrite',
      chemicalGroup: 'H', weathering: 'W1', fallOrFind: 'find', storage: 'cabinet-a',
      createdAt: now - 2000, updatedAt: now - 2000,
    },
    {
      id: 's2', sampleNo: 'MET-2024-001', totalWeight: 20, category: 'iron',
      chemicalGroup: 'IAB', weathering: 'W0', fallOrFind: 'find', storage: 'cabinet-b',
      createdAt: now - 1000, updatedAt: now - 1000,
    },
  ] as MeteoriteSample[]);
  await v3.table('sections').bulkAdd([
    // 重号切片，且没有 updatedAt
    {
      id: 't1', sectionNo: 'TS-2024-001', sampleId: 's1', thickness: 30, preparation: 'resin',
      minerals: { olivine: 40, pyroxene: 30, feldspar: 10, metal: 20 }, micrographs: [],
      quality: 'good', createdAt: now - 500,
    },
    {
      id: 't2', sectionNo: 'TS-2024-001', sampleId: 's2', thickness: 60, preparation: 'epoxy',
      minerals: { olivine: 1, pyroxene: 1, feldspar: 1, metal: 97 }, micrographs: [],
      quality: 'fair', createdAt: now - 100,
    },
  ] as unknown as ThinSection[]);
  await v3.table('finds').bulkAdd([
    {
      id: 'f1', sampleId: 's1', placeName: 'X', region: 'R', longitude: 1, latitude: 2,
      coordinateSource: 'gps', environment: 'desert', finder: 'z', createdAt: now - 400,
    },
  ] as unknown as FindRecord[]);
  await v3.table('analysis').bulkAdd([
    {
      id: 'a1', sampleId: 's1', target: 'sample', method: 'microprobe',
      fa: 1, fs: 2, ni: 3, kamaciteBandwidth: 0.1, testedAt: '2024-01-01', createdAt: now - 300,
    },
  ] as unknown as AnalysisRecord[]);
  await v3.close();
}

async function main() {
  await buildV3Database();

  // 打开真实 db（单例），Dexie 自动从 v3 升到 v4
  await db.open();

  const samples = await db.samples.toArray();
  check('迁移后样本数量不变', samples.length === 2);
  const s1 = samples.find((s) => s.id === 's1')!;
  const s2 = samples.find((s) => s.id === 's2')!;
  check('重号样本：较早的保留原号', s1.sampleNo === 'MET-2024-001', s1.sampleNo);
  check('重号样本：较晚的追加 -dup2 后缀', s2.sampleNo === 'MET-2024-001-dup2', s2.sampleNo);
  check('样本 updatedAt 保持 v3 值不变', s1.updatedAt === 1_700_000_000_000 - 2000);

  const sections = await db.sections.toArray();
  const t1 = sections.find((t) => t.id === 't1')!;
  const t2 = sections.find((t) => t.id === 't2')!;
  check('重号切片：较早保留 TS-2024-001', t1.sectionNo === 'TS-2024-001', t1.sectionNo);
  check('重号切片：较晚追加 -dup2', t2.sectionNo === 'TS-2024-001-dup2', t2.sectionNo);
  check('旧切片回填 updatedAt（按 createdAt）', t1.updatedAt === t1.createdAt && t2.updatedAt === t2.createdAt);

  const find = await db.finds.get('f1');
  check('旧发现记录回填 updatedAt', !!find && find.updatedAt === find.createdAt);
  const analysisRec = await db.analysis.get('a1');
  check('旧检测记录回填 updatedAt', !!analysisRec && analysisRec.updatedAt === analysisRec.createdAt);

  // 验证唯一索引确实在起作用：同号 add 必须被拒
  let rejected = false;
  try {
    await db.samples.add({
      id: 's3', sampleNo: 'MET-2024-001', totalWeight: 1, category: 'iron',
      chemicalGroup: 'IAB', weathering: 'W0', fallOrFind: 'find', storage: 'cabinet-a',
      createdAt: Date.now(), updatedAt: Date.now(),
    });
  } catch (err) {
    rejected = (err as Error).name === 'ConstraintError';
  }
  check('v5 唯一索引拦截重复 sampleNo', rejected);

  // 新库首次使用：seed 数据可正常灌入（不与唯一索引冲突）
  await db.close();
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = () => resolve();
    r.onblocked = () => resolve();
  });

  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err?.name, err?.message);
  if (err?.inner) console.error('INNER:', err.inner.name, err.inner.message);
  process.exit(1);
});

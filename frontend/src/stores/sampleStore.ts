import { create } from 'zustand';
import {
  db,
  makeId,
  seedIfEmpty,
  DuplicateNoError,
  RecordGoneError,
  StaleWriteError,
} from '../db';
import { publishChange, type ChangeTable } from '../utils/syncBus';
import type { AnalysisRecord } from '../types/analysis';
import type { FindRecord } from '../types/find';
import type { MeteoriteSample } from '../types/sample';
import type { ThinSection } from '../types/section';

/** 更新类操作的并发选项：带基准版本做乐观锁；force=true 覆盖对方改动 */
export interface WriteOptions {
  /** 打开表单/读取时看到的 updatedAt */
  expectedUpdatedAt?: number;
  /** 冲突后用户确认强制覆盖 */
  force?: boolean;
}

export interface SampleState {
  samples: MeteoriteSample[];
  finds: FindRecord[];
  sections: ThinSection[];
  analysis: AnalysisRecord[];
  loading: boolean;
  loaded: boolean;
  loadAll: () => Promise<void>;
  /** 收到其它窗口的变更通知后重查（不再灌种子，避免把对方删空的库又种回去） */
  refreshFromRemote: () => Promise<void>;
  /** 登记样本，可在同一事务内随附发现地记录（同成同败，绝不写一半） */
  registerSample: (
    input: Omit<MeteoriteSample, 'id' | 'createdAt' | 'updatedAt'>,
    find?: Omit<FindRecord, 'id' | 'sampleId' | 'createdAt'>,
  ) => Promise<{ sampleId: string; findId?: string }>;
  updateSample: (id: string, patch: Partial<MeteoriteSample>, opts?: WriteOptions) => Promise<void>;
  removeSample: (id: string) => Promise<void>;
  addFind: (input: Omit<FindRecord, 'id' | 'createdAt'>) => Promise<string>;
  addSection: (input: Omit<ThinSection, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updateSection: (
    id: string,
    patch: Partial<ThinSection>,
    opts?: WriteOptions,
  ) => Promise<void>;
  addAnalysis: (input: Omit<AnalysisRecord, 'id' | 'createdAt'>) => Promise<string>;
  /** 直接查库取年份序号，防止另一窗口刚登记后本窗口仍按旧内存算出撞号 */
  nextSampleSeq: () => Promise<number>;
}

async function readAll(): Promise<{
  samples: MeteoriteSample[];
  finds: FindRecord[];
  sections: ThinSection[];
  analysis: AnalysisRecord[];
}> {
  const [samples, finds, sections, analysis] = await Promise.all([
    db.samples.toArray(),
    db.finds.toArray(),
    db.sections.toArray(),
    db.analysis.toArray(),
  ]);
  samples.sort((a, b) => b.createdAt - a.createdAt);
  finds.sort((a, b) => b.createdAt - a.createdAt);
  sections.sort((a, b) => b.createdAt - a.createdAt);
  analysis.sort((a, b) => b.createdAt - a.createdAt);
  return { samples, finds, sections, analysis };
}

export const useSampleStore = create<SampleState>((set, get) => ({
  samples: [],
  finds: [],
  sections: [],
  analysis: [],
  loading: false,
  loaded: false,

  loadAll: async () => {
    set({ loading: true });
    try {
      await seedIfEmpty();
      set({ ...(await readAll()), loading: false, loaded: true });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  refreshFromRemote: async () => {
    const next = await readAll();
    set(next);
  },

  registerSample: async (input, find) => {
    const now = Date.now();
    const sampleId = makeId('sample');
    const sample: MeteoriteSample = { ...input, id: sampleId, createdAt: now, updatedAt: now };
    let findRecord: FindRecord | null = null;
    if (find) {
      findRecord = { ...find, id: makeId('find'), sampleId, createdAt: now };
    }
    const related: ChangeTable[] = findRecord ? ['finds'] : [];
    await db.transaction('rw', db.samples, db.finds, async () => {
      // 编号唯一性在事务内复查：两个窗口同时保存同一编号时，
      // rw 事务串行，后提交的一方在这里看到对方刚落库的记录并被拦下
      const clash = await db.samples.where('sampleNo').equals(sample.sampleNo).first();
      if (clash) {
        throw new DuplicateNoError('sample', sample.sampleNo, {
          id: clash.id,
          createdAt: clash.createdAt,
          updatedAt: clash.updatedAt,
        });
      }
      await db.samples.add(sample);
      if (findRecord) await db.finds.add(findRecord);
    });
    set((state) => ({
      samples: [sample, ...state.samples],
      finds: findRecord ? [findRecord, ...state.finds] : state.finds,
    }));
    publishChange({ action: 'add', table: 'samples', id: sampleId, related });
    return { sampleId, findId: findRecord?.id };
  },

  updateSample: async (id, patch, opts = {}) => {
    const now = Date.now();
    // updatedAt 只能由这里推进，调用方传入一律忽略
    const changes = { ...patch, updatedAt: now };
    await db.transaction('rw', db.samples, async () => {
      const current = await db.samples.get(id);
      if (!current) throw new RecordGoneError('samples', id);
      if (!opts.force && opts.expectedUpdatedAt !== undefined &&
        current.updatedAt !== opts.expectedUpdatedAt) {
        throw new StaleWriteError('samples', id, opts.expectedUpdatedAt, current.updatedAt);
      }
      await db.samples.update(id, changes);
    });
    set({
      samples: get().samples.map((s) => (s.id === id ? { ...s, ...changes } : s)),
    });
    publishChange({ action: 'update', table: 'samples', id });
  },

  removeSample: async (id) => {
    await db.transaction('rw', db.samples, db.finds, db.sections, db.analysis, async () => {
      await db.samples.delete(id);
      await db.finds.where('sampleId').equals(id).delete();
      await db.sections.where('sampleId').equals(id).delete();
      await db.analysis.where('sampleId').equals(id).delete();
    });
    set({
      samples: get().samples.filter((s) => s.id !== id),
      finds: get().finds.filter((f) => f.sampleId !== id),
      sections: get().sections.filter((s) => s.sampleId !== id),
      analysis: get().analysis.filter((a) => a.sampleId !== id),
    });
    publishChange({
      action: 'delete',
      table: 'samples',
      id,
      related: ['finds', 'sections', 'analysis'],
    });
  },

  addFind: async (input) => {
    const record: FindRecord = { ...input, id: makeId('find'), createdAt: Date.now() };
    await db.transaction('rw', db.finds, db.samples, async () => {
      const parent = await db.samples.get(input.sampleId);
      if (!parent) throw new RecordGoneError('samples', input.sampleId);
      await db.finds.add(record);
    });
    set({ finds: [record, ...get().finds] });
    publishChange({ action: 'add', table: 'finds', id: record.id, related: ['samples'] });
    return record.id;
  },

  addSection: async (input) => {
    const now = Date.now();
    const record: ThinSection = {
      ...input,
      id: makeId('section'),
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction('rw', db.sections, db.samples, async () => {
      const parent = await db.samples.get(input.sampleId);
      if (!parent) throw new RecordGoneError('samples', input.sampleId);
      const clash = await db.sections.where('sectionNo').equals(record.sectionNo).first();
      if (clash) {
        throw new DuplicateNoError('section', record.sectionNo, {
          id: clash.id,
          createdAt: clash.createdAt,
          updatedAt: clash.updatedAt ?? clash.createdAt,
        });
      }
      await db.sections.add(record);
    });
    set({ sections: [record, ...get().sections] });
    publishChange({ action: 'add', table: 'sections', id: record.id, related: ['samples'] });
    return record.id;
  },

  updateSection: async (id, patch, opts = {}) => {
    const now = Date.now();
    const changes = { ...patch, updatedAt: now };
    await db.transaction('rw', db.sections, async () => {
      const current = await db.sections.get(id);
      if (!current) throw new RecordGoneError('sections', id);
      if (!opts.force && opts.expectedUpdatedAt !== undefined &&
        (current.updatedAt ?? current.createdAt) !== opts.expectedUpdatedAt) {
        throw new StaleWriteError(
          'sections',
          id,
          opts.expectedUpdatedAt,
          current.updatedAt ?? current.createdAt,
        );
      }
      await db.sections.update(id, changes);
    });
    set({ sections: get().sections.map((s) => (s.id === id ? { ...s, ...changes } : s)) });
    publishChange({ action: 'update', table: 'sections', id, related: ['samples'] });
  },

  addAnalysis: async (input) => {
    const record: AnalysisRecord = { ...input, id: makeId('analysis'), createdAt: Date.now() };
    await db.transaction('rw', db.analysis, db.samples, db.sections, async () => {
      const parent = await db.samples.get(input.sampleId);
      if (!parent) throw new RecordGoneError('samples', input.sampleId);
      if (input.sectionId) {
        const section = await db.sections.get(input.sectionId);
        if (!section) throw new RecordGoneError('sections', input.sectionId);
      }
      await db.analysis.add(record);
    });
    set({ analysis: [record, ...get().analysis] });
    publishChange({ action: 'add', table: 'analysis', id: record.id, related: ['samples'] });
    return record.id;
  },

  nextSampleSeq: async () => {
    const year = new Date().getFullYear();
    const prefix = `MET-${year}-`;
    // 以库中实时数据为准，而不是本窗口可能已落后的内存快照
    const used = (await db.samples.orderBy('sampleNo').keys())
      .filter((no): no is string => typeof no === 'string' && no.startsWith(prefix))
      .map((no) => Number(no.slice(prefix.length)))
      .filter((n) => Number.isFinite(n));
    const max = used.length ? Math.max(...used) : 0;
    return max + 1;
  },
}));

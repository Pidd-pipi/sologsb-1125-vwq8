import { create } from 'zustand';
import Dexie from 'dexie';
import { db, makeId, nextYearlyNo, seedIfEmpty } from '../db';
import { broadcastChange, type ChangeTable } from '../db/sync';
import { StaleWriteError, UniqueConflictError } from '../db/errors';
import type { AnalysisRecord } from '../types/analysis';
import type { FindRecord } from '../types/find';
import type { MeteoriteSample } from '../types/sample';
import type { ThinSection } from '../types/section';

export interface SampleState {
  samples: MeteoriteSample[];
  finds: FindRecord[];
  sections: ThinSection[];
  analysis: AnalysisRecord[];
  loading: boolean;
  /** 跨窗口同步重拉中（不触发整页 loading，避免打断录入） */
  refreshing: boolean;
  loaded: boolean;
  loadAll: () => Promise<void>;
  /** 收到其他窗口变更后静默重拉四张表，各页统计随之重算 */
  refresh: () => Promise<void>;
  /** 样本 + 可选发现记录在一个事务里落库，避免样本成功、发现记录失败的半截数据 */
  createSampleWithFind: (
    input: Omit<MeteoriteSample, 'id' | 'createdAt' | 'updatedAt'>,
    findInput?: Omit<FindRecord, 'id' | 'sampleId' | 'createdAt' | 'updatedAt'>,
  ) => Promise<{ sampleId: string }>;
  updateSample: (
    id: string,
    patch: Partial<MeteoriteSample>,
    /** 编辑时看到的版本；与库内 updatedAt 不一致说明另一窗口已改过 */
    expectedUpdatedAt: number,
  ) => Promise<void>;
  removeSample: (id: string) => Promise<void>;
  addSection: (input: Omit<ThinSection, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updateSection: (
    id: string,
    patch: Partial<ThinSection>,
    expectedUpdatedAt: number,
  ) => Promise<void>;
  addAnalysis: (input: Omit<AnalysisRecord, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  /** 直接查库给出下一个可用编号：另一窗口刚占用的序号立即可见 */
  recommendSampleNo: () => Promise<string>;
  recommendSectionNo: () => Promise<string>;
}

function byCreatedDesc<T extends { createdAt: number }>(list: T[]): T[] {
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

async function fetchAll() {
  const [samples, finds, sections, analysis] = await Promise.all([
    db.samples.toArray(),
    db.finds.toArray(),
    db.sections.toArray(),
    db.analysis.toArray(),
  ]);
  return {
    samples: byCreatedDesc(samples),
    finds: byCreatedDesc(finds),
    sections: byCreatedDesc(sections),
    analysis: byCreatedDesc(analysis),
  };
}

export const useSampleStore = create<SampleState>((set, get) => ({
  samples: [],
  finds: [],
  sections: [],
  analysis: [],
  loading: false,
  refreshing: false,
  loaded: false,

  loadAll: async () => {
    set({ loading: true });
    await seedIfEmpty();
    set({ ...(await fetchAll()), loading: false, loaded: true });
  },

  refresh: async () => {
    // 短时间内多个窗口多条通知合并为一次重拉
    if (get().refreshing || !get().loaded) return;
    set({ refreshing: true });
    try {
      set({ ...(await fetchAll()), refreshing: false });
    } catch {
      set({ refreshing: false });
    }
  },

  createSampleWithFind: async (input, findInput) => {
    const now = Date.now();
    const sample: MeteoriteSample = { ...input, id: makeId('sample'), createdAt: now, updatedAt: now };
    let findRecord: FindRecord | null = null;
    const tables: ChangeTable[] = ['samples'];
    // 提示信息在真正撞车时才查库生成，保证建议号不会恰好也是被占用的号
    const conflict = async () =>
      new UniqueConflictError(
        `样本编号 ${input.sampleNo} 已被另一窗口登记，不能重复使用`,
        'sampleNo',
        input.sampleNo,
        await nextYearlyNo('sampleNo', 'MET'),
      );

    try {
      await db.transaction('rw', db.samples, db.finds, async () => {
        // 事务内先查重：命中直接抛冲突（唯一索引是最后一道保险）
        const dup = await db.samples.where('sampleNo').equals(input.sampleNo).first();
        if (dup) throw await conflict();
        await db.samples.add(sample);
        if (findInput) {
          findRecord = {
            ...findInput,
            id: makeId('find'),
            sampleId: sample.id,
            createdAt: now,
            updatedAt: now,
          };
          await db.finds.add(findRecord);
          tables.push('finds');
        }
      });
    } catch (err) {
      const name = (err as Error | null)?.name;
      if (err instanceof UniqueConflictError) throw err;
      if (name === Dexie.errnames.Constraint) throw await conflict();
      // 唯一索引冲突在少数浏览器上以事务 AbortError 兜底冒出来
      if (name === Dexie.errnames.Abort) {
        const dup = await db.samples.where('sampleNo').equals(input.sampleNo).first();
        if (dup) throw await conflict();
      }
      throw err;
    }

    set((st) => ({
      samples: [sample, ...st.samples],
      finds: findRecord ? [findRecord, ...st.finds] : st.finds,
    }));
    broadcastChange(tables);
    return { sampleId: sample.id };
  },

  updateSample: async (id, patch, expectedUpdatedAt) => {
    let updated: MeteoriteSample | undefined;
    try {
      await db.transaction('rw', db.samples, async () => {
        const current = await db.samples.get(id);
        if (!current) {
          throw new StaleWriteError('该样本已被另一窗口删除，本窗口的修改无法写入', 'deleted');
        }
        if (current.updatedAt !== expectedUpdatedAt) {
          throw new StaleWriteError(
            `样本 ${current.sampleNo} 已被另一窗口修改，本窗口持有的内容已落后`,
            'modified',
            current,
          );
        }
        const updatedAt = Date.now();
        await db.samples.update(id, { ...patch, updatedAt });
        updated = { ...current, ...patch, updatedAt };
      });
    } catch (err) {
      if (err instanceof StaleWriteError) {
        // 落后版本：不覆盖对方结果，拉取最新内容供页面提示
        await get().refresh();
      }
      throw err;
    }

    set({ samples: get().samples.map((s) => (s.id === id ? updated! : s)) });
    broadcastChange(['samples']);
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
    broadcastChange(['samples', 'finds', 'sections', 'analysis']);
  },

  addSection: async (input) => {
    const now = Date.now();
    const record: ThinSection = { ...input, id: makeId('section'), createdAt: now, updatedAt: now };
    try {
      await db.sections.add(record);
    } catch (err) {
      if ((err as Error | null)?.name === Dexie.errnames.Constraint) {
        throw new UniqueConflictError(
          `切片编号 ${input.sectionNo} 已被另一窗口登记，不能重复使用`,
          'sectionNo',
          input.sectionNo,
          await nextYearlyNo('sectionNo', 'TS'),
        );
      }
      throw err;
    }
    set({ sections: [record, ...get().sections] });
    broadcastChange(['sections']);
    return record.id;
  },

  updateSection: async (id, patch, expectedUpdatedAt) => {
    let updated: ThinSection | undefined;
    try {
      await db.transaction('rw', db.sections, async () => {
        const current = await db.sections.get(id);
        if (!current) {
          throw new StaleWriteError('该切片已被另一窗口删除，本窗口的标注无法写入', 'deleted');
        }
        if (current.updatedAt !== expectedUpdatedAt) {
          throw new StaleWriteError(
            `切片 ${current.sectionNo} 刚被另一窗口标注过，本窗口内容已落后`,
            'modified',
            current,
          );
        }
        const updatedAt = Date.now();
        await db.sections.update(id, { ...patch, updatedAt });
        updated = { ...current, ...patch, updatedAt };
      });
    } catch (err) {
      if (err instanceof StaleWriteError) await get().refresh();
      throw err;
    }
    set({ sections: get().sections.map((s) => (s.id === id ? updated! : s)) });
    broadcastChange(['sections']);
  },

  addAnalysis: async (input) => {
    const now = Date.now();
    const record: AnalysisRecord = { ...input, id: makeId('analysis'), createdAt: now, updatedAt: now };
    await db.analysis.add(record);
    set({ analysis: [record, ...get().analysis] });
    broadcastChange(['analysis']);
    return record.id;
  },

  recommendSampleNo: () => nextYearlyNo('sampleNo', 'MET'),
  recommendSectionNo: () => nextYearlyNo('sectionNo', 'TS'),
}));

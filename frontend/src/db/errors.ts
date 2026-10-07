/**
 * 并发写入相关错误：
 *  - StaleWriteError：本窗口持有的数据版本落后于另一窗口已提交的版本（乐观锁失败）
 *  - UniqueConflictError：样本编号 / 切片编号唯一索引冲突（另一窗口已占用同号）
 */

/** 乐观锁失败时，库里记录当前的状态 */
export type StaleWriteKind = 'modified' | 'deleted';

export class StaleWriteError extends Error {
  readonly kind: StaleWriteKind;
  /** 库里现存的最新记录（被删除时为 undefined） */
  readonly current?: unknown;

  constructor(message: string, kind: StaleWriteKind, current?: unknown) {
    super(message);
    this.name = 'StaleWriteError';
    this.kind = kind;
    this.current = current;
  }
}

export class UniqueConflictError extends Error {
  /** 冲突字段，如 sampleNo / sectionNo */
  readonly field: string;
  /** 冲突的编号值 */
  readonly value: string;
  /** 建议改用的下一个可用编号 */
  readonly suggestion?: string;

  constructor(message: string, field: string, value: string, suggestion?: string) {
    super(message);
    this.name = 'UniqueConflictError';
    this.field = field;
    this.value = value;
    this.suggestion = suggestion;
  }
}

export function isStaleWriteError(err: unknown): err is StaleWriteError {
  return err instanceof StaleWriteError;
}

export function isUniqueConflictError(err: unknown): err is UniqueConflictError {
  return err instanceof UniqueConflictError;
}

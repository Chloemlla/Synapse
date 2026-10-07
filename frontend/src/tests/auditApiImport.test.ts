import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importHistoryData, importHistoryToDB, type LogShareHistory } from '../utils/logShareStorage';

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('idb', () => ({ openDB: mocks.open, deleteDB: vi.fn() }));

const item = (id: string): LogShareHistory => ({ id, type: 'upload', data: { time: '2026-10-07' }, createdAt: '2026-10-07' });

// Model the transaction boundary, including rollback, without another dependency.
function database(failOn?: string) {
  const committed = new Map([['old', item('old')]]);
  const staged = new Map(committed);
  let failed = false;
  const close = vi.fn();
  const clear = vi.fn();
  const transaction = {
    store: {
      get: vi.fn(async (key: string) => staged.get(key)),
      add: vi.fn(async (value: LogShareHistory) => {
        if (value.id === failOn) { failed = true; throw new Error('QuotaExceededError'); }
        staged.set(value.id, value);
      }),
    },
    abort: vi.fn(() => { failed = true; }),
    get done() {
      if (failed) return Promise.reject(new Error('transaction aborted'));
      committed.clear();
      staged.forEach((value, key) => committed.set(key, value));
      return Promise.resolve();
    },
  };
  mocks.open.mockResolvedValue({ transaction: vi.fn(() => transaction), clear, close });
  return { committed, transaction, clear, close };
}

describe('LogShare import atomicity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an invalid IndexedDB key before opening or clearing existing data', async () => {
    const db = database();
    await expect(importHistoryToDB([item('new'), { ...item('bad'), id: true } as any])).rejects.toThrow('历史记录格式无效');
    expect(mocks.open).not.toHaveBeenCalled();
    expect([...db.committed.keys()]).toEqual(['old']);
    expect(db.clear).not.toHaveBeenCalled();
  });

  it('rolls back earlier additions and rejects the public file import on storage failure', async () => {
    const db = database('fail');
    const file = new File([JSON.stringify({ mode: 'plain', data: [item('new'), item('fail')] })], 'history.json');
    await expect(importHistoryData(file)).rejects.toThrow('QuotaExceededError');
    expect([...db.committed.keys()]).toEqual(['old']);
    expect(db.transaction.abort).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(db.clear).not.toHaveBeenCalled();
  });

  it('preserves existing records and reports only newly committed IDs', async () => {
    const db = database();
    const file = new File([JSON.stringify([item('old'), item('new'), item('new')])], 'legacy.json');
    await expect(importHistoryData(file)).resolves.toBe(1);
    expect([...db.committed.keys()]).toEqual(['old', 'new']);
    expect(db.transaction.store.add).toHaveBeenCalledOnce();
  });
});

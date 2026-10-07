import { TtsQueue } from '../tts/tts.queue';
import { ttsStorage } from '../tts/tts.storage';
import logger from '../utils/logger';

jest.mock('../services/wsService', () => ({ wsService: {} }));
jest.mock('../utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));
jest.mock('../tts/tts.history', () => ({ generationHistoryStore: {}, redactTtsTextForStorage: (text: string) => text }));
jest.mock('../tts/tts.quota', () => ({ quotaLedger: {}, startExpiredReservationSweeper: jest.fn() }));
jest.mock('../tts/tts.service', () => ({ TtsService: class {} }));
jest.mock('../tts/tts.storage', () => ({ ttsStorage: { createJob: jest.fn(), recoverStaleJobs: jest.fn(), claimNextQueuedJob: jest.fn() } }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const job = (taskId: string) => ({ taskId } as any);
const callbacks = { buildUsageSummary: jest.fn(), buildNextAction: jest.fn() };

describe('TTS scheduler recovery', () => {
  const originalConcurrency = process.env.TTS_QUEUE_CONCURRENCY;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    process.env.TTS_QUEUE_CONCURRENCY = '2';
    (ttsStorage.createJob as jest.Mock).mockResolvedValue(undefined);
    (ttsStorage.recoverStaleJobs as jest.Mock).mockResolvedValue({ failed: [], recovered: 0 });
    (ttsStorage.claimNextQueuedJob as jest.Mock).mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    if (originalConcurrency === undefined) delete process.env.TTS_QUEUE_CONCURRENCY;
    else process.env.TTS_QUEUE_CONCURRENCY = originalConcurrency;
  });

  it('retries a failed claim without requiring another enqueue', async () => {
    (ttsStorage.claimNextQueuedJob as jest.Mock).mockRejectedValueOnce(new Error('Mongo temporarily unavailable'));
    const queue = new TtsQueue(callbacks);
    await queue.enqueue(job('queued'));
    await jest.advanceTimersByTimeAsync(0);
    expect(ttsStorage.claimNextQueuedJob).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5000);
    expect(ttsStorage.claimNextQueuedJob).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('队列调度失败'), expect.anything());
  });

  it('waits for existing work before retrying, preserving the concurrency limit', async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const queue = new TtsQueue(callbacks);
    let active = 0;
    let peak = 0;
    jest.spyOn(queue as any, 'processJob').mockImplementation((...args: any[]) => {
      active += 1;
      peak = Math.max(peak, active);
      const work = args[0].taskId === 'A' ? first : args[0].taskId === 'B' ? second : third;
      return work.promise.finally(() => { active -= 1; });
    });
    (ttsStorage.claimNextQueuedJob as jest.Mock)
      .mockResolvedValueOnce(job('A')).mockRejectedValueOnce(new Error('claim failed'))
      .mockResolvedValueOnce(job('B')).mockResolvedValueOnce(job('C'));
    await queue.enqueue(job('A'));
    await jest.advanceTimersByTimeAsync(0);
    await queue.enqueue(job('B'));
    await jest.advanceTimersByTimeAsync(5000);
    expect(ttsStorage.claimNextQueuedJob).toHaveBeenCalledTimes(2);
    first.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(active).toBe(2);
    expect(peak).toBe(2);
    second.resolve();
    third.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(active).toBe(0);
  });

  it('handles a job rejection while another database claim is still pending', async () => {
    const claim = deferred<any>();
    const queue = new TtsQueue(callbacks);
    jest.spyOn(queue as any, 'processJob').mockRejectedValue(new Error('terminal state write failed'));
    (ttsStorage.claimNextQueuedJob as jest.Mock).mockResolvedValueOnce(job('A')).mockReturnValueOnce(claim.promise);
    await queue.enqueue(job('A'));
    await jest.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('终态持久化失败'), expect.objectContaining({ taskId: 'A' }));
    claim.resolve(null);
    await jest.advanceTimersByTimeAsync(0);
  });
});

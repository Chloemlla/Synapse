export {};

const mockCreateClient = jest.fn();
jest.mock("redis", () => ({ createClient: (...args: unknown[]) => mockCreateClient(...args) }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

it("retries a rejected initial connect after backoff and stops retrying after shutdown", async () => {
  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://localhost:6379";
  jest.useFakeTimers();
  const handlers: Record<string, () => void> = {};
  const first = { on: jest.fn(), isOpen: false, connect: jest.fn().mockRejectedValue(new Error("initial failure")) };
  const second = {
    on: jest.fn((event: string, handler: () => void) => { handlers[event] = handler; }),
    isOpen: true,
    connect: jest.fn(async () => { handlers.connect(); handlers.ready(); }),
    quit: jest.fn(async (): Promise<void> => { second.isOpen = false; handlers.end(); }),
    destroy: jest.fn(),
  };
  mockCreateClient.mockReturnValueOnce(first).mockReturnValueOnce(second);
  let service!: typeof import("../services/redisService")["redisService"];
  try {
    jest.isolateModules(() => { service = require("../services/redisService").redisService; });
    await Promise.resolve();
    await Promise.resolve();
    expect(service.isAvailable()).toBe(false);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(30_001);
    service.isAvailable();
    await Promise.resolve();
    expect(service.getStatus().available).toBe(true);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    await service.disconnect();
    jest.advanceTimersByTime(30_001);
    expect(service.isAvailable()).toBe(false);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  } finally {
    if (service) await service.disconnect();
    jest.useRealTimers();
    if (previousUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousUrl;
  }
});

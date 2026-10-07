// In-flight identity reads belong to the session that started them.
let generation = 0;
let transition: number | null = null;
let pendingRead: { generation: number; promise: Promise<unknown> } | null = null;

export const getAuthRequestGeneration = (): number => generation;
export const invalidateAuthRequests = (): number => {
  transition = null;
  return ++generation;
};
export const isCurrentAuthRequest = (value: number): boolean => value === generation;

export const beginAuthTransition = (): number => {
  transition = invalidateAuthRequests();
  return transition;
};
export const endAuthTransition = (value: number): void => {
  if (transition === value) transition = null;
};
export const isAuthTransitionPending = (): boolean => transition !== null;

/** Every consumer of /auth/me shares the read belonging to the current session. */
export function readAuthResponse<T>(read: () => Promise<T>): Promise<T> {
  if (isAuthTransitionPending()) return Promise.reject(new Error('认证操作进行中'));
  if (pendingRead?.generation === generation) return pendingRead.promise as Promise<T>;
  const startedGeneration = generation;
  const promise = Promise.resolve().then(() => {
    if (!isCurrentAuthRequest(startedGeneration) || isAuthTransitionPending()) throw new Error('认证检查已取消');
    return read();
  }).finally(() => {
    if (pendingRead?.promise === promise) pendingRead = null;
  });
  pendingRead = { generation: startedGeneration, promise };
  return promise;
}

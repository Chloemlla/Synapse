/** Browser origins are opt-in; local command-line clients have no Origin header. */
export function isAllowedMediaToolOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  return !origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

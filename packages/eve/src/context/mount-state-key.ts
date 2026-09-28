export function mountStateKeyPrefix(mountId: string): string {
  return `mount-v1:${encodeURIComponent(mountId)}:`;
}

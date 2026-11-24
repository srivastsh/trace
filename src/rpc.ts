export async function rpc<T>(op: string, args?: unknown): Promise<T> {
  const res = await chrome.runtime.sendMessage({ v: 1, op, args });
  if (!res?.ok) throw new Error(res?.error ?? 'Trace is unavailable. Reopen the page.');
  return res.data as T;
}

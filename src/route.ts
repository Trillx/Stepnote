// Route tokens: a one-way 32-bit FNV-1a hash of a URL's fragment route, such
// as "#/orders" in a hash-routed app. The fragment's query part is dropped and
// nothing raw is stored; the token only tells apart pages sharing one path.
// The page (content scripts) and the worker (tab addresses) both use this.
export function routeTokenOf(hash: string): string {
  const route = hash.split('?')[0];
  let value = 0x811c9dc5;
  for (let i = 0; i < route.length; i++) { value ^= route.charCodeAt(i); value = Math.imul(value, 0x01000193) >>> 0; }
  return value.toString(16).padStart(8, '0');
}
export const routeToken = (win: Window) => routeTokenOf(win.location.hash);
// The token of a page with no fragment route.
export const noRoute = routeTokenOf('');
export const validRoute = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}$/.test(value);

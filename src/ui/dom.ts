/** Tiny DOM helper utilities (keeps the UI modules terse and allocation-light). */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string; html?: string; dataset?: Record<string, string> } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v as string;
    else if (k === 'html') node.innerHTML = v as string;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k in node) (node as any)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Format ms → m:ss.mmm (or --:--.--- for non-finite). */
export function formatTime(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '--:--.---';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = Math.floor(ms % 1000);
  return `${m}:${s.toString().padStart(2, '0')}.${mm.toString().padStart(3, '0')}`;
}

export function formatDelta(ms: number): string {
  if (!isFinite(ms)) return '';
  const sign = ms >= 0 ? '+' : '-';
  const a = Math.abs(ms);
  return `${sign}${(a / 1000).toFixed(2)}`;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

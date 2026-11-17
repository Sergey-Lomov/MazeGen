const ELLIPSIS = "…";

/** `text` unchanged when it fits `maxWidth`, otherwise its longest prefix that fits together with a
 *  trailing ellipsis (just the ellipsis when not even one character fits). `measure` returns the
 *  rendered width of a string and is assumed to grow with the string, which makes the search binary:
 *  one measurement per step rather than one per dropped character. */
export function truncateToWidth(text: string, maxWidth: number, measure: (candidate: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  const chars = Array.from(text);
  const withEllipsis = (keep: number) => `${chars.slice(0, keep).join("").trimEnd()}${ELLIPSIS}`;
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(withEllipsis(mid)) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return withEllipsis(low);
}

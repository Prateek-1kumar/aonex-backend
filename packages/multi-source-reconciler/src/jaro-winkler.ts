/**
 * Jaro-Winkler string similarity (0..1). Self-contained; no external dep.
 *
 * Jaro similarity counts matching characters within a sliding window of
 * floor(max(|s1|,|s2|)/2) - 1, then adjusts for transpositions.
 * Winkler boost: up to +0.1 for matching prefix (up to 4 chars).
 */

const PREFIX_SCALE = 0.1;
const MAX_PREFIX = 4;

export function jaroWinkler(s1: string, s2: string): number {
  const a = s1.toLowerCase();
  const b = s2.toLowerCase();
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;

  // Winkler prefix boost
  let prefix = 0;
  for (let i = 0; i < Math.min(a.length, b.length, MAX_PREFIX); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * PREFIX_SCALE * (1 - jaro);
}

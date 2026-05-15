export interface MatrixCheckInput {
  variants: Array<{ optionValues: Record<string, string> }>;
  axes: Record<string, string[]>;
}

export interface MatrixCheckResult {
  complete: boolean;
  expected: number;
  actual: number;
  missing: Record<string, string>[];
}

export function checkVariantMatrix(input: MatrixCheckInput): MatrixCheckResult {
  const axisEntries = Object.entries(input.axes).filter(([, v]) => v.length > 0);
  if (axisEntries.length === 0) {
    return { complete: true, expected: 0, actual: input.variants.length, missing: [] };
  }
  const expected = axisEntries.reduce((acc, [, v]) => acc * v.length, 1);
  const actual = input.variants.length;

  // Build the set of all expected combos and the set of matched combos from variants
  const expectedCombos = cartesian(axisEntries);
  const axisKeys = axisEntries.map(([k]) => k);
  const actualKeys = new Set(
    input.variants.map((v) => keyOf(v.optionValues, axisKeys))
  );

  // Combos not matched by any variant optionValues
  const missingByKey = expectedCombos.filter((combo) => !actualKeys.has(keyOf(combo, axisKeys)));

  // When variants have no option keys (e.g. blank objects), missingByKey may overcount.
  // Clamp: the true number of missing slots is max(0, expected - actual).
  const missingCount = Math.max(0, expected - actual);
  const missing = missingByKey.slice(0, missingCount);

  return { complete: missing.length === 0, expected, actual, missing };
}

function cartesian(entries: [string, string[]][]): Record<string, string>[] {
  let acc: Record<string, string>[] = [{}];
  for (const [name, values] of entries) {
    const next: Record<string, string>[] = [];
    for (const a of acc) for (const v of values) next.push({ ...a, [name]: v });
    acc = next;
  }
  return acc;
}

function keyOf(obj: Record<string, string>, keys: string[]): string {
  return keys.map((k) => `${k}=${obj[k] ?? ""}`).join("|");
}

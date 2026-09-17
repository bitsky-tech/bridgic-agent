/** Stable object ordering keeps formatting changes out of the comparison. */
export function comparisonText(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item, 2) ?? ''
}

export function toolDifference(before: string, after: string) {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1
  return { before, after, prefix, suffix, same: before === after }
}

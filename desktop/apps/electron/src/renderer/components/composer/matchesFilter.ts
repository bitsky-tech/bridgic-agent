/**
 * Case-insensitive substring filter shared by the composer dropdowns
 * (slash / mention menus in FreeFormInput, model search in ModelPickerMenu).
 *
 * Extracted so both menus filter identically from one definition — they
 * previously held two copies (`matchesFilter` / `matches`).
 */

/** True when `haystack` contains `query` (case-insensitive). Empty query matches all. */
export function matchesFilter(haystack: string, query: string): boolean {
  if (!query) return true
  return haystack.toLowerCase().includes(query.toLowerCase())
}

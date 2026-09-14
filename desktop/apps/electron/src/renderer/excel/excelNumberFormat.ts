function adjustSection(section: string, delta: 1 | -1): string {
  const base = section === 'General' || !/[0#]/.test(section) ? '0' : section
  const decimal = base.indexOf('.')
  if (delta === 1) {
    const insertion = Math.max(base.lastIndexOf('0'), base.lastIndexOf('#')) + 1
    return decimal >= 0
      ? `${base.slice(0, insertion)}0${base.slice(insertion)}`
      : `${base.slice(0, insertion)}.0${base.slice(insertion)}`
  }
  if (decimal < 0) return base
  const decimalDigits = [...base.slice(decimal + 1)].map((character, index) => ({ character, index }))
    .filter(({ character }) => character === '0' || character === '#')
  const last = decimalDigits.at(-1)
  if (!last) return base
  const removeAt = decimal + 1 + last.index
  const withoutDigit = `${base.slice(0, removeAt)}${base.slice(removeAt + 1)}`
  return decimalDigits.length === 1
    ? `${withoutDigit.slice(0, decimal)}${withoutDigit.slice(decimal + 1)}`
    : withoutDigit
}

export function adjustDecimalPlaces(pattern: string, delta: 1 | -1): string {
  return (pattern || 'General').split(';').map((section) => adjustSection(section, delta)).join(';')
}

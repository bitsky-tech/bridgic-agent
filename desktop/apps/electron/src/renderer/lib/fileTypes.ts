/** True when a file name represents an OOXML Word document. */
export function isDocxFileName(name: string): boolean {
  return name.trim().toLocaleLowerCase().endsWith('.docx')
}

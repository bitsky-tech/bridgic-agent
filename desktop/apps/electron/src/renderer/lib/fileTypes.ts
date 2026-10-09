/** True when a file name represents an OOXML Word document. */
export function isDocxFileName(name: string): boolean {
  return name.trim().toLocaleLowerCase().endsWith('.docx')
}

/** Office formats owned by the in-app viewers open on a single click. */
export function isOfficePreviewFileName(name: string): boolean {
  return /\.(?:docx|xlsx|pptx)$/i.test(name.trim())
}

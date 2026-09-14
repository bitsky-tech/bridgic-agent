import { IPC } from '../../shared/ipc-channels'
import { readWordDocumentFile } from '../word-document-file'
import { loggedHandle } from './logged-handle'
import { redactLocalPathLogArgs } from './path-log'

/** Register the narrow DOCX read capability used by the Session Word renderer. */
export function registerWordHandlers(): void {
  loggedHandle(
    IPC.word.readDocument,
    (_event, path: string) => readWordDocumentFile(path),
    { transformLogArgs: redactLocalPathLogArgs },
  )
}

/**
 * Static fixtures for composer menus (slash commands).
 *
 * The fixed "commands" group of slash commands is hardcoded here; capabilities
 * such as skills / workflows / schedules are pulled dynamically by the "/" menu
 * from the real atoms (skills/workflows/schedules) (see
 * menus/useSlashMenuState.ts) and no longer go through this file's mock. The @
 * menu only lists files already imported into the session and doesn't use this
 * file either.
 *
 * Only the three commands the docs specify are kept: /build (runs the backend
 * build flow) and /help (sent to the backend, which recognizes it and returns
 * the capability text) both insert a slash token and submit to the daemon;
 * /schedule is the sole exception — it prefills a schedule template in place in
 * the **current** input box (see FreeFormInput::pickSlashRow). The old mock
 * commands (/new /clear /model /think) were removed per the docs.
 */

/** A fixed slash command. Its user-facing copy is NOT here: `slashRows.ts` reads
 *  `composer.command.<id>.{label,description}` from the catalog so the menu follows the UI
 *  language. Only the id and the icon are structural. */
export interface SlashCommand {
  id: string
  icon: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'schedule', icon: 'clock' },
  { id: 'build', icon: 'hammer' },
  { id: 'help', icon: 'help' },
]

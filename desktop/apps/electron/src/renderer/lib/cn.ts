import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Concat class names and resolve Tailwind conflicts.
 * Use everywhere you'd otherwise write `clsx(...)`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

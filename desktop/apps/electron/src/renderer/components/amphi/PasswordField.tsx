import { useState, type InputHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'

import { inputClasses } from './Primitives'

/**
 * A password input with a reveal toggle.
 *
 * Masking hides typos as effectively as it hides the password: a mistyped or
 * mis-pasted character is invisible until sign-in fails with a message that
 * cannot say which character was wrong. Revealing is the cheaper trade here —
 * this field is inside the user's own settings window.
 *
 * The toggle is a real button so it is keyboard-reachable, but carries
 * `tabIndex={-1}` so Tab runs field → submit rather than detouring through it.
 */
export function PasswordField({
  className = '',
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const { t } = useTranslation()
  const [revealed, setRevealed] = useState(false)

  return (
    <div className="relative">
      <input
        {...rest}
        type={revealed ? 'text' : 'password'}
        className={`${inputClasses} pr-10 ${className}`}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setRevealed((shown) => !shown)}
        aria-label={revealed ? t('cloud.hidePassword') : t('cloud.showPassword')}
        aria-pressed={revealed}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-text-tertiary
                   transition-colors hover:bg-bg-hover hover:text-text-secondary"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.3" />
          {revealed && (
            <path d="m2.5 2.5 11 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          )}
        </svg>
      </button>
    </div>
  )
}

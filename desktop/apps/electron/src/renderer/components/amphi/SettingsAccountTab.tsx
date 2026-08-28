import { useAtomValue, useSetAtom } from 'jotai'
import { CircleUser, Wallet } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  cloudAccountAtom,
  cloudBusyAtom,
  cloudErrorAtom,
  cloudRegisterAtom,
  cloudSignInAtom,
  cloudSignOutAtom,
} from '@/atoms/cloud'
import { rlog } from '@/lib/logger'
import { PasswordField } from './PasswordField'
import { Btn, getBtnStyle, inputClasses } from './Primitives'
import { SettingsTabLayout } from './SettingsTabLayout'

/**
 * Bridgic account — sign in to spend platform credits instead of your own key.
 *
 * Signing in writes an ordinary provider channel (see `atoms/cloud`), so the
 * model picker and the chat path need to know nothing about accounts. This tab
 * only owns the credentials form and the balance readout.
 */
export function SettingsAccountTab() {
  const { t } = useTranslation()
  const account = useAtomValue(cloudAccountAtom)
  const busy = useAtomValue(cloudBusyAtom)
  const error = useAtomValue(cloudErrorAtom)
  const signIn = useSetAtom(cloudSignInAtom)
  const register = useSetAtom(cloudRegisterAtom)
  const signOut = useSetAtom(cloudSignOutAtom)

  const emailId = useId()
  const passwordId = useId()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [registering, setRegistering] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const submitLabel = registering ? t('cloud.register') : t('cloud.signIn')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!email.trim() || !password) {
      setLocalError(t('cloud.emptyFields'))
      return
    }
    setLocalError(null)
    const action = registering ? register : signIn
    void action({ email: email.trim(), password }).then(
      () => setPassword(''),
      // The atom already stored the reason in `cloudErrorAtom`; this only keeps
      // the rejection from surfacing as an unhandled promise.
      (err: unknown) => rlog.warn('[account] sign-in rejected', err),
    )
  }

  if (account) {
    return (
      <SettingsTabLayout>
        <section>
          <h2 className="text-sm font-semibold text-text-primary">{t('cloud.title')}</h2>
          <p className="mt-1 flex items-center gap-2 text-sm text-text-secondary">
            <CircleUser size={15} aria-hidden />
            {t('cloud.signedInAs', { email: account.email })}
          </p>
        </section>

        <section className="flex items-center justify-between rounded-md border border-border-default px-4 py-3">
          <span className="flex items-center gap-2 text-sm text-text-secondary">
            <Wallet size={15} aria-hidden />
            {t('cloud.balance')}
          </span>
          <span className="text-sm font-semibold tabular-nums text-text-primary">
            {t('cloud.credits', { n: account.creditsBalance.toLocaleString() })}
          </span>
        </section>

        <div>
          <Btn onClick={() => void signOut()}>{t('cloud.signOut')}</Btn>
        </div>
      </SettingsTabLayout>
    )
  }

  return (
    <SettingsTabLayout>
      <section>
        <h2 className="text-sm font-semibold text-text-primary">{t('cloud.title')}</h2>
        <p className="mt-1 text-sm leading-[1.6] text-text-secondary">{t('cloud.subtitle')}</p>
      </section>

      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={emailId} className="text-sm text-text-secondary">
            {t('cloud.email')}
          </label>
          <input
            id={emailId}
            className={inputClasses}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={passwordId} className="text-sm text-text-secondary">
            {t('cloud.password')}
          </label>
          <PasswordField
            id={passwordId}
            autoComplete={registering ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {(localError ?? error) && (
          <p role="alert" className="text-sm text-status-error">
            {localError ?? error}
          </p>
        )}

        <div className="flex items-center gap-3">
          {/* A real <button type="submit">, not a Btn: Btn renders a div, and
              this form needs Enter-to-submit and a native disabled state. */}
          <button
            type="submit"
            disabled={busy}
            style={getBtnStyle('primary')}
            className="disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? t('cloud.signingIn') : submitLabel}
          </button>
          <button
            type="button"
            className="text-sm text-text-secondary underline-offset-2 hover:underline"
            onClick={() => {
              setRegistering((prev) => !prev)
              setLocalError(null)
            }}
          >
            {registering ? t('cloud.toggleToSignIn') : t('cloud.toggleToRegister')}
          </button>
        </div>
      </form>
    </SettingsTabLayout>
  )
}

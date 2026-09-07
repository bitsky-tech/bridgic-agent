/**
 * Bridgic cloud account — sign-in, balance, and the platform credit channel.
 *
 * The platform plan is not a new kind of provider. Signing in stores an ordinary
 * `provider_credentials` row whose api_key happens to be the cloud access token
 * and whose base_url points at our gateway, which speaks the OpenAI wire. So the
 * existing `build_llm` dispatch, the model picker, and the whole chat path work
 * on it untouched — the only thing sign-in adds is *where the key comes from*.
 *
 * Endpoints on the gateway:
 *   - `POST /auth/register`  → create an account, returns a token
 *   - `POST /auth/login`     → returns a token
 *   - `GET  /me`             → account + credit balance
 *   - `GET  /me/models`      → models this account may use, with prices
 */
import { atom } from 'jotai'
import type { Setter } from 'jotai'

import { i18n } from '../lib/i18n'
import { rlog } from '../lib/logger'
import { addProviderAtom, deleteProviderAtom, fetchProviderApiKeyAtom } from './models'

/** Slug the platform channel is stored under in `provider_credentials`. */
export const CLOUD_PROVIDER_ID = 'bridgic'

/**
 * Where the gateway lives. Pointed at a local instance for now; this becomes the
 * production host once one exists.
 */
export const CLOUD_BASE_URL = 'http://127.0.0.1:8787'

export interface CloudAccount {
  accountId: number
  email: string
  creditsBalance: number
  /** How many credits one yuan buys. Served by the gateway, never assumed:
   *  a balance means nothing without it, and a hard-coded guess keeps being
   *  wrong silently after operations changes the rate. */
  creditsPerYuan: number
}

export interface CloudModel {
  modelId: string
  displayName: string
  contextWindow: number
  filingNumber: string | null
}

export interface CloudCredentials {
  email: string
  password: string
}

/**
 * A gateway failure with its status kept beside the message.
 *
 * The message is the gateway's own `detail`, written for a human and rewritten
 * whenever the wording is. Deciding "this token is dead" by looking for `401`
 * or `credential` inside that string is a guess that holds until someone edits
 * a sentence; the status is the fact. Null means the request never reached the
 * gateway at all.
 */
export class CloudError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'CloudError'
    this.status = status
  }
}

const _token = atom<string | null>(null)
const _account = atom<CloudAccount | null>(null)
const _error = atom<string | null>(null)
const _busy = atom(false)

export const cloudAccountAtom = atom((get) => get(_account))
export const cloudErrorAtom = atom((get) => get(_error))
export const cloudBusyAtom = atom((get) => get(_busy))
export const cloudSignedInAtom = atom((get) => get(_account) !== null)

export const clearCloudErrorAtom = atom(null, (_get, set) => {
  set(_error, null)
})

async function cloudFetch<T>(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<T> {
  const { token, headers, ...rest } = init

  let response: Response
  try {
    response = await fetch(`${CLOUD_BASE_URL}${path}`, {
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    })
  } catch (cause) {
    // fetch rejects for every transport-level failure with one opaque message
    // ("Failed to fetch"), and the browser withholds the real reason on purpose
    // — a refused connection, a DNS miss and a blocked CORS preflight are
    // indistinguishable here. Surfacing that string tells the user nothing, so
    // it is replaced with the one thing they can act on.
    rlog.warn('[cloud] request failed before a response', cause)
    throw new CloudError(i18n.t('cloud.unreachable'), null)
  }
  if (!response.ok) {
    // The gateway puts a human-readable reason in `detail`; surface it rather
    // than a bare status, since "insufficient credits" and "wrong password" are
    // both things the user can act on.
    let detail = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { detail?: string }
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new CloudError(detail, response.status)
  }
  return (await response.json()) as T
}

interface TokenResponse {
  access_token: string
  account_id: number
  credits_balance: number
}

interface ModelPayload {
  model_id: string
  display_name: string
  context_window: number
  filing_number: string | null
}

/**
 * Pull `/me/models` and make the local channel say the same thing.
 *
 * Run on sign-in and again on every refresh. What an account may buy is the
 * operator's to change, and nothing tells this machine when they do — a list
 * frozen at sign-in keeps offering models that were withdrawn, which 404 with
 * a reason the user never sees, and hides ones put on sale since.
 *
 * `credential` is given on sign-in only. The backend upsert overwrites just the
 * fields it is handed, so a refresh rewrites the list without moving the token
 * around; `current_model` reconciliation follows either way.
 */
async function syncModels(
  set: Setter,
  token: string,
  credential?: { apiKey: string },
): Promise<void> {
  const models = await cloudFetch<ModelPayload[]>('/me/models', { token })
  await set(addProviderAtom, {
    providerId: CLOUD_PROVIDER_ID,
    ...(credential
      ? {
          apiKey: credential.apiKey,
          baseUrl: `${CLOUD_BASE_URL}/v1`,
          protocol: 'openai' as const,
          displayName: i18n.t('cloud.channelName'),
        }
      : {}),
    models: models.map((m) => m.model_id),
    modelLimits: Object.fromEntries(
      models
        .filter((m) => m.context_window > 0)
        .map((m) => [m.model_id, { input: m.context_window }]),
    ),
  })
}

/**
 * Sign in (or register) and wire the returned token into the local provider list.
 *
 * The credential write reuses `addProviderAtom`, so the channel lands in exactly
 * the same shape a hand-configured one would, including the `current_model`
 * reconciliation that follows it.
 */
async function performSignIn(
  set: Setter,
  input: CloudCredentials,
  register: boolean,
): Promise<void> {
  set(_busy, true)
  set(_error, null)
  try {
    const auth = await cloudFetch<TokenResponse>(
      register ? '/auth/register' : '/auth/login',
      { method: 'POST', body: JSON.stringify(input) },
    )
    await syncModels(set, auth.access_token, { apiKey: auth.access_token })

    set(_token, auth.access_token)
    // The rate is not on the token response, so seed a placeholder and let the
    // refresh below replace the whole record with the server's own numbers.
    set(_account, {
      accountId: auth.account_id,
      email: input.email,
      creditsBalance: auth.credits_balance,
      creditsPerYuan: 0,
    })
    await set(cloudRefreshAtom, { quiet: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    rlog.error('[cloud] sign-in failed', err)
    set(_error, msg)
    throw err
  } finally {
    set(_busy, false)
  }
}

export const cloudSignInAtom = atom(
  null,
  async (_get, set, input: CloudCredentials): Promise<void> => {
    await performSignIn(set, input, false)
  },
)

export const cloudRegisterAtom = atom(
  null,
  async (_get, set, input: CloudCredentials): Promise<void> => {
    await performSignIn(set, input, true)
  },
)

/**
 * Load the account, recovering the session first if this is a fresh app start.
 *
 * The token lives in memory, so a restart loses it — while the credential itself
 * is still on the User row, and platform models still work. Without this the
 * Account tab would show a sign-in form to someone who is signed in, and any
 * refresh would have no token to refresh with.
 *
 * `quiet` suppresses the spinner for the automatic load on mount, so opening the
 * tab does not flash a busy state; the manual refresh button passes false.
 */
export const cloudRefreshAtom = atom(
  null,
  async (get, set, options?: { quiet?: boolean }): Promise<void> => {
    const quiet = options?.quiet ?? false
    let token = get(_token)

    if (!token) {
      // Recover from the stored provider credential — its api_key IS the token.
      const stored = await set(fetchProviderApiKeyAtom, CLOUD_PROVIDER_ID)
      if (!stored) return // Genuinely signed out; leave the form as it is.
      token = stored
      set(_token, stored)
    }

    if (!quiet) set(_busy, true)
    try {
      const me = await cloudFetch<{
        account_id: number
        email: string
        credits_balance: number
        credits_per_yuan: number
      }>('/me', { token })
      set(_account, {
        accountId: me.account_id,
        email: me.email,
        creditsBalance: me.credits_balance,
        creditsPerYuan: me.credits_per_yuan,
      })
      set(_error, null)
      // Re-read what this account may buy while the token is known good. In
      // its own try: the balance is what this atom exists to load, and a
      // model list that would not come back must not take it down.
      try {
        await syncModels(set, token)
      } catch (cause) {
        rlog.warn('[cloud] refreshing the model list failed', cause)
      }
    } catch (err) {
      // A rejected token means the account was suspended, or the password
      // changed elsewhere. Drop the session *and* the credential: the token IS
      // the credential, so a row left behind is a dead channel still sitting in
      // the model picker, offering whatever it last saw. Same end state as
      // signing out, which is what a rejected token amounts to.
      if (err instanceof CloudError && err.status === 401) {
        set(_token, null)
        set(_account, null)
        try {
          await set(deleteProviderAtom, CLOUD_PROVIDER_ID)
        } catch (cause) {
          rlog.warn('[cloud] removing the rejected channel failed', cause)
        }
      } else {
        rlog.warn('[cloud] balance refresh failed', err)
      }
      if (!quiet) set(_error, err instanceof Error ? err.message : String(err))
    } finally {
      if (!quiet) set(_busy, false)
    }
  },
)

/**
 * Sign out, removing the stored credential.
 *
 * Dropping the provider row is the point: the token IS the credential, so
 * leaving it behind would keep the account spendable from this machine after the
 * user asked to be signed out.
 */
export const cloudSignOutAtom = atom(null, async (_get, set): Promise<void> => {
  try {
    await set(deleteProviderAtom, CLOUD_PROVIDER_ID)
  } catch (err) {
    rlog.warn('[cloud] removing the platform channel failed', err)
  }
  set(_token, null)
  set(_account, null)
  set(_error, null)
})

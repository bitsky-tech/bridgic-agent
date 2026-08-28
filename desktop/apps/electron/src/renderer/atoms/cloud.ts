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
import { addProviderAtom, deleteProviderAtom } from './models'

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
    throw new Error(i18n.t('cloud.unreachable'))
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
    throw new Error(detail)
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
    const models = await cloudFetch<ModelPayload[]>('/me/models', {
      token: auth.access_token,
    })

    await set(addProviderAtom, {
      providerId: CLOUD_PROVIDER_ID,
      apiKey: auth.access_token,
      baseUrl: `${CLOUD_BASE_URL}/v1`,
      protocol: 'openai',
      displayName: i18n.t('cloud.channelName'),
      models: models.map((m) => m.model_id),
      modelLimits: Object.fromEntries(
        models
          .filter((m) => m.context_window > 0)
          .map((m) => [m.model_id, { input: m.context_window }]),
      ),
    })

    set(_token, auth.access_token)
    set(_account, {
      accountId: auth.account_id,
      email: input.email,
      creditsBalance: auth.credits_balance,
    })
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

/** Re-read the balance. Cheap enough to call after each turn. */
export const cloudRefreshAtom = atom(null, async (get, set): Promise<void> => {
  const token = get(_token)
  if (!token) return
  try {
    const me = await cloudFetch<{
      account_id: number
      email: string
      credits_balance: number
    }>('/me', { token })
    set(_account, {
      accountId: me.account_id,
      email: me.email,
      creditsBalance: me.credits_balance,
    })
  } catch (err) {
    // A failed refresh leaves the last known balance on screen. It is stale, not
    // wrong, and the relay refuses a drained account regardless of what the UI
    // last showed.
    rlog.warn('[cloud] balance refresh failed', err)
  }
})

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

/**
 * Modal-layer components rendered above AppLayout.
 *
 * Each is independently exported and gated by `activeModalAtom`. They share
 * the Modal shell (./modal.tsx) but otherwise have bespoke layouts. This
 * file is intentionally a collection — modals are tightly coupled by
 * domain but small enough that splitting them into 11 files would hurt
 * readability more than it helps.
 *
 * Refactored to Tailwind className per §1.22 (file remains an approved
 * oversized exception in 50-dont-touch.md — it's a collection file).
 */

import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CUSTOM_PROTOCOL_PRESETS,
  addProviderAtom,
  checkCodexLocalAtom,
  clearModelsLastActionErrorAtom,
  configuredProvidersAtom,
  deleteProviderAtom,
  fetchProviderApiKeyAtom,
  fetchProviderModelsAtom,
  getProviderDisplay,
  getProviderDisplayById,
  getProviderCatalogDisplayName,
  getConfiguredProviderDisplayName,
  getProviderPreset,
  modelsHydrationStateAtom,
  modelsLastActionErrorAtom,
  normalizeBaseUrl,
  providerCatalogAtom,
  setCodexModelsAtom,
  startCodexOAuthAtom,
  testProviderAtom,
  toggleProviderAtom,
  useLocalCodexAtom,
  type ProviderPreset,
} from '@/atoms/models'
import type { ConfiguredProvider, FetchedModel, ModelLimits } from '@/lib/amphiClient'
import {
  backendEndpointAtom,
  backendErrorAtom,
  backendStateAtom,
} from '@/atoms/backend'
import { BackendState, type AutostartStatusJson } from '../../../main/python-client/types'
import { themeAtom } from '@/atoms/theme'
import { settingsAtom } from '@/atoms/settings'
import { localeAtom, UiLocale } from '@/atoms/locale'
import { useSetThemeMode } from '@/hooks/useTheme'
import { useSetLocale } from '@/hooks/useLocale'
import { useUpdateSettings } from '@/hooks/useSettingsBridge'
import {
  ThemeMode,
  ZOOM_LEVEL_MAX,
  ZOOM_LEVEL_MIN,
  ZOOM_LEVEL_STEP,
  clampZoomLevel,
  zoomPercent,
} from '@app/shared/types'
import {
  EditFieldKind,
  PreviewFieldKind,
  settingsFormDirtyAtom,
  setSettingsFormDirtyAtom,
} from '@/atoms/amphi'
import { SettingsModeTab } from '@/components/permissions'
import { cn } from '@/lib/cn'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { requestConfirmAtom } from '@/atoms/confirm'
import { showcasePageUrl } from '@/lib/showcaseClient'
import type { ShowcaseWorkflow } from '@/lib/showcaseClient'
import { rlog } from '@/lib/logger'
import { EmbeddedShowcasePage } from './EmbeddedShowcasePage'
import { Icons } from './Icons'
import { NavItem } from './NavItem'
import { Tooltip } from './Tooltip'
import { Modal } from './Modal'
import { ModalBackdrop } from './ModalBackdrop'
import { SettingsAboutTab } from './SettingsAboutTab'
import { SettingsPrivacyTab } from './SettingsPrivacyTab'
import {
  Badge,
  Btn,
  Card,
  SelectItem,
  Tag,
  Toggle,
  inputClasses,
} from './Primitives'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { APP_PRODUCT_NAME } from '@shared/app-meta'

/* ─── Settings ─── */

/**
 * Settings modal tab discriminator. Exported so the sidebar's gateway
 * status dot can pass `SettingsTabId.Gateway` rather than a magic
 * number index (left-sidebar.tsx).
 */
export const SettingsTabId = {
  Model: 'model',
  Mode: 'mode',
  Gateway: 'gateway',
  Appearance: 'appearance',
  Privacy: 'privacy',
  About: 'about',
} as const
export type SettingsTabId = (typeof SettingsTabId)[keyof typeof SettingsTabId]

/**
 * Settings Modal — vertical tab layout on the left.
 *
 * Fixed 880×600; the left 200px is the tab column + a large "settings" title at the top + the version
 * number at the bottom; the right side is the tab title + X to close + a scrolling content area.
 *
 * Five tabs: model config / execution mode / gateway / appearance / privacy. Skills are not in
 * settings — they have their own central management view (left Nav → CenterSkills, since 2026-06-11).
 */
export function SettingsModal({
  initialTab = SettingsTabId.Model,
  onClose,
}: { initialTab?: SettingsTabId; onClose?: () => void }) {
  const { t } = useTranslation()
  const [activeTabId, setActiveTabId] = useState<SettingsTabId>(initialTab)
  const formDirty = useAtomValue(settingsFormDirtyAtom)
  const requestConfirm = useSetAtom(requestConfirmAtom)
  // Before closing / switching tabs: if the current form has unsaved changes, raise a custom
  // confirmation — so that edited channel credentials (the model name especially) are not lost by
  // closing the window / navigating away. dirty is reported by ChannelCredentialForm.
  const confirmDiscard = useCallback(
    (): Promise<boolean> =>
      formDirty
        ? requestConfirm({
            title: t('modals.settings.unsaved.title'),
            message: t('modals.settings.unsaved.message'),
            confirmLabel: t('modals.settings.unsaved.leave'),
            danger: true,
          })
        : Promise.resolve(true),
    [formDirty, requestConfirm, t],
  )
  const handleClose = useCallback(async () => {
    if (await confirmDiscard()) onClose?.()
  }, [confirmDiscard, onClose])
  const handleTabSwitch = async (id: SettingsTabId) => {
    if (id === activeTabId) return
    if (await confirmDiscard()) setActiveTabId(id)
  }
  useEscapeToClose(handleClose)
  const tabs: { id: SettingsTabId; label: string; icon: (size?: number) => React.ReactNode }[] = [
    { id: SettingsTabId.Model,      label: t('modals.settings.tabs.model'), icon: Icons.robot },
    {
      id: SettingsTabId.Mode,
      label: t('modals.settings.tabs.mode'),
      icon: (s = 16) => (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
          <path
            d="M8 1.5l5 2v4c0 3-2.2 5.2-5 6.5-2.8-1.3-5-3.5-5-6.5v-4l5-2z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    { id: SettingsTabId.Gateway,    label: t('modals.settings.tabs.gateway'),    icon: Icons.link },
    { id: SettingsTabId.Appearance, label: t('modals.settings.tabs.appearance'),    icon: Icons.settings },
    { id: SettingsTabId.Privacy,    label: t('modals.settings.tabs.privacy'),       icon: Icons.eye },
    { id: SettingsTabId.About,      label: t('modals.settings.tabs.about'),         icon: Icons.help },
  ]
  const activeLabel = tabs.find((t) => t.id === activeTabId)?.label
  return (
    // It used to be a hand-drawn `absolute inset-0` + inline background, with neither a portal nor
    // ModalBackdrop — when fixing the Windows caption-area occlusion it was missed entirely (searching for
    // `fixed inset-0` does not find `absolute`), and only the user's own testing revealed the settings
    // dialog still behaved the old way.
    <ModalBackdrop onClose={handleClose}>
      <Card className="w-[880px] h-[600px] flex flex-row shadow-modal border border-border-default overflow-hidden">
        {/* Left tab nav */}
        <div className="w-[200px] bg-bg-surface border-r border-border-subtle flex flex-col flex-shrink-0">
          <div className="px-4 pt-5 pb-3 flex items-center gap-2">
            <span className="text-lg font-bold text-text-primary">{t('modals.settings.title')}</span>
          </div>
          <div className="flex-1 px-2 flex flex-col gap-0.5">
            {tabs.map((tab) => (
              <NavItem
                key={tab.id}
                testId={`tab-${tab.label}`}
                icon={tab.icon}
                label={tab.label}
                active={activeTabId === tab.id}
                onClick={() => {
                  void handleTabSwitch(tab.id)
                }}
              />
            ))}
          </div>
        </div>

        {/* Right content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-6 py-5 flex items-center justify-between flex-shrink-0">
            <span className="text-lg font-semibold text-text-primary">{activeLabel}</span>
            <div onClick={handleClose} className="cursor-pointer text-text-tertiary p-1">
              {Icons.x(18)}
            </div>
          </div>
          <div className="flex-1 overflow-auto px-6 pb-6">
            {activeTabId === SettingsTabId.Model && <SettingsModelTab />}
            {activeTabId === SettingsTabId.Mode && <SettingsModeTab />}
            {activeTabId === SettingsTabId.Gateway && <SettingsGatewayTab />}
            {activeTabId === SettingsTabId.Appearance && <SettingsAppearanceTab />}
            {activeTabId === SettingsTabId.Privacy && <SettingsPrivacyTab />}
            {activeTabId === SettingsTabId.About && <SettingsAboutTab onRequestClose={handleClose} />}
          </div>
        </div>
      </Card>
    </ModalBackdrop>
  )
}

/** Sub-view tag for `SettingsModelTab`.
 *
 *  Phase 2: step2 carries the form's initial preset (built-in vendor
 *  preset OR custom-protocol preset) rather than a catalog id, because
 *  Step1 may now route the user into the form with a custom-protocol
 *  preset that has no catalog row. */
type ModelTabView =
  | { kind: 'list' }
  | { kind: 'step1' }
  | { kind: 'step2'; preset: ProviderPreset }
  | { kind: 'edit'; providerId: string }

/**
 * Model config tab — a dispatcher that switches between list / step1 / step2 / edit according to its
 * internal view state.
 * The view state is component-level UI, so useState (§1.12). The data comes from atoms/models.ts
 * (backed by the daemon's provider handlers).
 */
function SettingsModelTab() {
  const { t } = useTranslation()
  const [view, setView] = useState<ModelTabView>({ kind: 'list' })
  const hydrationState = useAtomValue(modelsHydrationStateAtom)

  if (hydrationState === 'loading') {
    return <div className="text-xs text-text-tertiary py-8 text-center">{t('modals.model.loading')}</div>
  }
  if (view.kind === 'step1') {
    return (
      <ModelAddStep1
        onPickPreset={(preset) => setView({ kind: 'step2', preset })}
        onBack={() => setView({ kind: 'list' })}
      />
    )
  }
  if (view.kind === 'step2') {
    return (
      <ModelAddStep2
        preset={view.preset}
        onBack={() => setView({ kind: 'step1' })}
        onDone={() => setView({ kind: 'list' })}
      />
    )
  }
  if (view.kind === 'edit') {
    return (
      <ModelEdit
        providerId={view.providerId}
        onBack={() => setView({ kind: 'list' })}
        onDone={() => setView({ kind: 'list' })}
      />
    )
  }
  return (
    <ModelList
      onAdd={() => setView({ kind: 'step1' })}
      onEdit={(providerId) => setView({ kind: 'edit', providerId })}
    />
  )
}

/**
 * Configured channel list — one row = one ConfiguredProvider (no longer expanded down to each model).
 *
 * Design alignment:
 *   - 38×38 brand-coloured tile (Anthropic orange, OpenAI green, DeepSeek blue)
 *   - the "shield" icon to the right of the channel name = officially built-in marker
 *   - subtitle: `API Key · ${available_models.length} models enabled`
 *   - on the right: edit / trash / enable Toggle
 *
 * Phase 1 limitations (features the backend does not support fall back to disabled + tooltip):
 *   - the enable Toggle is currently always on, disabled with an explanatory tooltip (the backend has
 *     no is_enabled, so off = delete = lose the key, which is not "temporarily disabled" semantics)
 *   - every current provider comes from the catalog, so they all carry the "officially built-in" shield
 *   - "test connection" is deferred to Phase 2
 *
 * Deletion goes through the unified custom confirmation dialog ConfirmDialog(requestConfirm) rather
 * than the browser's native confirm (ugly and uncontrollable); the unsaved-changes prompt and other
 * destructive operations share it.
 */
function ModelList({
  onAdd,
  onEdit,
}: {
  onAdd: () => void
  onEdit: (providerId: string) => void
}) {
  const { t } = useTranslation()
  const configured = useAtomValue(configuredProvidersAtom)
  const catalog = useAtomValue(providerCatalogAtom)
  const deleteProvider = useSetAtom(deleteProviderAtom)
  const toggleProvider = useSetAtom(toggleProviderAtom)
  const lastActionError = useAtomValue(modelsLastActionErrorAtom)
  const clearLastActionError = useSetAtom(clearModelsLastActionErrorAtom)
  const requestConfirm = useSetAtom(requestConfirmAtom)

  const handleDelete = async (cp: ConfiguredProvider, displayName: string) => {
    const n = cp.available_models.length
    const msg =
      n > 1
        ? t('modals.model.delete.messageWithModels', { name: displayName, n })
        : t('modals.model.delete.message', { name: displayName })
    if (
      !(await requestConfirm({
        title: t('modals.model.delete.title'),
        message: msg,
        confirmLabel: t('modals.common.delete'),
        danger: true,
      }))
    ) return
    // The error is already written to modelsLastActionErrorAtom; swallow it here to prevent an unhandled rejection.
    void deleteProvider(cp.id).catch(() => {})
  }

  const handleToggle = (cp: ConfiguredProvider) => {
    // The error is also written to the banner by the atom; swallow it here to prevent React unhandled-rejection noise.
    void toggleProvider({ providerId: cp.id, enabled: !cp.is_enabled })
      .catch(() => {})
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="text-sm text-text-secondary leading-[1.6]">
          {t('modals.model.list.desc')}
        </div>
        <Btn variant="primary" size="sm" className="flex-shrink-0" onClick={onAdd}>
          {Icons.plus(14)} {t('modals.model.list.add')}
        </Btn>
      </div>

      {/* Write-failure banner — an error in any step of switching models / adding / deleting lands here.
          The banner stays up until the user clicks × or the next successful operation clears it. */}
      {lastActionError && (
        <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded-md bg-status-error-bg text-xs text-status-error">
          <span className="flex-1 leading-[1.5]">{lastActionError}</span>
          <button
            type="button"
            onClick={clearLastActionError}
            className="text-status-error/70 hover:text-status-error flex-shrink-0"
            aria-label={t('modals.common.clearError')}
          >
            {Icons.x(12)}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {configured.map((cp) => {
          const catEntry = catalog.find((c) => c.id === cp.id)
          const display = catEntry ? getProviderDisplay(catEntry) : getProviderDisplayById(cp.id)
          // Phase 2: user-given display_name wins. Fall back to catalog
          // name (built-in vendor without rename) then to the slug.
          const displayName = catEntry
            ? getConfiguredProviderDisplayName(catEntry, cp.display_name, t)
            : cp.display_name ?? cp.id
          // Phase 2: catalog membership = "officially built-in" (shield); custom slugs
          // (a company gateway, a self-hosted deployment, a third-party proxy) → no shield + the protocol labelled visibly.
          const isOfficial = !!catEntry
          return (
            <ChannelRow
              key={cp.id}
              providerId={cp.id}
              displayName={displayName}
              iconLetter={display.iconLetter}
              brandColor={display.brandColor}
              authMode={cp.auth_mode}
              protocol={cp.protocol === 'openai-codex' ? 'openai' : cp.protocol}
              enabledModelsCount={cp.available_models.length}
              isOfficial={isOfficial}
              isEnabled={cp.is_enabled}
              onEdit={() => onEdit(cp.id)}
              onDelete={() => handleDelete(cp, displayName)}
              onToggle={() => handleToggle(cp)}
            />
          )
        })}
        {configured.length === 0 && (
          <div className="text-xs text-text-tertiary italic py-8 text-center">
            {t('modals.model.list.empty')}
          </div>
        )}
      </div>
    </div>
  )
}

/** Single channel row in the settings list. Extracted to keep ModelList terse.
 *
 *  Phase 2.5: Toggle is real — flips `is_enabled` on the backend via
 *  `toggleProviderAtom`. Disabled rows stay in the list (visibly off) so
 *  the user can re-enable without re-entering credentials. Row appearance
 *  dims when disabled to signal "this channel won't appear in the chat
 *  picker right now" without removing it. */
function ChannelRow({
  providerId,
  displayName,
  iconLetter,
  brandColor,
  authMode,
  protocol,
  enabledModelsCount,
  isOfficial,
  isEnabled,
  onEdit,
  onDelete,
  onToggle,
}: {
  providerId: string
  displayName: string
  iconLetter: string
  brandColor: string
  authMode: 'oauth' | 'api_key'
  protocol: 'openai' | 'anthropic'
  enabledModelsCount: number
  isOfficial: boolean
  isEnabled: boolean
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
}) {
  // Subtitle semantics follow the design's isOfficial-aware two-part form (plan v3 §3):
  //   - built-in (official=true): "{auth} · N models enabled"
  //   - custom (custom=false): "{protocol compatible} · N models enabled"
  // The protocol part is dropped for built-in vendors because their protocol is already implied by the brand.
  const { t } = useTranslation()
  let subLeft: string
  if (isOfficial) {
    subLeft = authMode === 'oauth' ? t('modals.model.authMode.oauth') : 'API Key'
  } else {
    subLeft = protocol === 'anthropic'
      ? t('modals.model.protocol.anthropicCompat')
      : t('modals.model.protocol.openaiCompat')
  }
  return (
    <div
      data-testid={`channel-row-${providerId}`}
      className={cn(
        'flex items-center justify-between px-4 py-3.5 rounded-lg bg-bg-hover border border-border-subtle',
        !isEnabled && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-[38px] h-[38px] rounded-md flex items-center justify-center text-base font-bold text-white flex-shrink-0"
          style={{ background: brandColor }}
        >
          {iconLetter}
        </div>
        <div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-text-primary">{displayName}</span>
            {isOfficial && <OfficialShield />}
            {!isOfficial && <Tag>{t('modals.model.custom')}</Tag>}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {t('modals.model.row.sub', { left: subLeft, n: enabledModelsCount })}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Btn variant="ghost" size="xs" onClick={onEdit}>
          {Icons.edit(13)}
        </Btn>
        <Btn variant="ghost" size="xs" className="text-text-tertiary" onClick={onDelete}>
          {Icons.trash(13)}
        </Btn>
        {/* A real Toggle: wired to POST /me/providers/{id}/toggle. When the active one is disabled the backend
            automatically promotes the next enabled+keyed provider and the frontend reflects the new active one
            through hydrate; with no candidate the mirrored credentials are cleared and chat returns 503. */}
        <Tooltip content={isEnabled ? t('modals.model.row.toggleOff') : t('modals.model.row.toggleOn')}>
          <span onClick={onToggle} className="flex cursor-pointer" role="button" tabIndex={0}>
            <Toggle on={isEnabled} />
          </span>
        </Tooltip>
      </div>
    </div>
  )
}

/** Tiny shield icon marking a row as a built-in (vs custom) provider. */
function OfficialShield() {
  const { t } = useTranslation()
  return (
    <Tooltip content={t('modals.model.official')}>
      <span className="flex text-text-accent">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.5l5 2v4c0 3-2.2 5.2-5 6.5-2.8-1.3-5-3.5-5-6.5v-4l5-2z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M6 8l1.5 1.5L10.5 6"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      </span>
    </Tooltip>
  )
}

/**
 * Step 1 — provider / protocol picker.
 *
 * Phase 2: lists both **catalog vendors** (built-in presets) and **custom
 * protocol presets** (OpenAI-compat / Anthropic-compat). Both fire
 * `onPickPreset(ProviderPreset)` to the dispatcher; built-in presets carry
 * the catalog defaults (base_url + models + protocol), custom presets
 * carry just the protocol so the user fills the rest in the form.
 */
function ModelAddStep1({
  onPickPreset,
  onBack,
}: {
  onPickPreset: (preset: ProviderPreset) => void
  onBack: () => void
}) {
  const { t } = useTranslation()
  const catalog = useAtomValue(providerCatalogAtom)
  // Single selection state across both sections — value is either a
  // catalog provider id or a sentinel "custom:<protocol>" string.
  // useState lazy init reads catalog only on first render; switching catalog
  // later (rare — only on hydrate) doesn't re-seed, which is intentional:
  // user's in-flight selection survives a background catalog refresh.
  const [picked, setPicked] = useState<string | null>(() => catalog[0]?.id ?? null)

  const resolvePreset = (key: string | null): ProviderPreset | null => {
    if (!key) return null
    if (key.startsWith('custom:')) {
      const protocol = key.slice('custom:'.length) as 'openai' | 'anthropic'
      return CUSTOM_PROTOCOL_PRESETS.find((p) => p.protocol === protocol) ?? null
    }
    const entry = catalog.find((p) => p.id === key)
    return entry ? getProviderPreset(entry, getProviderCatalogDisplayName(entry, t)) : null
  }

  return (
    <div>
      <div
        onClick={onBack}
        className="flex items-center gap-1.5 mb-4 cursor-pointer text-text-secondary hover:text-text-primary text-xs"
      >
        ← {t('modals.model.step1.back')}
      </div>
      <div className="text-sm font-semibold text-text-primary mb-1">{t('modals.model.step1.title')}</div>
      <div className="text-xs text-text-secondary mb-4">
        {t('modals.model.step1.desc')}
      </div>

      {/* Built-in vendors — the pre-filled templates that exist in the backend's /providers catalog; clicking
          one carries protocol / base_url / models into the form as defaults. */}
      <SectionLabel>{t('modals.model.step1.builtin')}</SectionLabel>
      {catalog.length === 0 ? (
        <div className="text-xs text-text-tertiary italic py-6 text-center">
          {t('modals.model.step1.catalogEmpty')}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 mb-5">
          {catalog.map((p) => {
            const selected = picked === p.id
            const display = getProviderDisplay(p)
            const hasOAuth = p.auth_modes.includes('oauth')
            return (
              <div
                key={p.id}
                data-testid={`provider-${p.id}`}
                onClick={() => setPicked(p.id)}
                // §LS1: a 1px transparent border is always present, selected flips to brand-blue + a pale blue
                // background, zero displacement. The 36×36 tile uses the brand colour (no longer taking over the semantics of brand-gradient).
                className={cn(
                  'flex items-center gap-3 px-3.5 py-3 rounded-md cursor-pointer border bg-bg-surface',
                  selected ? 'border-brand-blue bg-accent-blue-subtle' : 'border-border-default',
                )}
              >
                <div
                  className="w-9 h-9 rounded-md flex items-center justify-center text-base font-bold text-white flex-shrink-0"
                  style={{ background: display.brandColor }}
                >
                  {display.iconLetter}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'text-sm font-semibold',
                        selected ? 'text-text-accent' : 'text-text-primary',
                      )}
                    >
                      {getProviderCatalogDisplayName(p, t)}
                    </span>
                    {display.tag === 'recommended' && <Badge color="success">{t('modals.model.tag.recommended')}</Badge>}
                    {display.tag === 'domestic' && <Tag>{t('modals.model.tag.domestic')}</Tag>}
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5">
                    {p.protocol === 'anthropic'
                      ? t('modals.model.protocol.anthropic')
                      : t('modals.model.protocol.openai')} ·
                    {' '}{t('modals.model.modelCount', { n: p.models.length })}
                  </div>
                </div>
                {hasOAuth && (
                  <span className="text-2xs text-text-tertiary whitespace-nowrap">
                    {t('modals.model.step1.supportsSubscription')}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Custom protocols — Phase 2: the backend no longer requires provider_id to be in the catalog, so
          these two cards are clickable and lead to a form with an empty slug + empty base_url + empty models for the user to fill in. */}
      <SectionLabel>{t('modals.model.step1.customProtocol')}</SectionLabel>
      <div className="text-xs text-text-tertiary mb-2">
        {t('modals.model.step1.customProtocolDesc')}
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {[
          {
            protocol: 'openai' as const,
            name: t('modals.model.protocol.openaiCompat'),
            desc: t('modals.model.step1.openaiAdapt'),
            color: '#8B5CF6',
          },
          {
            protocol: 'anthropic' as const,
            name: t('modals.model.protocol.anthropicCompat'),
            desc: t('modals.model.step1.anthropicAdapt'),
            color: '#A855F7',
          },
        ].map((p) => {
          const sentinel = `custom:${p.protocol}`
          const selected = picked === sentinel
          return (
            <div
              key={p.protocol}
              data-testid={`protocol-${p.protocol}`}
              onClick={() => setPicked(sentinel)}
              className={cn(
                'flex items-center gap-3 px-3.5 py-3 rounded-md cursor-pointer border bg-bg-surface',
                selected ? 'border-brand-blue bg-accent-blue-subtle' : 'border-border-default',
              )}
            >
              <div
                className="w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 bg-bg-hover"
                style={{ color: p.color }}
              >
                {Icons.link(18)}
              </div>
              <div className="flex-1 min-w-0">
                <span
                  className={cn(
                    'text-sm font-semibold',
                    selected ? 'text-text-accent' : 'text-text-primary',
                  )}
                >
                  {p.name}
                </span>
                <div className="text-xs text-text-secondary mt-0.5 font-mono">{p.desc}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end gap-2 mt-5">
        <Btn onClick={onBack}>{t('modals.common.cancel')}</Btn>
        <Btn
          variant="primary"
          size="md"
          onClick={() => {
            const preset = resolvePreset(picked)
            if (preset) onPickPreset(preset)
          }}
        >
          {t('modals.common.next')} {Icons.chevronRight(14)}
        </Btn>
      </div>
    </div>
  )
}

/** Small grey uppercase heading, used for the sections of Step1 / Step2. A uniform spec from the design. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold text-text-tertiary uppercase tracking-[0.3px] mb-2">
      {children}
    </div>
  )
}

/**
 * Add-credentials form — where you land after picking a vendor/protocol in Step1.
 *
 * Phase 2: `provider` is no longer required to be in the backend catalog — the user can also arrive
 * here by clicking a "custom protocol" card in Step1, in which case the preset is one of
 * CUSTOM_PROTOCOL_PRESETS and providerId is left empty for the user to fill in a slug in the form.
 */
function ModelAddStep2({
  preset,
  onBack,
  onDone,
}: {
  preset: ProviderPreset
  onBack: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  return (
    <ChannelCredentialForm
      key={`add:${preset.providerId}:${preset.protocol}`}
      initial={preset}
      mode="add"
      apiKeySetInitially={false}
      onBack={onBack}
      onDone={onDone}
      backLabel={t('modals.model.step2.back')}
      titlePrefix=""
    />
  )
}

/**
 * Edit an existing channel — visually identical to ModelAddStep2, differing only in the sub text
 * saying "API Key is set", and the backend still goes through the upsert path (POST /me/providers has
 * no PATCH), so "edit" really means "rotate the API Key + change base_url / models".
 *
 * The Edit entry point deserialises a ProviderPreset out of a ConfiguredProvider and feeds it to the shared form.
 */
function ModelEdit({
  providerId,
  onBack,
  onDone,
}: {
  providerId: string
  onBack: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const configured = useAtomValue(configuredProvidersAtom)
  const catalog = useAtomValue(providerCatalogAtom)
  const revealApiKey = useSetAtom(fetchProviderApiKeyAtom)
  // null = still fetching. The form is only rendered once it has arrived, so useState gets the correct
  // initial value — backfilling asynchronously inside the form instead would make both the dirty and
  // "credentials unchanged" checks run one pass against an empty key first.
  // This is external-system sync (network), not the §1.17 derived-state anti-pattern.
  const [initialApiKey, setInitialApiKey] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void revealApiKey(providerId).then((key) => {
      if (alive) setInitialApiKey(key)
    })
    return () => {
      alive = false
    }
  }, [providerId, revealApiKey])

  const currentConfig = configured.find((p) => p.id === providerId)
  if (!currentConfig) {
    return <div className="text-xs text-text-tertiary p-4">{t('modals.model.edit.notFound')}</div>
  }
  if (initialApiKey === null) {
    return <div className="text-xs text-text-tertiary p-4">{t('modals.model.edit.loading')}</div>
  }
  const catalogEntry = catalog.find((entry) => entry.id === currentConfig.id)
  const initial: ProviderPreset = {
    providerId: currentConfig.id,
    displayName: catalogEntry
      ? getConfiguredProviderDisplayName(catalogEntry, currentConfig.display_name, t)
      : currentConfig.display_name ?? currentConfig.id,
    // A codex channel reports protocol 'openai-codex', but at the form level
    // it's just the openai vendor with the subscription mode selected — normalize back to
    // 'openai'; the auth method is carried by authMode below.
    protocol: currentConfig.protocol === 'openai-codex' ? 'openai' : currentConfig.protocol,
    baseUrl: currentConfig.base_url ?? '',
    models: currentConfig.available_models,
    modelLimits: currentConfig.model_limits,
    authMode: currentConfig.auth_mode,
  }
  return (
    <ChannelCredentialForm
      key={`edit:${currentConfig.id}`}
      initial={initial}
      initialApiKey={initialApiKey}
      mode="edit"
      apiKeySetInitially={currentConfig.api_key_set}
      onBack={onBack}
      onDone={onDone}
      backLabel={t('modals.model.edit.back')}
      titlePrefix={t('modals.model.edit.titlePrefix')}
    />
  )
}

/**
 * Codex subscription-mode body: the codex channel shows an OAuth authorisation button (via ChatGPT
 * login), while other oauth vendors (anthropic) have no OAuth yet and still show a placeholder hint.
 *
 * Once authorisation succeeds the daemon has already activated the codex channel and `onDone` returns
 * to the list; failure/timeout/failure to reuse the local login is surfaced nearby by the form's
 * inline error bar (`authError` state) so the user can retry in place — it does not go through the
 * list page's global banner (the user is on the edit page while authorising, so the error must stay there).
 */
/** Local-login detection state for the subscription-mode body. */
type CodexLocalState =
  | { kind: 'checking' }
  | { kind: 'has-local'; accountId: string | null }
  | { kind: 'no-local' }

function CodexOAuthBody({
  providerId,
  onDone,
  authorized,
  initialModels,
  initialModelLimits,
}: {
  providerId: string
  onDone: () => void
  /** True when editing an already-authorized OAuth channel — show the
   *  "authorized" state + a re-authorize action instead of the first-time CTA. */
  authorized: boolean
  /** The channel's current model list — user-editable in the authorized state. */
  initialModels: string[]
  initialModelLimits: Record<string, ModelLimits>
}) {
  const { t } = useTranslation()
  const startCodexOAuth = useSetAtom(startCodexOAuthAtom)
  const checkCodexLocal = useSetAtom(checkCodexLocalAtom)
  // Not named with a `use` prefix on purpose — it's a Jotai setter, not a Hook,
  // and `useX()` inside a handler trips react-hooks/rules-of-hooks.
  const reuseLocalCodex = useSetAtom(useLocalCodexAtom)
  // 'oauth' = a ChatGPT authorisation is in progress (waiting for the browser + polling, cancellable);
  // 'local' = reusing the local login is in progress (a single fast request); null = idle.
  // Distinguishing the source lets the has-local branch know whether to show "enabling…" or "cancel authorisation".
  const [busy, setBusy] = useState<'oauth' | 'local' | null>(null)
  const [local, setLocal] = useState<CodexLocalState>({ kind: 'checking' })
  /** Inline auth error (OAuth / failure to reuse the local login). Lives here, NOT the global
   *  list banner — the user is on the edit page when this fails. */
  const [authError, setAuthError] = useState<string | null>(null)
  // Cancel an in-progress authorisation: shared by two entry points — clicking the "cancel
  // authorisation" button, or "back to vendor selection" unmounting this component — both abort this
  // controller (polling stops + the atom action notifies the backend to shut the server down).
  const abortRef = useRef<AbortController | null>(null)
  // Unmounting cancels it (covering "back", switching to API Key mode, closing the Modal, and everything else that makes this component disappear).
  useEffect(() => () => abortRef.current?.abort(), [])

  // Detect the local codex login when entering subscription mode (a side effect that syncs with the
  // backend, permitted by §1.17). Skipped while editing an already-authorised channel / for non-openai
  // vendors — those take their own branches and need no detection.
  useEffect(() => {
    if (authorized || providerId !== 'openai') return
    let cancelled = false
    void checkCodexLocal().then((r) => {
      if (!cancelled) {
        setLocal(r.has_local ? { kind: 'has-local', accountId: r.account_id } : { kind: 'no-local' })
      }
    })
    return () => {
      cancelled = true
    }
  }, [authorized, providerId, checkCodexLocal])

  const handleAuthorize = async () => {
    if (busy) return // ignore repeat clicks while authorising (waiting for the browser + polling)
    const controller = new AbortController()
    abortRef.current = controller
    setBusy('oauth')
    setAuthError(null)
    try {
      const { status, error } = await startCodexOAuth(controller.signal)
      if (status === 'success') onDone()
      else if (status === 'failed' || status === 'timeout') {
        setAuthError(error ?? t('modals.model.oauth.authorizeFailed'))
      }
      // status === 'cancelled': the user cancelled deliberately, stay silent, the finally restores the UI.
    } finally {
      setBusy(null)
      abortRef.current = null
    }
  }

  // Cancel an in-progress authorisation: abort → polling stops + the atom action tells the backend to close the 1455 server.
  const handleCancelAuth = () => abortRef.current?.abort()

  const handleUseLocal = async () => {
    if (busy) return
    setBusy('local')
    setAuthError(null)
    try {
      const res = await reuseLocalCodex()
      if (res.ok) onDone()
      else setAuthError(res.error ?? t('modals.model.oauth.reuseLocalFailed'))
    } finally {
      setBusy(null)
    }
  }

  // Inline error bar — shared by every authorisation branch and shown right below the button
  // (authorisation errors belong to the edit page and do not go through the list page's global banner).
  const errorRow = authError ? (
    <div className="px-3 py-2 rounded-md bg-status-error-bg text-status-error text-xs leading-[1.5]">
      {authError}
    </div>
  ) : null

  // OAuth (subscription) is currently only implemented for the openai vendor (a ChatGPT Codex
  // subscription); other oauth vendors (anthropic, say) are still placeholders.
  if (providerId !== 'openai') {
    return (
      <div className="px-3 py-2.5 rounded-md bg-bg-hover text-xs text-text-tertiary text-center leading-[1.5]">
        {t('modals.model.oauth.unavailable')}
      </div>
    )
  }

  // Editing an already-authorised channel: echo the authorised state + user-supplied models + re-authorise (switch account / renew).
  if (authorized) {
    return (
      <div className="flex flex-col gap-3">
        <div className="text-xs text-status-success leading-[1.5]">✓ {t('modals.model.oauth.authorized')}</div>
        <CodexModelsEditor
          initialModels={initialModels}
          initialModelLimits={initialModelLimits}
        />
        <Btn size="md" variant="ghost" onClick={busy === 'oauth' ? handleCancelAuth : handleAuthorize}>
          {busy === 'oauth' ? `✕ ${t('modals.model.oauth.cancel')}` : t('modals.model.oauth.reauthorize')}
        </Btn>
        {errorRow}
      </div>
    )
  }

  if (local.kind === 'checking') {
    return (
      <div className="px-3 py-2.5 text-xs text-text-tertiary leading-[1.5]">
        {t('modals.model.oauth.checkingLocal')}
      </div>
    )
  }

  // Local first: a local Codex login was detected → reuse it in one click, without opening a browser or re-authorising.
  if (local.kind === 'has-local') {
    // "Use a different account" was clicked and went to OAuth (busy==='oauth'): the whole branch collapses
    // to waiting + cancel authorisation, and no longer shows "enable directly / switch account" — otherwise
    // "enable directly" would wrongly render as "enabling…" with no way to cancel.
    if (busy === 'oauth') {
      return (
        <div className="flex flex-col gap-2">
          <div className="text-xs text-text-tertiary leading-[1.5]">{t('modals.model.oauth.waitingBrowser')}</div>
          <Btn variant="primary" size="md" onClick={handleCancelAuth}>
            ✕ {t('modals.model.oauth.cancel')}
          </Btn>
          {errorRow}
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-2">
        <div className="text-xs text-status-success leading-[1.5]">
          ✓ {t('modals.model.oauth.localDetected')}
          {local.accountId ? t('modals.model.oauth.account', { accountId: local.accountId.slice(0, 8) }) : ''}
        </div>
        <Btn variant="primary" size="md" onClick={handleUseLocal}>
          {busy === 'local' ? t('modals.model.oauth.enabling') : t('modals.model.oauth.enableLocal')}
        </Btn>
        <button
          type="button"
          onClick={handleAuthorize}
          className="text-xs text-text-tertiary hover:text-text-secondary cursor-pointer self-start"
        >
          {t('modals.model.oauth.useDifferentAccount')}
        </button>
        {errorRow}
      </div>
    )
  }

  // No local login → fall back to OAuth authorisation.
  return (
    <div className="flex flex-col gap-2">
      <Btn variant="primary" size="md" onClick={busy === 'oauth' ? handleCancelAuth : handleAuthorize}>
        {busy === 'oauth' ? `✕ ${t('modals.model.oauth.cancel')}` : t('modals.model.oauth.authorize')}
      </Btn>
      <div className="text-xs text-text-tertiary leading-[1.5]">
        {t('modals.model.oauth.noLocalHint')}
      </div>
      {errorRow}
    </div>
  )
}

/**
 * Model editing area for an authorised Codex channel: input reuses `ModelsListEditor`, and saving goes
 * through upsert via `setCodexModelsAtom` (keeping the openai-codex / oauth shape, touching neither the
 * ~/.codex token nor the activation state, only enabled_models). It is its own subcomponent to isolate
 * its state and keep `CodexOAuthBody` under the useState soft cap (§1.31).
 */
function CodexModelsEditor({
  initialModels,
  initialModelLimits,
}: {
  initialModels: string[]
  initialModelLimits: Record<string, ModelLimits>
}) {
  const { t } = useTranslation()
  const setCodexModels = useSetAtom(setCodexModelsAtom)
  const [models, setModels] = useState<string[]>(initialModels)
  const [modelLimits, setModelLimits] = useState<Record<string, ModelLimits>>(initialModelLimits)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (saving || models.length === 0) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await setCodexModels({ models, modelLimits })
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const disabled = saving || models.length === 0
  return (
    <div className="flex flex-col gap-2">
      <ModelsListEditor
        models={models}
        modelLimits={modelLimits}
        onChange={(next) => {
          setModels(next)
          setSaved(false)
        }}
        onModelLimitsChange={setModelLimits}
        // Subscription channel: providerId is fixed to 'openai' (Codex hangs off that slug) and apiKey is left
        // empty — seeing protocol='openai-codex', the backend returns the static catalog directly without reading credentials or making a request.
        fetchSource={{ providerId: 'openai', protocol: 'openai-codex', apiKey: '' }}
      />
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          onClick={handleSave}
          className={cn('self-start', disabled && 'opacity-50 pointer-events-none')}
        >
          {saving ? t('modals.model.form.saving') : t('modals.model.oauth.saveModels')}
        </Btn>
        {saved && <span className="text-xs text-status-success">{t('modals.model.form.saved')}</span>}
      </div>
      {error && (
        <div className="px-3 py-2 rounded-md bg-status-error-bg text-status-error text-xs leading-[1.5]">
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * Shared form — add / edit look identical. `mode` controls the button text; the other branches use
 * `apiKeySetInitially` to decide the sub text. Form state is entirely internal.
 */
function ChannelCredentialForm({
  initial,
  initialApiKey = '',
  mode,
  apiKeySetInitially,
  onBack,
  onDone,
  backLabel,
  titlePrefix,
}: {
  initial: ProviderPreset
  /** The stored key backfilled in edit mode (empty in add mode). Both dirty and "credentials unchanged"
   *  use it as their baseline; the empty string can no longer serve as the test for "the user has not touched the key". */
  initialApiKey?: string
  mode: 'add' | 'edit'
  apiKeySetInitially: boolean
  onBack: () => void
  onDone: () => void
  backLabel: string
  titlePrefix: string
}) {
  const { t } = useTranslation()
  // Form state starts from the selected provider preset or stored channel.
  // caller (catalog preset for built-in vendors, blank for custom-protocol).
  // The parent passes `key={preset.providerId}` so switching preset remounts
  // and useState initial-value resolves cleanly — no useEffect for derived
  // state (§1.17).
  const catalog = useAtomValue(providerCatalogAtom)
  // The catalog entry decides the variant: found → a built-in vendor (then auth_modes decides whether to
  // show the authentication-method radio); not found → custom (category C, where the user has to pick a protocol + name it).
  const catalogEntry = catalog.find((c) => c.id === initial.providerId)
  const isCustom = !catalogEntry
  const hasOAuth = !!catalogEntry?.auth_modes.includes('oauth')

  const [displayName, setDisplayName] = useState(initial.displayName)
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>(initial.protocol)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [models, setModels] = useState<string[]>(initial.models)
  const [modelLimits, setModelLimits] = useState<Record<string, ModelLimits>>(initial.modelLimits)
  const [apiKey, setApiKey] = useState(initialApiKey)
  const [showKey, setShowKey] = useState(false)
  // The authentication method only appears for hasOAuth vendors. When editing, the configured auth_mode
  // is echoed back (issue 2); when adding, the catalog's default_auth_mode is used (api_key for non-oauth vendors).
  const [authMode, setAuthMode] = useState<'oauth' | 'api_key'>(
    initial.authMode ?? (hasOAuth ? (catalogEntry?.default_auth_mode ?? 'oauth') : 'api_key'),
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testState, setTestState] = useState<TestConnState>({ kind: 'pristine' })
  const addProvider = useSetAtom(addProviderAtom)
  const testProvider = useSetAtom(testProviderAtom)
  const setFormDirty = useSetAtom(setSettingsFormDirtyAtom)
  const requestConfirm = useSetAtom(requestConfirmAtom)
  // Leftover content in the model input box that was never "added": it counts toward dirty (raising the
  // unsaved prompt) but is **not** merged into models automatically (the user explicitly asked for no auto-save).
  const [modelDraft, setModelDraft] = useState('')
  // Whether the form has unsaved changes relative to the initial preset (including uncommitted model-name input).
  const isDirty = useMemo(
    () =>
      displayName !== initial.displayName ||
      protocol !== initial.protocol ||
      baseUrl !== initial.baseUrl ||
      // The baseline is the backfilled stored key, not the empty string — otherwise the edit page would be
      // permanently dirty from the moment it opens, and closing the window / switching tabs would wrongly raise "unsaved changes".
      apiKey.trim() !== initialApiKey.trim() ||
      modelDraft.trim().length > 0 ||
      models.length !== initial.models.length ||
      models.some((m, i) => m !== initial.models[i]) ||
      JSON.stringify(modelLimits) !== JSON.stringify(initial.modelLimits),
    [displayName, protocol, baseUrl, apiKey, initialApiKey, modelDraft, models, modelLimits, initial],
  )
  // external-system sync: publish the form's dirty state to SettingsModal so it can intercept closing /
  // tab switches (§1.12, cross-component goes through an atom). This is not the §1.17
  // derived-state→useState anti-pattern — the goal is a global side effect, not a local derived value;
  // the dirty flag is cleared on unmount (navigating away / saving / cancelling).
  useEffect(() => {
    setFormDirty(isDirty)
    return () => setFormDirty(false)
  }, [isDirty, setFormDirty])
  // Before leaving the form via "cancel" / "← back": raise the custom confirmation when there are
  // unsaved changes (issue 4b: these two entry points used to call onBack directly with no
  // interception, so clicking them appeared to do nothing).
  const handleBack = useCallback(async () => {
    if (
      !isDirty ||
      (await requestConfirm({
        title: t('modals.settings.unsaved.title'),
        message: t('modals.settings.unsaved.message'),
        confirmLabel: t('modals.settings.unsaved.leave'),
        danger: true,
      }))
    ) {
      onBack()
    }
  }, [isDirty, requestConfirm, onBack, t])

  const tile = getProviderDisplayById(initial.providerId || protocol)
  // Derivation rules for the backend provider_id (slug):
  //   - built-in vendor → the catalog id ("deepseek"), always the initial preset id, not user-editable
  //   - custom channel → the channel name turned into a slug (trim + internal spaces → '-'), so renaming = changing the slug
  // The backend's PK is (user_id, provider_id), so the same built-in vendor cannot be configured twice.
  // For a custom channel the user's name is the slug, and on a name collision (with something they
  // configured earlier) the backend upsert overwrites it.
  const slugForSave = isCustom
    ? displayName.trim().replace(/\s+/g, '-').toLowerCase()
    : initial.providerId
  // Most channels use models[0] for a 1-token liveness probe; the Kimi backend only validates /models.
  // An empty list → cannot be tested. This is a trade-off:
  // a wrong model id from the user is not caught by the test (both OpenAI and Anthropic only 404 at
  // request time), but connectivity of the (api_key, protocol, base_url) triple is 100% covered; a wrong
  // available-models field only fails at chat time, which is acceptable.
  const probeModel = models[0] ?? ''
  // Base URL normalisation: strip the SDK's own suffixes from the user's input (/v1/messages,
  // /chat/completions, etc.) and always store the host root, letting the SDK build the path itself.
  // Otherwise a user entering the full endpoint URL ends up with /v1/messages/v1/messages → 404.
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl, protocol)
  // Fingerprint mechanism: on a successful test, the fingerprint of the current key fields is stored;
  // any field change makes testState.fingerprint differ from the current fingerprint and canSave drops
  // automatically.
  // This avoids watching field changes with a useEffect to reset state (§1.17 anti-pattern).
  // The fingerprint uses normalizedBaseUrl — a user toggling "should the trailing /v1/messages be there"
  // should not invalidate a passing test (the normalised value is the same either way).
  const fingerprint = JSON.stringify({
    providerId: slugForSave,
    protocol,
    baseUrl: normalizedBaseUrl,
    apiKey: apiKey.trim(),
    model: probeModel,
  })
  const passed = testState.kind === 'passed' && testState.fingerprint === fingerprint
  // In Edit mode none of the credential fields changed → the user only edited display_name / the models
  // list → do not require a test. The check: apiKey left empty + protocol/baseUrl both identical to the initial values.
  const credentialFieldsUntouched =
    mode === 'edit'
    && apiKey.trim() === initialApiKey.trim()
    && protocol === initial.protocol
    && baseUrl.trim() === initial.baseUrl.trim()
  // Add mode: the test must pass before saving is allowed (a hard user constraint: "only savable once
  // everything is filled in and the test passes").
  // Edit mode: with credential fields untouched it can be saved directly; once credentials change, the test must pass again.
  const canSave =
    authMode === 'api_key'
    && slugForSave.length > 0
    && !submitting
    && (credentialFieldsUntouched || passed)

  const canTest =
    authMode === 'api_key'
    && slugForSave.length > 0
    && apiKey.trim().length > 0
    && probeModel.length > 0
    && testState.kind !== 'testing'
  let testDisabledReason: string | null = null
  if (!canTest) {
    if (authMode === 'oauth') {
      testDisabledReason = t('modals.model.form.testDisabled.subscription')
    } else if (slugForSave.length === 0) {
      testDisabledReason = t('modals.model.form.testDisabled.name')
    } else if (apiKey.trim().length === 0) {
      testDisabledReason = t('modals.model.form.testDisabled.apiKey')
    } else if (probeModel.length === 0) {
      testDisabledReason = t('modals.model.form.testDisabled.models')
    } else if (testState.kind === 'testing') {
      testDisabledReason = t('modals.model.form.testing')
    }
  }

  const handleTest = async () => {
    if (!canTest) return
    const probeFp = fingerprint  // lock the fingerprint so that fields changed mid-test cannot pollute the result
    setTestState({ kind: 'testing' })
    const result = await testProvider({
      providerId: slugForSave,
      protocol,
      apiKey: apiKey.trim(),
      baseUrl: normalizedBaseUrl || undefined,
      model: probeModel,
    })
    if (result.ok) {
      setTestState({
        kind: 'passed',
        latencyMs: result.latency_ms ?? 0,
        fingerprint: probeFp,
      })
    } else {
      setTestState({
        kind: 'failed',
        error: result.error ?? t('modals.model.form.unknownError'),
        fingerprint: probeFp,
      })
    }
  }

  const handleSave = async () => {
    if (!canSave) return
    setSubmitting(true)
    setError(null)
    try {
      await addProvider({
        providerId: slugForSave,
        apiKey: apiKey.trim() || undefined,
        baseUrl: normalizedBaseUrl || undefined,
        protocol,
        displayName: catalogEntry
          && getConfiguredProviderDisplayName(catalogEntry, displayName.trim() || null, t)
            === getProviderCatalogDisplayName(catalogEntry, t)
          ? null
          : displayName.trim() || null,
        models,
        modelLimits: Object.fromEntries(
          models
            .filter((modelId) => modelLimits[modelId] !== undefined)
            .map((modelId) => [modelId, modelLimits[modelId]!]),
        ),
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const titleText = mode === 'edit'
    ? `${titlePrefix}${initial.displayName || initial.providerId}`
    : (displayName || initial.displayName || t('modals.model.form.newProvider'))
  // Subtitle: built-in vendors show only the model count (the vendor's protocol is fixed, so mentioning
  // it is redundant); custom channels show "protocol · N models", because which protocol the user picked is informative.
  let subLine: string
  if (mode === 'edit') {
    subLine = t('modals.model.form.editSubline', { apiKey: apiKeySetInitially ? t('modals.model.form.apiKeySet') : t('modals.model.form.apiKeyMissing'), n: models.length })
  } else if (isCustom) {
    subLine = t('modals.model.form.customSubline', { protocol: protocol === 'anthropic' ? t('modals.model.protocol.anthropicCompat') : t('modals.model.protocol.openaiCompat'), n: models.length })
  } else {
    subLine = t('modals.model.modelCount', { n: models.length })
  }

  // Tooltip for the disabled save button: no hint when it can be saved, otherwise it explains which item is missing.
  let saveDisabledReason: string | undefined
  if (canSave) {
    saveDisabledReason = undefined
  } else if (authMode === 'oauth') {
    saveDisabledReason = t('modals.model.form.saveDisabled.subscription')
  } else if (slugForSave.length === 0) {
    saveDisabledReason = t('modals.model.form.testDisabled.name')
  } else {
    saveDisabledReason = t('modals.model.form.saveDisabled.test')
  }

  return (
    <div>
      <div
        onClick={handleBack}
        className="flex items-center gap-1.5 mb-5 cursor-pointer text-text-secondary hover:text-text-primary text-xs"
      >
        ← {backLabel}
      </div>

      {/* Identity header — the design's 42×42 brand-coloured tile + name + sub */}
      <div className="flex items-center gap-3 mb-5">
        <div
          className="w-[42px] h-[42px] rounded-lg flex items-center justify-center text-lg font-bold text-white flex-shrink-0"
          style={{ background: tile.brandColor }}
        >
          {tile.iconLetter}
        </div>
        <div>
          <div className="text-md font-bold text-text-primary">{titleText}</div>
          <div className="text-xs text-text-secondary">{subLine}</div>
        </div>
      </div>

      {/* Channel name — only appears for custom channels; a built-in vendor's name is fixed.
          slug = derived from the channel name (lowercase + spaces→'-'), not edited directly by the user. */}
      {isCustom && (
        <div className="mb-5">
          <label className="text-xs font-semibold text-text-secondary block mb-1.5">{t('modals.model.form.providerName')}</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('modals.model.form.providerNamePlaceholder')}
            className={inputClasses}
            data-testid="display-name-input"
          />
        </div>
      )}

      {/* Protocol selection — only appears for custom channels; a built-in vendor's protocol is fixed. */}
      {isCustom && (
        <>
          <div className="text-sm font-bold text-text-primary mb-2.5">{t('modals.model.form.protocol')}</div>
          <div className="grid grid-cols-2 gap-2.5 mb-5">
            <ProtocolRadio
              selected={protocol === 'openai'}
              onSelect={() => setProtocol('openai')}
              title={t('modals.model.protocol.openaiCompat')}
            />
            <ProtocolRadio
              selected={protocol === 'anthropic'}
              onSelect={() => setProtocol('anthropic')}
              title={t('modals.model.protocol.anthropicCompat')}
            />
          </div>
        </>
      )}

      {/* Authentication method — only appears for hasOAuth vendors (anthropic/openai/google);
          other vendors + custom channels go straight to the API Key input. */}
      {hasOAuth ? (
        <>
          <div className="text-sm font-bold text-text-primary mb-3">{t('modals.model.form.authentication')}</div>
          <div className="flex flex-col gap-2 mb-5">
            <AuthRadioCard
              selected={authMode === 'oauth'}
              onSelect={() => setAuthMode('oauth')}
              title={t('modals.model.authMode.oauth')}
              recommended
              description={t('modals.model.form.oauthDescription')}
            >
              <CodexOAuthBody
                providerId={initial.providerId}
                onDone={onDone}
                authorized={mode === 'edit' && initial.authMode === 'oauth'}
                initialModels={initial.models}
                initialModelLimits={initial.modelLimits}
              />
            </AuthRadioCard>
            <AuthRadioCard
              selected={authMode === 'api_key'}
              onSelect={() => setAuthMode('api_key')}
              title={t('modals.model.form.apiKeyMode')}
              description={t('modals.model.form.apiKeyDescription')}
            >
              <ApiKeyField
                value={apiKey}
                onChange={setApiKey}
                showKey={showKey}
                onToggleShow={() => setShowKey((v) => !v)}
                label="API Key"
                placeholder={t('modals.model.form.apiKeyPlaceholder')}
              />
            </AuthRadioCard>
          </div>
        </>
      ) : (
        <div className="mb-5">
          <ApiKeyField
            value={apiKey}
            onChange={setApiKey}
            showKey={showKey}
            onToggleShow={() => setShowKey((v) => !v)}
            label="API Key"
            placeholder={t('modals.model.form.apiKeyPlaceholder')}
          />
        </div>
      )}

      {/* Base URL — moved below the authentication method, and only shown outside subscription mode (i.e. for
          API Key). Subscription mode goes to the Codex endpoint, where the user neither needs nor should
          change the base url; for non-OAuth vendors authMode is always api_key, so it shows as usual. */}
      {authMode === 'api_key' && (
        <div className="mb-5">
          <label className="text-xs font-semibold text-text-secondary block mb-1.5">Base URL</label>
          {/* Preview row: the normalised host + the SDK's own suffix, rendered only when non-empty. */}
          {normalizedBaseUrl && (
            <div className="text-xs text-text-tertiary mb-1.5 break-all">
              {t('modals.model.form.preview')}
              <span className="font-mono text-text-secondary">
                {normalizedBaseUrl}
                {protocol === 'anthropic' ? '/v1/messages' : '/chat/completions'}
              </span>
            </div>
          )}
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://..."
            className={inputClasses}
            data-testid="base-url-input"
          />
        </div>
      )}

      {/* Available model list — the user's allow-list, and the picker's only display source */}
      <ModelsListEditor
        models={models}
        modelLimits={modelLimits}
        onChange={setModels}
        onModelLimitsChange={setModelLimits}
        onDraftChange={setModelDraft}
        fetchSource={{
          providerId: slugForSave,
          protocol,
          apiKey: apiKey.trim(),
          baseUrl: normalizedBaseUrl,
        }}
      />

      {error && (
        <div className="mt-3 mb-3 px-3 py-2 rounded-md bg-status-error-bg text-xs text-status-error">
          {t('modals.model.form.saveFailed', { error })}
        </div>
      )}

      {/* Test-result feedback row — right above the footer, with a fixed height to avoid layout jumps.
          Positionally it hugs the "test connection" button so the user's eye lands on the result right after clicking. */}
      <div
        className="mt-4 text-xs leading-[1.5] min-h-[16px] text-right"
        data-testid="test-result"
      >
        {testState.kind === 'pristine' && (
          <span className="text-text-tertiary">{t('modals.model.form.pristine')}</span>
        )}
        {testState.kind === 'testing' && (
          <span className="text-text-tertiary">{t('modals.model.form.connecting')}</span>
        )}
        {testState.kind === 'passed' && (
          <span className="text-status-success">✓ {t('modals.model.form.testPassed', { latencyMs: testState.latencyMs })}</span>
        )}
        {testState.kind === 'failed' && (
          <span className="text-status-error">{testState.error}</span>
        )}
      </div>

      <div className="flex justify-end gap-2 mt-2">
        <Btn onClick={handleBack}>{t('modals.common.cancel')}</Btn>
        {/* Test-connection button — design intent: the user fills in **all** fields first, then clicks this;
            while disabled the tooltip explains what is missing. After one success the fingerprint mechanism
            locks it, and any credential field change disables the save button again, which naturally drives a
            retest.
            The Tooltip wraps an outer span: a disabled Btn is pointer-events-none and receives no hover, while
            the outer span is unaffected. */}
        <Tooltip content={testDisabledReason ?? t('modals.model.form.testHint')}>
          <span className="inline-flex">
            <Btn
              size="md"
              onClick={canTest ? () => { void handleTest() } : undefined}
              className={cn(!canTest && 'opacity-50 pointer-events-none')}
              data-testid="test-connection-btn"
            >
              {Icons.send(14)}{' '}
              {testState.kind === 'testing' ? t('modals.model.form.testing') : t('modals.model.form.testConnection')}
            </Btn>
          </span>
        </Tooltip>
        {/* A Btn is a div internally and has no native disabled; pointer-events-none + greying out simulate the
            disabled state. The wording is uniform so no internal state-machine detail leaks. */}
        <Tooltip content={saveDisabledReason}>
          <span className="inline-flex">
            <Btn
              variant="primary"
              size="md"
              onClick={canSave ? () => { void handleSave() } : undefined}
              className={cn(!canSave && 'opacity-50 pointer-events-none')}
            >
              {Icons.check(14)} {submitting ? t('modals.model.form.saving') : t('modals.model.form.save')}
            </Btn>
          </span>
        </Tooltip>
      </div>
    </div>
  )
}

/** Protocol selection card — 1px transparent border canonical pattern (§LS1). */
function ProtocolRadio({
  selected,
  onSelect,
  title,
}: {
  selected: boolean
  onSelect: () => void
  title: string
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        'px-3.5 py-3 rounded-md cursor-pointer bg-bg-surface',
        'border border-transparent',
        selected ? 'border-brand-blue bg-accent-blue-subtle' : 'border-border-default',
      )}
    >
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            'w-4 h-4 rounded-full box-border flex-shrink-0',
            selected ? 'border-[5px] border-brand-blue' : 'border-2 border-border-strong',
          )}
        />
        <div
          className={cn(
            'text-sm font-semibold',
            selected ? 'text-text-accent' : 'text-text-primary',
          )}
        >
          {title}
        </div>
      </div>
    </div>
  )
}

/** Credential source for "fetch from provider". When absent, the fetch button is not rendered.
 *
 *  `protocol: 'openai-codex'` is a subscription channel: the backend returns the static catalog
 *  directly (the Codex backend has no list-models endpoint), makes no network request and needs no
 *  `apiKey` — which is why it is exempt from the API Key gate in `canFetch` below. */
export interface ModelFetchSource {
  providerId: string
  protocol: 'openai' | 'anthropic' | 'openai-codex'
  apiKey: string
  baseUrl?: string
}

/** State machine for the fetch result. `loaded` carries the credential fingerprint from the time of the
 *  fetch — once the user changes the key / base_url the old list belongs to a different provider and is
 *  discarded on render by fingerprint mismatch. Using a fingerprint rather than a `useEffect` reset
 *  follows §1.17 (no useEffect-derived state). */
type FetchModelsState =
  | { kind: 'idle' }
  | { kind: 'fetching' }
  | { kind: 'loaded'; models: FetchedModel[]; fingerprint: string }
  | { kind: 'failed'; error: string }

/** Optional-models area — models that were fetched but not yet enabled; clicking one adds it to the allow-list.
 *
 *  The complete fetch result remains component-local. Once a model is selected, its limits are copied into
 *  the small `model_limits` map that is saved beside the `enabled_models` allow-list. */
export interface FetchedModelsPickerProps {
  /** The complete fetched list (the authoritative source). */
  fetched: FetchedModel[]
  /** The already-enabled model ids, used to exclude them from the optional area. */
  enabled: string[]
  onAdd: (model: FetchedModel) => void
}

/** Optional model list + keyword filtering (OpenAI can return 100+ entries at once, which is unusable without a filter). */
function FetchedModelsPicker({ fetched, enabled, onAdd }: FetchedModelsPickerProps) {
  const { t } = useTranslation()
  const [keyword, setKeyword] = useState('')
  const enabledSet = useMemo(() => new Set(enabled), [enabled])
  const candidates = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return fetched
      .filter((m) => !enabledSet.has(m.id))
      .filter((m) => !kw || m.id.toLowerCase().includes(kw) || m.name.toLowerCase().includes(kw))
  }, [fetched, enabledSet, keyword])
  if (fetched.length === 0) return null
  return (
    <div className="mb-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-semibold text-text-secondary">{t('modals.model.fetch.optional')}</span>
        <span className="text-xs text-text-tertiary">
          {t('modals.model.fetch.candidates', { n: candidates.length })}
        </span>
      </div>
      {fetched.length > 5 && (
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t('modals.model.fetch.filterPlaceholder')}
          className={cn(inputClasses, 'w-full mb-1.5')}
          data-testid="fetched-model-filter"
        />
      )}
      <div className="flex flex-col gap-1 max-h-[220px] overflow-auto">
        {candidates.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onAdd(m)}
            className="flex items-center justify-between px-3 py-1.5 rounded-md border border-transparent bg-bg-hover hover:border-brand-blue text-left"
            data-testid={`fetched-model-${m.id}`}
          >
            <span className="text-xs text-text-primary font-mono truncate">{m.id}</span>
            <span className="ml-2 flex flex-shrink-0 items-center gap-2 text-xs text-text-tertiary">
              {m.name !== m.id && <span className="max-w-48 truncate">{m.name}</span>}
              {(m.limits?.context || m.limits?.input) && (
                <span>
                  {t('modals.model.models.context', {
                    n: formatTokenLimit(m.limits.context ?? m.limits.input!),
                  })}
                </span>
              )}
            </span>
          </button>
        ))}
        {candidates.length === 0 && (
          <div className="px-3 py-2 text-xs text-text-tertiary">
            {t('modals.model.fetch.noMatches')}
          </div>
        )}
      </div>
    </div>
  )
}

/** Hover hint for the "fetch from provider" button.
 *
 *  A subscription channel reads the static catalog and has no key gate; an API Key channel, because the
 *  backend only accepts the plaintext key from the form (it does not read stored credentials), must have
 *  it re-entered when editing an existing channel, and the hint has to make that clear. */
function pickFetchHint(t: ReturnType<typeof useTranslation>['t'], canFetch: boolean, isSubscription: boolean): string {
  if (canFetch) return isSubscription ? t('modals.model.fetch.subscriptionHint') : t('modals.model.fetch.providerHint')
  return t('modals.model.fetch.missingApiKeyHint')
}

/** Convert transient fetch metadata into the small shape persisted with a selected model. */
function fetchedModelLimits(model: FetchedModel): ModelLimits | null {
  const { context, input, output } = model.limits ?? {}
  if (context === undefined && input === undefined && output === undefined) return null
  return {
    ...(context === undefined ? {} : { context }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    source: model.limits_source === 'provider' ? 'provider' : 'models_dev',
    ...(model.source_provider_id ? { source_provider_id: model.source_provider_id } : {}),
    ...(model.source_model_id ? { source_model_id: model.source_model_id } : {}),
  }
}

function formatTokenLimit(value: number): string {
  return new Intl.NumberFormat().format(value)
}

/** Inline editor for the model whitelist. Backed by a `string[]` model array
 *  the parent owns; we render rows + an input that appends on Enter or click.
 *  Empty state shows a hint so the user knows the picker will be empty until
 *  they add at least one model id.
 *
 *  When `fetchSource` is given, a "fetch from provider" button pulls the provider's
 *  real model list into a candidate section below. Listing needs no model id,
 *  so this is also what breaks the test-connection chicken-and-egg (the probe requires
 *  `models[0]`): the flow becomes enter key → fetch list → tick → test. */
function ModelsListEditor({
  models,
  modelLimits,
  onChange,
  onModelLimitsChange,
  onDraftChange,
  fetchSource,
}: {
  models: string[]
  modelLimits: Record<string, ModelLimits>
  onChange: (next: string[]) => void
  onModelLimitsChange: (next: Record<string, ModelLimits>) => void
  /** Report uncommitted input-box content so the parent form can count it toward dirty (not merged automatically, only used for the unsaved prompt). */
  onDraftChange?: (draft: string) => void
  /** When absent, "fetch from provider" is not rendered (a Codex OAuth channel has no usable api_key). */
  fetchSource?: ModelFetchSource
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const [fetchState, setFetchState] = useState<FetchModelsState>({ kind: 'idle' })
  const fetchModels = useSetAtom(fetchProviderModelsAtom)
  const trimmed = draft.trim()
  const canAdd = trimmed.length > 0 && !models.includes(trimmed)
  // The fingerprint follows the credentials; a fetched list is only valid while the fingerprint matches
  // (see FetchModelsState).
  // No useMemo — the parent passes a fresh fetchSource literal on every render so the cache would never
  // hit, and stringifying 4 short strings is negligible anyway; the comparison is by value, so
  // correctness is unaffected.
  const fingerprint = fetchSource
    ? JSON.stringify([
        fetchSource.providerId,
        fetchSource.protocol,
        fetchSource.baseUrl ?? '',
        fetchSource.apiKey,
      ])
    : ''
  // A subscription channel reads the static catalog and has no key to enter — as long as the channel is authorised, it can fetch.
  const isSubscription = fetchSource?.protocol === 'openai-codex'
  const isLoaded = fetchState.kind === 'loaded' && fetchState.fingerprint === fingerprint
  // A subscription channel enables everything it fetches, so the optional area is necessarily empty — do not render it, or it would show nothing but "no matches".
  const fetched = isLoaded && !isSubscription ? fetchState.models : []
  const canFetch =
    Boolean(fetchSource)
    && (isSubscription || Boolean(fetchSource?.apiKey.trim()))
    && fetchState.kind !== 'fetching'
  const mergeFetchedLimits = (fetchedModels: FetchedModel[], selectedIds: string[]) => {
    const selected = new Set(selectedIds)
    let changed = false
    const next = { ...modelLimits }
    for (const model of fetchedModels) {
      if (!selected.has(model.id)) continue
      const limits = fetchedModelLimits(model)
      if (!limits) continue
      if (JSON.stringify(next[model.id]) !== JSON.stringify(limits)) changed = true
      next[model.id] = limits
    }
    if (changed) onModelLimitsChange(next)
  }
  const handleFetch = async () => {
    if (!fetchSource || !canFetch) return
    setFetchState({ kind: 'fetching' })
    const result = await fetchModels(fetchSource)
    if (!result.ok || !result.models) {
      setFetchState({ kind: 'failed', error: result.error ?? t('modals.model.fetch.failed') })
      return
    }
    setFetchState({ kind: 'loaded', models: result.models, fingerprint })
    if (isSubscription) {
      // The subscription catalog is a small hand-picked set that is fully enabled on fetch and not stuffed
      // into the "optional" collapsible — otherwise new models would default to disabled, sink to the bottom,
      // and the user would think "nothing was fetched". Manually added ones are kept.
      const fetchedIds = result.models.map((m) => m.id)
      const fetchedSet = new Set(fetchedIds)
      const manualKept = models.filter((m) => !fetchedSet.has(m))
      const selectedModels = [...manualKept, ...fetchedIds]
      onChange(selectedModels)
      mergeFetchedLimits(result.models, selectedModels)
    } else {
      mergeFetchedLimits(result.models, models)
    }
  }
  const addModel = (model: FetchedModel) => {
    if (models.includes(model.id)) return
    onChange([...models, model.id])
    const limits = fetchedModelLimits(model)
    if (limits) onModelLimitsChange({ ...modelLimits, [model.id]: limits })
  }
  const removeModel = (id: string) => {
    onChange(models.filter((model) => model !== id))
    if (modelLimits[id] === undefined) return
    const next = { ...modelLimits }
    delete next[id]
    onModelLimitsChange(next)
  }
  const setManualContextLimit = (id: string, value: string) => {
    const context = Number.parseInt(value, 10)
    if (!Number.isSafeInteger(context) || context <= 0) {
      if (modelLimits[id] === undefined) return
      const next = { ...modelLimits }
      delete next[id]
      onModelLimitsChange(next)
      return
    }
    onModelLimitsChange({ ...modelLimits, [id]: { context, source: 'manual' } })
  }
  // Write the draft and report it to the parent form at the same time (counting toward dirty); nothing is merged into models automatically here.
  const setDraftReport = (v: string) => {
    setDraft(v)
    onDraftChange?.(v)
  }
  const commit = () => {
    if (!canAdd) return
    onChange([...models, trimmed])
    setDraftReport('')
  }
  return (
    <>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm font-bold text-text-primary">{t('modals.model.models.title')}</span>
        <span className="text-xs text-text-tertiary">
          {t('modals.model.models.summary', { n: models.length })}
        </span>
        {fetchSource && (
          <span className="ml-auto flex items-center gap-2">
            {isLoaded && (
              <span className="text-xs text-status-success">
                {t('modals.model.models.loaded', { n: fetchState.models.length })}
              </span>
            )}
            {/* A Btn's disabled state is pointer-events-none and receives no hover — per §1.25 it takes an extra
                wrapping span for the Tooltip to explain why it cannot be clicked. */}
            <Tooltip content={pickFetchHint(t, canFetch, isSubscription)}>
              <span className="inline-flex">
                <Btn
                  size="sm"
                  onClick={canFetch ? () => void handleFetch() : undefined}
                  className={cn(!canFetch && 'opacity-50 pointer-events-none')}
                  data-testid="fetch-models"
                >
                  {fetchState.kind === 'fetching' ? t('modals.model.fetch.fetching') : t('modals.model.fetch.fetch')}
                </Btn>
              </span>
            </Tooltip>
          </span>
        )}
      </div>
      {/* The error gets its own line and does not compete for width with the title / button: the backend's
          diagnostic text (such as the one about base_url missing /v1) runs to 40+ characters, and squeezed
          into the header row it would be cut into an unreadable half-sentence.
          The backend already caps errors at 200 characters, so spread across the full row it is at most 3
          lines and needs no further truncation. */}
      {fetchState.kind === 'failed' && (
        <div className="text-xs text-status-error break-words mb-1.5">
          {fetchState.error}
        </div>
      )}
      {models.length > 0 ? (
        <div className="flex flex-col gap-1.5 mb-2.5">
          {models.map((m) => (
            <div
              key={m}
              className="flex items-center justify-between px-3 py-2 rounded-md bg-bg-hover border border-border-subtle"
              data-testid={`model-row-${m}`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs text-text-primary font-mono truncate">{m}</div>
                {modelLimits[m]?.source !== 'manual' && (modelLimits[m]?.context || modelLimits[m]?.input) ? (
                  <div className="mt-0.5 text-[11px] text-text-tertiary">
                    {t('modals.model.models.context', {
                      n: formatTokenLimit(modelLimits[m]?.context ?? modelLimits[m]!.input!),
                    })}
                    {modelLimits[m]?.output
                      ? ` · ${t('modals.model.models.output', { n: formatTokenLimit(modelLimits[m]!.output!) })}`
                      : ''}
                  </div>
                ) : (
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={modelLimits[m]?.source === 'manual' ? (modelLimits[m]?.context ?? '') : ''}
                    onChange={(event) => setManualContextLimit(m, event.target.value)}
                    placeholder={t('modals.model.models.contextPlaceholder')}
                    className="mt-1 h-7 w-44 rounded border border-border-default bg-bg-primary px-2 text-[11px] text-text-primary"
                    data-testid={`model-context-${m}`}
                  />
                )}
              </div>
              <Tooltip content={t('modals.model.models.remove')}>
                <button
                  type="button"
                  onClick={() => removeModel(m)}
                  className="text-text-tertiary hover:text-status-error flex-shrink-0 ml-2 cursor-pointer"
                  aria-label={t('modals.model.models.removeAria', { model: m })}
                >
                  {Icons.trash(13)}
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-3 rounded-md bg-bg-hover border border-dashed border-border-default text-center text-xs text-text-tertiary leading-[1.6] mb-2.5">
          {t('modals.model.models.empty')}
        </div>
      )}
      <FetchedModelsPicker fetched={fetched} enabled={models} onAdd={addModel} />
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraftReport(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={t('modals.model.models.placeholder')}
          className={cn(inputClasses, 'flex-1 font-mono')}
          data-testid="model-input"
        />
        <Btn
          size="md"
          onClick={canAdd ? commit : undefined}
          className={cn(!canAdd && 'opacity-50 pointer-events-none')}
        >
          {Icons.plus(14)} {t('modals.model.models.add')}
        </Btn>
      </div>
    </>
  )
}

/** Test-connection state machine — exported so ChannelCredentialForm can hold
 *  it and pass into ApiKeyField for rendering. `passed` carries the tested
 *  fingerprint so the form can detect "user edited a credential field after
 *  passing" and demand re-test (canSave drops). */
export type TestConnState =
  | { kind: 'pristine' }
  | { kind: 'testing' }
  | { kind: 'passed'; latencyMs: number; fingerprint: string }
  | { kind: 'failed'; error: string; fingerprint: string }

/** API Key input + show/hide toggle.
 *
 *  The test-connection button + result feedback area live at the bottom of ChannelCredentialForm,
 *  together with the save button; this only collects the API Key input itself. */
function ApiKeyField({
  value,
  onChange,
  showKey,
  onToggleShow,
  label,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  showKey: boolean
  onToggleShow: () => void
  label: string
  placeholder: string
}) {
  const { t } = useTranslation()
  return (
    <div>
      <label className="text-xs font-semibold text-text-secondary block mb-1.5">{label}</label>
      <div className="relative">
        <input
          type={showKey ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn(inputClasses, 'pr-9')}
          data-testid="apikey-input"
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
          aria-label={showKey ? t('modals.model.form.hideApiKey') : t('modals.model.form.showApiKey')}
        >
          {Icons.eye(14)}
        </button>
      </div>
    </div>
  )
}

/** Single radio-style auth card. Expands content area when selected. */
function AuthRadioCard({
  selected,
  onSelect,
  title,
  recommended,
  description,
  children,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  recommended?: boolean
  description: string
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div
      onClick={onSelect}
      className={cn(
        'px-4 py-3.5 rounded-lg cursor-pointer border bg-bg-surface',
        selected ? 'border-brand-blue bg-accent-blue-subtle' : 'border-border-default',
      )}
    >
      {/* The header margin does not change with selected (§LS1) — the expansion spacing sits on the children
          wrapper's mt-3, so an adjacent card's header does not jump 12px when one is picked. */}
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            'w-4 h-4 rounded-full box-border flex-shrink-0',
            selected ? 'border-[5px] border-brand-blue' : 'border-2 border-border-strong',
          )}
        />
        <div className="flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-text-primary">{title}</span>
            {recommended && <Badge color="success">{t('modals.model.tag.recommended')}</Badge>}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">{description}</div>
        </div>
      </div>
      {selected && <div className="ml-6.5 mt-3">{children}</div>}
    </div>
  )
}

/**
 * Gateway tab — the Bridgic Agent daemon management panel.
 *
 * Reads state / endpoint / lastError from backendSnapshotAtom and renders three visual states:
 *   - ready                          → green frame + "running" + a "stop" button
 *   - idle / discovering / spawning  → grey frame + "stopped" + a "start" button
 *   - unhealthy / unavailable        → red frame + "connection error" + an error box + retry
 *
 * The uptime is derived from endpoint.startedAt and recomputed once a second.
 */
function SettingsGatewayTab() {
  const { t } = useTranslation()
  const state = useAtomValue(backendStateAtom)
  const endpoint = useAtomValue(backendEndpointAtom)
  const lastError = useAtomValue(backendErrorAtom)
  const [busy, setBusy] = useState<'start' | 'stop' | 'retry' | null>(null)
  const [copied, setCopied] = useState(false)
  const [tokenCopied, setTokenCopied] = useState(false)
  // Tick so uptime re-renders each second without we touching atoms.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (state !== BackendState.Ready) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [state])

  const isRunning = state === BackendState.Ready
  const isError = state === BackendState.Unhealthy || state === BackendState.Unavailable
  // Default URL shown when the daemon hasn't reported yet — matches the
  // Bridgic Agent daemon's default bind. Replaced with real value once
  // endpoint resolves.
  const displayUrl = endpoint?.baseUrl ?? 'http://127.0.0.1:7421'
  const version = endpoint?.version ?? null
  const uptime = isRunning ? formatUptime(t, endpoint?.startedAt ?? null) : null

  const onStart = async () => {
    setBusy('start')
    try {
      await window.api.backend.start()
    } catch (err) {
      rlog.error('[gateway] start failed', err)
    } finally {
      setBusy(null)
    }
  }
  const onStop = async () => {
    setBusy('stop')
    try {
      await window.api.backend.stop()
    } catch (err) {
      rlog.error('[gateway] stop failed', err)
    } finally {
      setBusy(null)
    }
  }
  const onRetry = async () => {
    setBusy('retry')
    try {
      await window.api.backend.start()
    } catch (err) {
      rlog.error('[gateway] retry failed', err)
    } finally {
      setBusy(null)
    }
  }
  const onCopy = () => {
    void navigator.clipboard.writeText(displayUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  const onCopyToken = () => {
    const token = endpoint?.token
    if (!token) return
    void navigator.clipboard.writeText(token).then(() => {
      setTokenCopied(true)
      setTimeout(() => setTokenCopied(false), 1500)
    })
  }

  let borderClass: string
  if (isRunning) {
    borderClass = 'border-status-success'
  } else if (isError) {
    borderClass = 'border-status-error'
  } else {
    borderClass = 'border-border-default'
  }

  let statusLabel: string
  if (isRunning) {
    statusLabel = t('modals.gateway.status.running')
  } else if (isError) {
    statusLabel = t('modals.gateway.status.error')
  } else {
    statusLabel = t('modals.gateway.status.stopped')
  }

  return (
    <div>
      <div className="text-sm text-text-secondary mb-4">
        {t('modals.gateway.description', { product: APP_PRODUCT_NAME })}
      </div>

      <Card className={cn('p-4', borderClass)}>
        {/* Header row: icon + title + status pill + action button */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-bg-hover flex items-center justify-center">
              {Icons.link(18)}
            </div>
            <div>
              <div className="text-sm font-semibold text-text-primary">{APP_PRODUCT_NAME} Gateway</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span
                  className={cn(
                    'inline-block w-1.5 h-1.5 rounded-full',
                    isRunning && 'bg-status-success',
                    isError && 'bg-status-error',
                    !isRunning && !isError && 'bg-text-tertiary',
                  )}
                />
                <span className="text-xs text-text-secondary">
                  {statusLabel}
                </span>
              </div>
            </div>
          </div>
          {isRunning ? (
            <Btn variant="danger" size="sm" onClick={busy ? undefined : onStop}>
              {Icons.stop(14)}
              {busy === 'stop' ? t('modals.gateway.stopping') : t('modals.gateway.stop')}
            </Btn>
          ) : (
            <Btn variant="primary" size="sm" onClick={busy ? undefined : onStart}>
              {Icons.play(14)}
              {busy === 'start' ? t('modals.gateway.starting') : t('modals.gateway.start')}
            </Btn>
          )}
        </div>

        {/* URL row */}
        <div className="mb-3">
          <label className="text-xs font-medium text-text-secondary block mb-1">{t('modals.gateway.address')}</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={displayUrl}
              className={cn(inputClasses, 'font-mono flex-1')}
            />
            <Tooltip content={copied ? t('modals.gateway.copied') : t('modals.gateway.copy')}>
              <div
                onClick={onCopy}
                className="w-9 h-9 flex-shrink-0 rounded-md border border-border-default flex items-center justify-center cursor-pointer hover:bg-bg-hover text-text-secondary"
              >
                {copied ? Icons.check(14) : Icons.file(14)}
              </div>
            </Tooltip>
          </div>
        </div>

        {/* Token row — bearer token for /api/* auth, read from runtime.json.
            Masked in the UI (first 8 + last 4 chars only); [copy] copies the
            full value. [rotate] is a placeholder for M3 (fresh-token-per-startup
            is the only rotation mechanism in M1). Hidden when no token —
            either a legacy v1 daemon or daemon not running. */}
        {endpoint?.token && (
          <div className="mb-3">
            <label className="text-xs font-medium text-text-secondary block mb-1">Token</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={maskToken(endpoint.token)}
                className={cn(inputClasses, 'font-mono flex-1')}
                data-testid="gateway-token-masked"
              />
              <Tooltip content={tokenCopied ? t('modals.gateway.copied') : t('modals.gateway.copyToken')}>
                <div
                  onClick={onCopyToken}
                  className="w-9 h-9 flex-shrink-0 rounded-md border border-border-default flex items-center justify-center cursor-pointer hover:bg-bg-hover text-text-secondary"
                >
                  {tokenCopied ? Icons.check(14) : Icons.file(14)}
                </div>
              </Tooltip>
              <Tooltip content={t('modals.gateway.rotateTokenUnavailable')}>
                <div
                  className="w-9 h-9 flex-shrink-0 rounded-md border border-border-default flex items-center justify-center text-text-tertiary cursor-not-allowed opacity-50"
                  data-testid="gateway-token-rotate-disabled"
                >
                  {Icons.refresh(14)}
                </div>
              </Tooltip>
            </div>
          </div>
        )}

        {/* Version + Uptime row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md bg-bg-hover px-3 py-2.5">
            <div className="text-xs text-text-secondary">{t('modals.gateway.version')}</div>
            <div className="text-sm font-mono text-text-primary mt-0.5">{version ?? '—'}</div>
          </div>
          <div className="rounded-md bg-bg-hover px-3 py-2.5">
            <div className="text-xs text-text-secondary">{t('modals.gateway.uptime')}</div>
            <div className="text-sm text-text-primary mt-0.5">{uptime ?? '—'}</div>
          </div>
        </div>

        <GatewayAutostartRow />

        {/* Error box (error state only) */}
        {isError && (
          <div className="mt-3 rounded-md border border-status-error/30 bg-status-error-bg p-3">
            <div className="text-xs font-semibold text-status-error mb-1.5">{t('modals.gateway.errorInfo')}</div>
            <div className="text-xs text-text-primary mb-2 font-mono break-all">
              {lastError ?? t('modals.gateway.connectionRefused', { port: getUrlPort(displayUrl) })}
            </div>
            <Btn size="xs" onClick={busy ? undefined : onRetry}>
              {Icons.refresh(12)}
              {busy === 'retry' ? t('modals.gateway.retrying') : t('modals.gateway.retry')}
            </Btn>
          </div>
        )}
      </Card>
    </div>
  )
}


/**
 * Start-at-login controls one product contract with two OS registrations: the
 * daemon handles unattended schedules, while Electron owns the visible tray.
 * Reporting only the daemon was the original "service is running but there is
 * no tray icon" bug, so the main process now returns their combined state plus
 * component diagnostics.
 *
 * The setting changes only the next-login registration. The current gateway,
 * its authenticated endpoint, and active sessions remain untouched.
 */
/** Text for the autostart button (§1.24 value mapping via a helper, no nested ternaries). */
function autostartButtonLabel(
  t: ReturnType<typeof useTranslation>['t'],
  busy: boolean,
  enabled: boolean,
  partial: boolean,
): string {
  if (busy) return t('modals.gateway.autostart.processing')
  if (partial) return t('modals.gateway.autostart.repair')
  return enabled ? t('modals.gateway.autostart.disable') : t('modals.gateway.autostart.enable')
}

function hasPartialAutostart(status: AutostartStatusJson | null): boolean {
  if (typeof status?.daemon_enabled !== 'boolean') return false
  if (typeof status.tray_enabled !== 'boolean') return false
  return status.daemon_enabled !== status.tray_enabled
}

function GatewayAutostartRow() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AutostartStatusJson | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Read once on mount. setState inside `.then` with a cancelled guard, same as CodeBlock — no
  // synchronous setState inside the effect body (react-hooks/set-state-in-effect), and nothing is written after unmount.
  useEffect(() => {
    let cancelled = false
    window.api.backend
      .autostartStatus()
      .then((result) => {
        if (cancelled) return
        setStatus(result.ok ? result.status : null)
        setError(result.ok ? null : result.reason)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        rlog.error('[gateway] autostartStatus failed', err)
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setEnabled = async (enabled: boolean) => {
    if (!status || busy) return
    setBusy(true)
    try {
      const result = await window.api.backend.setAutostart(enabled)
      if (result.ok) {
        setStatus(result.status)
        setError(null)
      } else {
        setError(result.reason)
      }
    } catch (err) {
      rlog.error('[gateway] setAutostart failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // On unsupported platforms (Linux, say) the whole row is not rendered — a switch that can never be clicked only invites questions.
  if (status && !status.supported) return null
  const partial = hasPartialAutostart(status)

  return (
    <div className="mt-3 rounded-md bg-bg-hover px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-text-primary">
            {t('modals.gateway.autostart.title', { product: APP_PRODUCT_NAME })}
          </div>
          <div className="text-xs text-text-secondary mt-0.5 leading-[1.5]">
            <AutostartHint status={status} error={error} />
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {partial && (
            <Btn
              size="xs"
              onClick={busy || !status ? undefined : () => void setEnabled(false)}
            >
              {t('modals.gateway.autostart.disableAll')}
            </Btn>
          )}
          <Btn
            size="xs"
            variant={partial ? 'primary' : 'default'}
            onClick={busy || !status ? undefined : () => void setEnabled(!status.enabled)}
          >
            {autostartButtonLabel(t, busy, status?.enabled === true, partial)}
          </Btn>
        </div>
      </div>
    </div>
  )
}

/**
 * Explanatory text for the autostart row (§1.24: branch text goes into a subcomponent, no ternaries piled into JSX).
 *
 * It only talks about consequences the user can perceive, never the implementation: this used to say
 * "does not inherit your terminal PATH" and name the manager (launchd), which was the mental load of
 * debugging that uv fault and should not be passed on to the user (2026-07-29, explicit user feedback:
 * "too much jargon"). The technical reason stays in the code comments and the PR.
 */
function AutostartHint({
  status,
  error,
}: {
  status: AutostartStatusJson | null
  error: string | null
}) {
  const { t } = useTranslation()
  if (error) return <span className="text-status-error">{t('modals.gateway.autostart.readFailed', { error })}</span>
  if (!status) return <>{t('modals.gateway.autostart.reading')}</>
  if (status.tray_requires_approval) {
    return <>{t('modals.gateway.autostart.approvalRequired', { product: APP_PRODUCT_NAME })}</>
  }
  if (status.daemon_enabled && status.tray_enabled === false) {
    return <>{t('modals.gateway.autostart.trayRepairNeeded')}</>
  }
  if (status.daemon_enabled === false && status.tray_enabled) {
    return <>{t('modals.gateway.autostart.daemonRepairNeeded')}</>
  }
  if (status.enabled) {
    return <>{t('modals.gateway.autostart.enabledHint', { product: APP_PRODUCT_NAME })}</>
  }
  return <>{t('modals.gateway.autostart.disabledHint')}</>
}

/** ISO 8601 → "X days Y hours" / "Y hours Z minutes" / "Z minutes" / "just now". */
function formatUptime(t: ReturnType<typeof useTranslation>['t'], startedAt: string | null): string {
  if (!startedAt) return '—'
  const start = new Date(startedAt).getTime()
  if (Number.isNaN(start)) return '—'
  const ms = Date.now() - start
  if (ms < 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (days > 0) return t('modals.gateway.uptimeDays', { days, hours })
  if (hours > 0) return t('modals.gateway.uptimeHours', { hours, minutes })
  if (minutes > 0) return t('modals.gateway.uptimeMinutes', { minutes })
  return t('modals.gateway.justNow')
}

/** Mask a bearer token for display: keep first 8 + last 4 chars, ellipsis
 *  between. Returns '—' for null. Tokens are 256-bit URL-safe (~43 chars)
 *  so first8+last4 is plenty distinct for human eyeballing without
 *  exposing the secret. */
function maskToken(token: string | null): string {
  if (!token) return '—'
  if (token.length <= 12) return '••••••••'
  return `${token.slice(0, 8)}…${token.slice(-4)}`
}

function getUrlPort(url: string): string {
  try {
    const u = new URL(url)
    return u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    return ''
  }
}


/**
 * Appearance tab — light / dark / follow system, pick one of three.
 *
 * Kept for history: the original settings design had no appearance tab (only 3); it was added early in the
 * project, and the user explicitly asked for it back. `themeAtom` + `useSetThemeMode` persist through the settings IPC.
 */
function SettingsAppearanceTab() {
  const { t } = useTranslation()
  const theme = useAtomValue(themeAtom)
  const setMode = useSetThemeMode()
  const options: { mode: ThemeMode; label: string; desc: string }[] = [
    { mode: ThemeMode.Light,  label: t('settings.appearance.theme.light'),  desc: t('settings.appearance.theme.lightDesc') },
    { mode: ThemeMode.Dark,   label: t('settings.appearance.theme.dark'),   desc: t('settings.appearance.theme.darkDesc') },
    { mode: ThemeMode.System, label: t('settings.appearance.theme.system'), desc: t('settings.appearance.theme.systemDesc') },
  ]
  return (
    <div>
      <div className="text-sm text-text-secondary mb-4 leading-[1.6]">
        {t('settings.appearance.theme.desc')}
      </div>
      <div className="text-sm font-semibold text-text-primary mb-3">{t('settings.appearance.theme.title')}</div>
      <div className="flex flex-col gap-2">
        {options.map((opt) => {
          const active = theme.mode === opt.mode
          return (
            <div
              key={opt.mode}
              data-testid={`theme-mode-${opt.mode}`}
              onClick={() => void setMode(opt.mode)}
              // §LS1: 1px transparent border always-on; active swaps to brand-blue.
              className={cn(
                'flex items-center justify-between px-3.5 py-3 rounded-md bg-bg-hover cursor-pointer border border-transparent',
                active && 'border-brand-blue',
              )}
            >
              <div>
                <div className="text-sm font-medium text-text-primary">{opt.label}</div>
                <div className="text-sm text-text-secondary mt-0.5">{opt.desc}</div>
              </div>
              {active && <Badge color="brand">{t('common.inUse')}</Badge>}
            </div>
          )
        })}
      </div>
      <div className="text-xs text-text-tertiary mt-4">
        {t('settings.appearance.theme.current', {
          name: theme.resolved === 'dark'
            ? t('settings.appearance.theme.dark')
            : t('settings.appearance.theme.light'),
        })}
      </div>
      <SettingsLocaleRow />
      <SettingsZoomRow />
    </div>
  )
}

/**
 * Interface-language selector.
 *
 * Writes `GuiSettings.locale`; `useApplyLocale` (mounted at the App root) is
 * what actually pushes the change into i18next, so switching here re-renders
 * every translated component immediately without a reload.
 */
function SettingsLocaleRow() {
  const { t } = useTranslation()
  const locale = useAtomValue(localeAtom)
  const setLocale = useSetLocale()
  const options: { value: UiLocale; label: string; desc: string }[] = [
    { value: UiLocale.System,  label: t('settings.appearance.language.system'), desc: t('settings.appearance.language.systemDesc') },
    { value: UiLocale.Chinese, label: t('settings.appearance.language.chinese'), desc: t('settings.appearance.language.chineseDesc') },
    { value: UiLocale.English, label: 'English',  desc: 'English' },
  ]
  return (
    <>
      <div className="text-sm font-semibold text-text-primary mt-6 mb-3">
        {t('settings.appearance.language.title')}
      </div>
      <div className="text-sm text-text-secondary mb-3 leading-[1.6]">
        {t('settings.appearance.language.desc')}
      </div>
      <div className="flex flex-col gap-2">
        {options.map((opt) => {
          const active = locale.stated === opt.value
          return (
            <div
              key={opt.value || 'system'}
              data-testid={`ui-locale-${opt.value || 'system'}`}
              onClick={() => void setLocale(opt.value)}
              className={cn(
                'flex items-center justify-between px-3.5 py-3 rounded-md bg-bg-hover cursor-pointer border border-transparent',
                active && 'border-brand-blue',
              )}
            >
              <div>
                <div className="text-sm font-medium text-text-primary">{opt.label}</div>
                <div className="text-xs text-text-secondary mt-0.5">{opt.desc}</div>
              </div>
              {active && <Badge color="brand">{t('common.inUse')}</Badge>}
            </div>
          )
        })}
      </div>
      <div className="text-xs text-text-tertiary mt-4">
        {t('settings.appearance.language.current', {
          name: locale.resolved === 'zh' ? t('settings.appearance.language.chinese') : t('settings.appearance.language.english'),
        })}
      </div>
    </>
  )
}

/**
 * Interface zoom row — the same state as `Cmd/Ctrl` `+` / `-` / `0` (both write `zoomLevel`), applied
 * to webContents uniformly by the main process, so the two entry points are naturally in sync and cannot disagree.
 */
function SettingsZoomRow() {
  const { t } = useTranslation()
  const settings = useAtomValue(settingsAtom)
  const update = useUpdateSettings()
  const level = clampZoomLevel(settings.zoomLevel)
  const setLevel = (next: number) => {
    const clamped = clampZoomLevel(next)
    if (clamped === level) return
    void update((prev) => ({ ...prev, zoomLevel: clamped }))
  }

  return (
    <>
      <div className="text-sm font-semibold text-text-primary mt-6 mb-3">{t('settings.appearance.zoom.title')}</div>
      <div className="flex items-center justify-between px-3.5 py-3 rounded-md bg-bg-hover">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">{t('settings.appearance.zoom.size')}</div>
          <div className="text-xs text-text-secondary mt-0.5">
            {t('settings.appearance.zoom.desc')}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Tooltip content={t('settings.appearance.zoom.decrease')}>
            <button
              type="button"
              aria-label={t('settings.appearance.zoom.decrease')}
              disabled={level <= ZOOM_LEVEL_MIN}
              onClick={() => setLevel(level - ZOOM_LEVEL_STEP)}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border-default text-text-secondary disabled:cursor-not-allowed disabled:opacity-40"
            >
              −
            </button>
          </Tooltip>
          <span className="w-12 text-center text-sm font-medium tabular-nums text-text-primary">
            {zoomPercent(level)}%
          </span>
          <Tooltip content={t('settings.appearance.zoom.increase')}>
            <button
              type="button"
              aria-label={t('settings.appearance.zoom.increase')}
              disabled={level >= ZOOM_LEVEL_MAX}
              onClick={() => setLevel(level + ZOOM_LEVEL_STEP)}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border-default text-text-secondary disabled:cursor-not-allowed disabled:opacity-40"
            >
              ＋
            </button>
          </Tooltip>
          <button
            type="button"
            disabled={level === 0}
            onClick={() => setLevel(0)}
            className="ml-1 rounded-md px-2 py-1 text-xs font-medium text-text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('settings.appearance.zoom.reset')}
          </button>
        </div>
      </div>
    </>
  )
}

/* ─── Marketplace preview ─── */

/**
 * Preview for one market entry: the workflow's own page from showcase.bridgic.ai,
 * embedded so the user never leaves the app.
 *
 * An iframe rather than a summary built from the payload fields — the site already
 * renders the flow diagram, the options table and the caveats, and duplicating
 * that here would mean re-implementing a page that is already maintained
 * elsewhere. The payload fields stay in use on the card itself.
 *
 * Requires `frame-src https://showcase.bridgic.ai` in the renderer CSP: without a
 * frame-src directive the policy falls back to `default-src 'self'` and the frame
 * is blocked. Named explicitly rather than widening to `https:`.
 *
 * `sandbox` keeps scripts (VitePress needs them for navigation and search) but
 * omits `allow-top-navigation`, so a link inside the frame can never replace the
 * application window.
 *
 * "Open in browser" stays as the escape hatch: it is also the only thing that
 * still works when the frame fails to load, e.g. offline.
 */
export function MarketPreviewModal({
  workflow,
  onClose,
}: {
  workflow?: ShowcaseWorkflow
  onClose?: () => void
}) {
  const { t } = useTranslation()
  const theme = useAtomValue(themeAtom)

  if (!workflow) return null

  // Embedded copy for the frame; the plain URL for the browser, where the site's
  // own navigation is useful rather than noise.
  const embeddedUrl = showcasePageUrl(workflow.path, { theme: theme.resolved })
  const pageUrl = showcasePageUrl(workflow.path)

  // No external-link confirmation here, unlike a link inside a message: that
  // dialog exists to show an unvetted destination before leaving the app, and this
  // destination cannot be anything but showcase.bridgic.ai (see showcasePageUrl).
  const openInBrowser = () => {
    void window.api.shell
      .openExternal(pageUrl)
      .catch((err: unknown) => rlog.warn('[market] openExternal failed', err))
  }

  return (
    <Modal
      width={1120}
      title={workflow.name}
      onClose={onClose}
      contentStyle={{ padding: 0, overflow: 'hidden' }}
    >
      {/* Keyed by theme so switching it while the dialog is open reloads the frame
          with the matching parameter -- the parameter is only read on load. The key
          also resets the placeholder, so the stale page is not shown as "ready". */}
      <EmbeddedShowcasePage key={theme.resolved} url={embeddedUrl} title={workflow.name} />
      <div className="px-5 py-3 border-t border-border-subtle flex items-center justify-between flex-shrink-0">
        <span className="text-xs text-text-tertiary truncate">{pageUrl}</span>
        <Btn variant="ghost" size="sm" onClick={openInBrowser}>
          {Icons.link(14)} {t('modals.market.viewOnline')}
        </Btn>
      </div>
    </Modal>
  )
}

/* ─── Delete confirmation (workflow / session) ─── */

export function DeleteConfirmModal({
  type = 'workflow',
  name,
  relatedCount = 2,
  onClose,
}: {
  type?: 'workflow' | 'session'
  name?: string
  relatedCount?: number
  onClose?: () => void
}) {
  const { t } = useTranslation()
  const displayName = name ?? t('modals.market.defaultName')
  const [option, setOption] = useState(1)
  return (
    <Modal
      width={440}
      title={type === 'workflow' ? t('modals.deleteConfirm.workflowTitle') : t('modals.deleteConfirm.sessionTitle')}
      onClose={onClose}
    >
      <div className="p-5">
        <div className="flex items-center gap-2.5 p-3.5 rounded-md bg-status-error-bg mb-4">
          <span className="text-status-error">{Icons.trash(18)}</span>
          <div className="text-sm text-text-primary leading-[1.5]">
            {t('modals.deleteConfirm.message', { name: displayName })}
          </div>
        </div>
        {type === 'workflow' && relatedCount > 0 && (
          <div className="mb-4">
            <div className="text-sm text-text-secondary mb-2">{t('modals.deleteConfirm.relatedHint', { n: relatedCount })}</div>
            <div className="flex flex-col gap-1.5">
              <SelectItem
                label={t('modals.deleteConfirm.workflowOnly')}
                desc={t('modals.deleteConfirm.workflowOnlyDesc')}
                selected={option === 0}
                onClick={() => setOption(0)}
              />
              <SelectItem
                label={t('modals.deleteConfirm.withSessions')}
                desc={t('modals.deleteConfirm.withSessionsDesc', { n: relatedCount })}
                selected={option === 1}
                onClick={() => setOption(1)}
              />
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>{t('modals.common.cancel')}</Btn>
          <Btn variant="danger" size="md" onClick={onClose}>
            {t('modals.common.confirmDelete')}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

/* ─── Edit task field ─── */

export interface EditFieldProps {
  field: EditFieldKind
  title: string
  hasChange?: boolean
  onClose?: () => void
}

export function EditFieldModal({ field, title, hasChange = false, onClose }: EditFieldProps) {
  const { t } = useTranslation()
  const fieldData: Record<EditFieldKind, { original: string; edited: string; stage: string }> = {
    task: {
      original: t('modals.editField.demo.original'),
      edited: t('modals.editField.demo.edited'),
      stage: t('modals.editField.demo.stage'),
    },
  }
  const data = fieldData[field]
  return (
    <Modal width={620} title={t('modals.editField.title', { title })} onClose={onClose}>
      <div className="p-5">
        <div className="text-xs text-text-tertiary mb-2 font-medium">{t('modals.editField.currentContent')}</div>
        <textarea
          defaultValue={hasChange ? data.edited : data.original}
          className={cn(inputClasses, 'leading-[1.6] font-sans text-sm')}
          // textarea-only — needs minHeight and resize which Tailwind covers but spelling them out
          // here keeps the original look-and-feel intact during the refactor.
          style={{ minHeight: 120, resize: 'vertical' }}
        />

        {hasChange ? (
          <div className="mt-4">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="w-2 h-2 rounded-full bg-status-warning" />
              <span className="text-xs font-semibold text-status-warning">{t('modals.editField.changeDetected')}</span>
            </div>
            <div
              className="p-3 rounded-md bg-status-warning-bg"
              style={{ border: '1px solid rgba(251,191,36,0.2)' }}
            >
              <div className="text-xs text-text-secondary leading-[1.6]">
                {t('modals.editField.restartFrom', { stage: data.stage })}
                {field === EditFieldKind.Task && t('modals.editField.rematchDomain')}
              </div>
              <div className="mt-2.5 text-xs font-mono leading-[1.8]">
                <div className="text-status-error line-through">- {data.original.split('\n')[0]}</div>
                <div className="text-status-success">+ {data.edited.split('\n')[0]}</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 px-3 py-2 rounded-md bg-bg-hover flex items-center gap-1.5">
            {Icons.check(14)}
            <span className="text-xs text-text-secondary">{t('modals.editField.noChange')}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <Btn onClick={onClose}>{t('modals.common.cancel')}</Btn>
          <Btn variant={hasChange ? 'primary' : 'default'} size="md" onClick={onClose}>
            {hasChange ? t('modals.editField.confirmRerun') : t('modals.common.close')}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

/* ─── Preview field (explore report / runnable program) ─── */

export function PreviewFieldModal({ field, onClose }: { field: PreviewFieldKind; onClose?: () => void }) {
  const { t } = useTranslation()
  if (field === PreviewFieldKind.Explore) {
    return (
      <Modal width={680} title={t('modals.preview.exploreTitle')} onClose={onClose}>
        <div className="p-5">
          <MarkdownMessage content={t('modals.preview.exploreReport')} />
        </div>
      </Modal>
    )
  }
  return (
    <Modal width={680} title={t('modals.preview.programTitle')} onClose={onClose}>
      <div className="p-5">
        <div className="text-sm font-semibold text-text-primary mb-3">{t('modals.preview.readmeTitle')}</div>
        <div className="p-3.5 rounded-md bg-bg-hover text-sm text-text-secondary leading-[1.7] mb-4">
          <strong className="text-text-primary">{t('modals.market.defaultName')}</strong>
          <br />
          <br />
          {t('modals.preview.usage')}
          <br />
          {t('modals.preview.install')} {' '}
          <code className="bg-bg-app px-1.5 py-0.5 rounded font-mono text-xs">uv pip install -r requirements.txt</code>
          <br />
          {t('modals.preview.run')} {' '}
          <code className="bg-bg-app px-1.5 py-0.5 rounded font-mono text-xs">
            {t('modals.preview.command')}
          </code>
          <br />
          {t('modals.preview.output')}
        </div>
        <div className="text-sm font-semibold text-text-primary mb-2">{t('modals.preview.fileTree')}</div>
        <div className="p-3.5 rounded-md bg-bg-hover font-mono text-xs text-text-secondary leading-[2]">
          xiaohongshu-scraper/
          <br />
          ├── main.py
          <br />
          ├── scraper.py
          <br />
          ├── config.yaml
          <br />
          ├── requirements.txt
          <br />
          └── README.md
        </div>
      </div>
    </Modal>
  )
}

/* ─── Dependency check (import workflow) ─── */

export function DependencyCheckModal({ allGood = false, onClose }: { allGood?: boolean; onClose?: () => void }) {
  const { t } = useTranslation()
  const dependencies = [
    { name: t('modals.dependency.feishuCli'), type: t('modals.dependency.environment'), status: 'missing' as const, action: t('modals.dependency.installGuide') },
    { name: t('modals.dependency.feishuApp'), type: t('modals.remote.title'), status: 'missing' as const, action: t('modals.dependency.openSettings') },
    { name: 'bridgic-browser', type: 'Skill', status: 'ok' as const, action: null },
  ]
  return (
    <Modal width={520} title={t('modals.dependency.title')} onClose={onClose}>
      <div className="p-5">
        {allGood ? (
          <>
            <div className="flex items-center gap-2.5 p-3.5 rounded-md bg-status-success-bg mb-4">
              <span className="text-status-success">{Icons.check(20)}</span>
              <div>
                <div className="text-sm font-semibold text-text-primary">{t('modals.dependency.allGood')}</div>
                <div className="text-xs text-text-secondary mt-0.5">{t('modals.dependency.allGoodDesc')}</div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Btn onClick={onClose}>{t('modals.common.cancel')}</Btn>
              <Btn variant="primary" size="md" onClick={onClose}>
                {Icons.download(14)} {t('modals.dependency.confirmImport')}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2.5 p-3.5 rounded-md bg-status-warning-bg mb-4">
              <span className="text-status-warning">⚠️</span>
              <div>
                <div className="text-sm font-semibold text-text-primary">{t('modals.dependency.missing')}</div>
                <div className="text-xs text-text-secondary mt-0.5">{t('modals.dependency.missingDesc')}</div>
              </div>
            </div>
            <div className="flex flex-col gap-2 mb-4">
              {dependencies.map((d, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between px-3.5 py-2.5 rounded-md bg-bg-hover border border-border-subtle"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'w-2 h-2 rounded-full inline-block',
                        d.status === 'ok' ? 'bg-status-success' : 'bg-status-error',
                      )}
                    />
                    <div>
                      <div className="text-sm font-medium text-text-primary">{d.name}</div>
                      <div className="text-xs text-text-tertiary">{d.type}</div>
                    </div>
                  </div>
                  {d.action ? (
                    <Btn size="xs" variant="primary">
                      {d.action}
                    </Btn>
                  ) : (
                    <Badge color="success">{t('modals.dependency.installed')}</Badge>
                  )}
                </div>
              ))}
            </div>
            <div className="px-3 py-2.5 rounded-md bg-bg-hover text-xs text-text-secondary leading-[1.6] mb-4">
              {t('modals.dependency.laterHint')}
            </div>
            <div className="flex justify-end gap-2">
              <Btn onClick={onClose}>{t('modals.common.cancel')}</Btn>
              <Btn size="md">{Icons.download(14)} {t('modals.dependency.importLater')}</Btn>
              <Btn variant="primary" size="md" onClick={onClose}>
                {t('modals.dependency.importAfterConfig')}
              </Btn>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/* ─── Session delete ─── */

export function SessionDeleteModal({
  name,
  onConfirm,
  onClose,
}: {
  name?: string
  /** Perform the deletion. The modal closes itself right after. */
  onConfirm?: () => void
  onClose?: () => void
}) {
  const { t } = useTranslation()
  const displayName = name ?? t('modals.sessionDelete.defaultName')
  return (
    <Modal width={400} title={t('modals.sessionDelete.title')} onClose={onClose}>
      <div className="p-5">
        <div className="flex items-center gap-2.5 p-3.5 rounded-md bg-status-error-bg mb-4">
          <span className="text-status-error">{Icons.trash(18)}</span>
          <div className="text-sm text-text-primary leading-[1.5]">
            {t('modals.sessionDelete.message', { name: displayName })}
          </div>
        </div>
        <div className="text-xs text-text-secondary mb-4 leading-[1.6]">
          {t('modals.sessionDelete.warning')}
        </div>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>{t('modals.common.cancel')}</Btn>
          <Btn
            variant="danger"
            size="md"
            onClick={() => {
              onConfirm?.()
              onClose?.()
            }}
          >
            {t('modals.common.confirmDelete')}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Skill deletion confirmation. A basic confirmation + an unrecoverable warning — without "referenced
 * in N places" (reference counting is out of scope for this iteration). Built-in Skills no longer show
 * a delete entry point in the list, so no distinction by source is made here.
 */
export function SkillDeleteModal({
  name = 'feishu-bot',
  onConfirm,
  onClose,
}: {
  name?: string
  /** Perform the deletion. The modal closes itself right after. */
  onConfirm?: () => void
  onClose?: () => void
}) {
  const { t } = useTranslation()
  return (
    <Modal width={400} title={t('modals.skillDelete.title')} onClose={onClose}>
      <div className="p-5">
        <div className="flex items-center gap-2.5 p-3.5 rounded-md bg-status-error-bg mb-4">
          <span className="text-status-error">{Icons.trash(18)}</span>
          <div className="text-sm text-text-primary leading-[1.5]">
            {t('modals.skillDelete.message', { name })}
          </div>
        </div>
        <div className="text-xs text-text-secondary mb-4 leading-[1.6]">
          {t('modals.skillDelete.warning')}
        </div>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>{t('modals.common.cancel')}</Btn>
          <Btn
            variant="danger"
            size="md"
            onClick={() => {
              onConfirm?.()
              onClose?.()
            }}
          >
            {t('modals.common.confirmDelete')}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

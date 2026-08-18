/**
 * Composer placeholder — two flavors, same visual shell.
 *
 * Default (`kind="empty"`, which is what you get by omitting the prop): the CTA shown when the user has not
 * configured a model:
 *   "To start building workflows, first [configure a model]"; the whole row is
 *   clickable and jumps to Settings → Model tab.
 *
 * `kind="error"`: the placeholder shown when model hydration fails (daemon down / /providers erroring), with the
 * error message on the left and a "retry" button on the right. A failing round trip can be very short, so giving
 * the user a manual retry is far less likely to hammer the backend than letting a useEffect retry automatically.
 *
 * Both flavors share the same shell dimensions → the input position does not jitter when the state changes.
 *
 * Lifted out of `ChatInputZone` to keep `FreeFormInput` pure: that
 * component assumes a model exists and never branches on this state.
 */
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Tooltip } from '../amphi/Tooltip'

export interface NoModelPlaceholderProps {
  /** 'empty' = not configured (default); 'error' = hydrate failed */
  kind?: 'empty' | 'error'
  /** Error message to show in error mode (the message thrown by hydrate). */
  message?: string
  /** In 'empty' mode = open settings; in 'error' mode = trigger a hydrate retry. */
  onConfigure: () => void
  /** CTA text in error mode, defaults to "retry". */
  ctaLabel?: string
  /** A retry is in flight in error mode (hydrating): the button is disabled and shows ctaLoadingLabel.
   *  Prevents frantic clicking; together with hydrateModelsAtom's shared Promise this also guarantees that
   *  multiple clicks share the same in-flight request. */
  retrying?: boolean
  /** Retrying text in error mode, defaults to "retrying…". */
  ctaLoadingLabel?: string
}

export function NoModelPlaceholder({
  kind = 'empty',
  message,
  onConfigure,
  ctaLabel,
  retrying = false,
  ctaLoadingLabel,
}: NoModelPlaceholderProps) {
  const { t } = useTranslation()
  if (kind === 'error') {
    return (
      <div
        className={cn(
          'w-full flex items-center gap-3 px-4 py-3.5 rounded-lg border border-status-error/40 bg-status-error-bg shadow-md',
          'text-md leading-[1.6]',
        )}
      >
        <Tooltip content={message} onlyWhenTruncated>
          <span className="flex-1 text-status-error truncate">
            {message ?? t('composer.noModel.loadFailed')}
          </span>
        </Tooltip>
        <button
          type="button"
          onClick={onConfigure}
          disabled={retrying}
          className={cn(
            'flex-shrink-0 px-3 py-1 rounded-md text-white text-sm font-medium outline-none',
            retrying
              ? 'bg-status-error/60 cursor-not-allowed'
              : 'bg-status-error hover:opacity-90 cursor-pointer focus-visible:ring-2 focus-visible:ring-status-error/40',
          )}
        >
          {retrying ? (ctaLoadingLabel ?? t('composer.noModel.retrying')) : (ctaLabel ?? t('composer.noModel.retry'))}
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onConfigure}
      className={cn(
        // Outer shape mirrors `FreeFormInput`'s input-box styling: rounded corners + light border +
        // shadow-md, so that in both the Landing and Pipeline contexts it reads as
        // "a placeholder in the input box's place" rather than an extra banner.
        'group w-full flex items-center px-4 py-3.5 rounded-lg border border-border-default bg-bg-input shadow-md',
        'text-left text-md text-text-tertiary leading-[1.6]',
        'transition-colors hover:border-brand-blue/60 cursor-pointer',
        'outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/40',
      )}
      aria-label={t('composer.noModel.configureAria')}
    >
      <span>{t('composer.noModel.ctaPrefix')}</span>
      {/* The inline blue "configure model" — visual emphasis, with an underline on hover to signal explicitly that it is clickable. */}
      <span className="ml-1 font-semibold text-text-accent group-hover:underline underline-offset-2">
        {t('composer.noModel.configure')}
      </span>
    </button>
  )
}

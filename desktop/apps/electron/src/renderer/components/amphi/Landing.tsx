/**
 * Landing — center column when no session is active.
 *
 * Hero (logo + tagline) + input box (or model-config prompt when needsModelConfig).
 *
 * The workflow market grid reads live data from showcase.bridgic.ai, handed in by
 * the caller through `marketCards`. When that is absent — no network and no cached
 * copy — it falls back to the six built-in i18n entries, so the section always
 * renders something rather than an empty grid.
 *
 * Only "preview" is offered. Import and re-create were deleted rather than left
 * inert: a button that does nothing promises a feature that does not exist, which
 * is what kept this whole section hidden until now.
 *
 * `inputSlot` lets the caller replace the visual fake input with a real
 * composer (e.g. ChatInputZone). When provided, the default fake input +
 * suggestion tags are NOT rendered. Composer sits in the same visual
 * position (directly below the hero) so the page reads as a single
 * unified surface, not as a fake input + separate sticky input combo.
 *
 * Refactored to Tailwind className per §1.22.
 */

import type { ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { APP_PRODUCT_NAME } from '@shared/app-meta'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'
import { Badge, BridgicLogo, Btn, Card, Tag } from './Primitives'

/**
 * One market entry, shaped to match the showcase payload field-for-field so the
 * caller can hand rows straight through without mapping.
 *
 * `status` is a free-form string rather than a union: the publisher may introduce
 * a third status, and an unknown one should quietly fall through to "not
 * verified" instead of failing to type-check in an already-shipped build.
 */
export interface MarketCard {
  id: string
  name: string
  desc: string
  domain: string
  status: string
  /** Site-relative path of this workflow's page, used by the preview dialog. */
  path: string
}

export interface LandingProps {
  needsModelConfig?: boolean
  onConfigureModel?: () => void
  marketCards?: MarketCard[]
  onPickMarket?: (card: MarketCard) => void
  /** Replace the default visual fake input with a real composer slot. */
  inputSlot?: ReactNode
}

/** Input area in the middle of Landing: an external composer slot wins; otherwise it shows either the model-config
 *  prompt card or the visual fake input box depending on whether a model needs configuring. Extracted into a child
 *  component (returning early inside) to avoid writing nested conditional ternaries in Landing. */
interface LandingInputProps {
  needsModelConfig: boolean
  onConfigureModel?: () => void
  inputSlot?: ReactNode
}

function LandingInput({ needsModelConfig, onConfigureModel, inputSlot }: LandingInputProps) {
  const { t } = useTranslation()
  if (inputSlot) return <>{inputSlot}</>
  if (needsModelConfig) {
    return (
      <div className="p-5 rounded-xl bg-bg-elevated border border-border-default shadow-md">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-accent-blue-subtle flex items-center justify-center flex-shrink-0">
            {Icons.robot(20)}
          </div>
          <div>
            <div className="text-md font-semibold text-text-primary mb-1">{t('landing.modelConfig.title')}</div>
            <div className="text-sm text-text-secondary leading-[1.6]">
              {t('landing.modelConfig.description', { product: APP_PRODUCT_NAME })}
            </div>
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <Btn variant="primary" size="md" onClick={onConfigureModel}>
            {Icons.settings(14)} {t('landing.modelConfig.configure')}
          </Btn>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-end gap-2 px-4 py-3 rounded-xl bg-bg-elevated border border-border-default shadow-md">
      {/* Visual fake input box: shown only when inputSlot is not provided. The tags section ("Xiaohongshu scraper" etc.)
          used to have cursor:pointer but no onClick, so clicking did nothing and misled users; it has been removed. */}
      <div className="flex-1">
        <div className="text-md text-text-tertiary leading-[1.6]">
          {t('landing.inputHint.before')}<span className="text-text-accent">/build</span>{t('landing.inputHint.after')}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="text-text-tertiary p-1">{Icons.at(18)}</div>
        <div className="text-text-tertiary p-1">{Icons.slash(18)}</div>
        <div className="w-8 h-8 rounded-md flex items-center justify-center text-white bg-[image:var(--brand-gradient)]">
          {Icons.send(16)}
        </div>
      </div>
    </div>
  )
}

export function Landing({ needsModelConfig = false, onConfigureModel, marketCards, onPickMarket, inputSlot }: LandingProps) {
  // No built-in fallback list: with nothing fetched the market simply is not
  // there. A placeholder would promise cards that may never arrive.
  const cards = marketCards ?? []
  const hasCards = cards.length > 0
  return (
    <div
      className={cn(
        'flex-1 flex flex-col items-center px-10 overflow-auto',
        // Centred in every state, deliberately: as the market grows in below, centring
        // is what lifts the hero and the input upward, which is the motion this page
        // wants. Switching alignment instead (top-aligned once cards exist) cannot be
        // animated — `justify-content` is not an animatable property, so it would jump.
        //
        // **Asymmetric top/bottom padding** rather than plain centring: geometric
        // centring reads as too low to the human eye (the optical centre sits above the
        // geometric one), so the extra bottom padding lifts the content by ~44px.
        // Not -translate-y: that is a paint-time offset taking no layout space, so a
        // short window would clip it via overflow.
        //
        // `justify-center-safe` (not `justify-center`): this container is overflow-auto,
        // and `justify-content:center` overflows towards **both** ends once the content
        // is taller than the box, making the start-side half unreachable by scrolling —
        // zooming in (⌘+), a short window, or a long market list would permanently clip
        // the hero. Safe alignment falls back to start on overflow, so a long list stays
        // scrollable.
        'justify-center-safe pt-10 pb-32',
      )}
    >
      {/* Hero — brand icon + product name. Uses `square` (icon only) rather than `wordmark`: the latter's SVG already
          contains the word "Bridgic", which read together with the product name to its right would come out as
          "Bridgic Amphi". Keeps the same shape as the logo at the top of the left sidebar. The name comes from the
          single source of truth in app-meta and is no longer hard-coded. */}
      <div className="flex items-center gap-3 mb-2">
        <BridgicLogo size={32} />
        <span className="text-2xl font-bold text-text-primary">{APP_PRODUCT_NAME}</span>
      </div>
      {/* Capped at the composer's 640px, not the 420px it used to be: at 15px the Chinese
          tagline measures ~430px (a 6-char `/build` chip plus 25 full-width glyphs), so it
          wrapped to a second line with plenty of window left over, while the shorter English
          one fit. The cap still holds — a narrow window wraps it as before. */}
      <p className="text-md text-text-secondary mb-8 text-center max-w-[640px] leading-[1.6]">
        <Trans
          i18nKey="landing.tagline"
          components={{
            code: <code className="px-1 py-0.5 rounded bg-bg-hover font-mono text-[0.85em]" />,
          }}
        />
      </p>

      {/* Input box / config prompt / external composer slot. The gap towards the
          market lives inside the animated container below, so it grows with the
          cards instead of leaving a hole while the market is empty. */}
      <div className="w-full max-w-[640px]">
        <LandingInput
          needsModelConfig={needsModelConfig}
          onConfigureModel={onConfigureModel}
          inputSlot={inputSlot}
        />
      </div>

      {/* Grows in rather than popping in: grid-template-rows animates 0fr → 1fr
          (Chromium 107+, which Electron 39 is well past). The wrapper must stay
          mounted for the transition to have a starting point, so the *contents* are
          what render conditionally. `overflow-hidden` is what makes 0fr clip rather
          than spill. */}
      <div
        className="grid w-full transition-[grid-template-rows,opacity] duration-500 ease-out"
        style={{ gridTemplateRows: hasCards ? '1fr' : '0fr', opacity: hasCards ? 1 : 0 }}
      >
        {/* justify-center because the wrapper above is full-width for the animation:
            WorkflowMarket caps itself at 800px, which would otherwise sit flush left
            while the hero and composer above it are centred. */}
        <div className="overflow-hidden pt-12 flex justify-center">
          {hasCards && <WorkflowMarket cards={cards} onPick={onPickMarket} />}
        </div>
      </div>
    </div>
  )
}

interface WorkflowMarketProps {
  cards: MarketCard[]
  onPick?: (card: MarketCard) => void
}

/** The "workflow market" section.
 *
 *  Extracted into a child component rather than inlined as conditional rendering inside Landing (§1.24): Landing's
 *  return stays declarative and single-level, and while this section is hidden the main component does not have to carry all of its render detail. */
function WorkflowMarket({ cards, onPick }: WorkflowMarketProps) {
  const { t } = useTranslation()
  return (
    <div className="w-full max-w-[800px]">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-text-primary m-0">{t('landing.market.title')}</h3>
        <span className="text-xs text-text-tertiary">{t('landing.market.officialRecommended')}</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {cards.map((c, i) => (
          <Card
            key={i}
            data-testid={`market-card-${i}`}
            className="p-4 cursor-pointer"
            onClick={() => onPick?.(c)}
          >
            <div className="flex items-start justify-between mb-2.5">
              <div className="w-9 h-9 rounded-md bg-accent-blue-subtle flex items-center justify-center text-text-accent">
                {Icons.workflow(18)}
              </div>
              {c.status === 'verified' && <Badge color="success">{t('landing.market.verified')}</Badge>}
            </div>
            <div className="text-sm font-semibold text-text-primary mb-1">{c.name}</div>
            <div className="text-xs text-text-secondary leading-[1.5] mb-3 min-h-[32px]">{c.desc}</div>
            <Tag>{c.domain}</Tag>
            {/* Preview only. The click handler lives on the Card, so this button
                deliberately has none of its own -- the click bubbles up to it. */}
            <div className="flex mt-3">
              <Btn variant="ghost" size="xs" className="flex-1">
                {Icons.eye(12)} {t('landing.market.preview')}
              </Btn>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

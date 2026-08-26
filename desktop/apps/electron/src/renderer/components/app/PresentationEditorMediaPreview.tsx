import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from 'react'
import { AudioLines, Pause, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PresentationMediaElement } from '@/atoms/presentation'

export interface PresentationEditorMediaPreviewProps {
  element: PresentationMediaElement
}

const AUDIO_WAVEFORM = [0.38, 0.72, 0.5, 0.9, 0.62, 0.42, 0.78, 0.56, 0.86, 0.48, 0.7, 0.36] as const

function finiteMediaTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function formatMediaTime(value: number): string {
  const seconds = Math.max(0, Math.floor(finiteMediaTime(value)))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function stopPropagation(event: SyntheticEvent): void {
  event.stopPropagation()
}

function PresentationEditorMediaPreviewSession({ element }: PresentationEditorMediaPreviewProps) {
  const { t } = useTranslation()
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const setMediaRef = useCallback((media: HTMLMediaElement | null) => {
    mediaRef.current = media
  }, [])
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const buttonSize = element.type === 'video' ? 44 : 38
  const mediaLabel = `${t(`session.presentation.${element.type}`)}: ${element.source.fileName}`
  const toggleLabel = t(playing ? 'session.presentation.mediaPause' : 'session.presentation.mediaPlay')
  const safeDuration = finiteMediaTime(duration)
  const safeCurrentTime = Math.min(finiteMediaTime(currentTime), safeDuration || Number.POSITIVE_INFINITY)

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    media.autoplay = false
    media.pause()
    return () => media.pause()
  }, [])

  const syncTiming = (media: HTMLMediaElement) => {
    setCurrentTime(finiteMediaTime(media.currentTime))
    setDuration(finiteMediaTime(media.duration))
  }

  const togglePlayback = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const media = mediaRef.current
    if (!media) return
    if (playing) {
      setPlaying(false)
      media.pause()
      return
    }
    setPlaying(true)
    try {
      void media.play().catch(() => setPlaying(false))
    } catch {
      setPlaying(false)
    }
  }

  const seek = (event: ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation()
    const nextTime = Number(event.currentTarget.value)
    const media = mediaRef.current
    if (!media || !Number.isFinite(nextTime)) return
    media.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  const sharedMediaProps = {
    'aria-hidden': true,
    'data-testid': 'presentation-editor-media-preview-media',
    loop: element.loop,
    muted: element.muted,
    onDurationChange: (event: SyntheticEvent<HTMLMediaElement>) => syncTiming(event.currentTarget),
    onEnded: (event: SyntheticEvent<HTMLMediaElement>) => {
      setPlaying(false)
      syncTiming(event.currentTarget)
    },
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => syncTiming(event.currentTarget),
    onPause: () => setPlaying(false),
    onPlay: () => setPlaying(true),
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => syncTiming(event.currentTarget),
    preload: 'metadata' as const,
    src: element.source.dataUrl,
    tabIndex: -1,
  }

  const toggleButton = (
    <button
      type="button"
      aria-label={toggleLabel}
      title={toggleLabel}
      data-testid="presentation-editor-media-preview-toggle"
      className="pointer-events-auto flex shrink-0 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/85"
      style={{ width: buttonSize, height: buttonSize }}
      onClick={togglePlayback}
      onDoubleClick={stopPropagation}
      onKeyDown={stopPropagation}
      onKeyUp={stopPropagation}
      onMouseDown={stopPropagation}
      onMouseUp={stopPropagation}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
    >
      {playing ? <Pause aria-hidden="true" className="size-1/2" fill="currentColor" /> : <Play aria-hidden="true" className="size-1/2 translate-x-[5%]" fill="currentColor" />}
    </button>
  )

  const seekControl = (
    <input
      type="range"
      aria-label={t('session.presentation.mediaSeek')}
      title={t('session.presentation.mediaSeek')}
      data-testid="presentation-editor-media-preview-seek"
      className="pointer-events-auto h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full accent-[#745DF5] disabled:cursor-default disabled:opacity-45"
      min={0}
      max={safeDuration}
      step={0.01}
      value={safeDuration ? safeCurrentTime : 0}
      disabled={!safeDuration}
      onChange={seek}
      onClick={stopPropagation}
      onDoubleClick={stopPropagation}
      onKeyDown={stopPropagation}
      onKeyUp={stopPropagation}
      onMouseDown={stopPropagation}
      onMouseUp={stopPropagation}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
    />
  )

  return (
    <div
      role="group"
      aria-label={mediaLabel}
      data-media-type={element.type}
      data-testid="presentation-editor-media-preview"
      className="pointer-events-none relative size-full overflow-hidden rounded-xl"
    >
      {element.type === 'audio' ? (
        <div className="absolute inset-0 flex items-center gap-3 overflow-hidden rounded-xl border border-[#CFC5FF] bg-[linear-gradient(135deg,#F7F4FF_0%,#E9E3FF_54%,#DDD5FF_100%)] px-3 text-[#332A63] shadow-[0_8px_22px_rgba(73,57,151,0.16)]">
          <audio ref={setMediaRef} className="pointer-events-none absolute size-px opacity-0" {...sharedMediaProps} />
          {toggleButton}
          <AudioLines aria-hidden="true" className="size-5 shrink-0 text-[#6957D9]" />
          <div className="min-w-0 flex-1">
            <div data-testid="presentation-editor-media-preview-filename" className="truncate text-sm font-semibold text-[#332A63]" title={element.source.fileName}>{element.source.fileName}</div>
            <div className="mt-1 flex items-center gap-2">
              <span data-testid="presentation-editor-media-preview-waveform" className="flex h-3.5 shrink-0 items-center gap-0.5" aria-hidden="true">
                {AUDIO_WAVEFORM.map((height, index) => <span key={index} className="w-0.5 rounded-full bg-[#8B7CFF]" style={{ height: `${height * 100}%` }} />)}
              </span>
              {seekControl}
              <span className="shrink-0 text-[10px] tabular-nums text-[#625887]">{formatMediaTime(safeCurrentTime)} / {formatMediaTime(safeDuration)}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 grid grid-cols-[160px_minmax(0,1fr)] overflow-hidden rounded-xl border border-white/15 bg-[linear-gradient(135deg,#1F2A49_0%,#101629_58%,#0B0E18_100%)] text-white shadow-[0_8px_24px_rgba(10,10,16,0.24)]">
          <div className="relative overflow-hidden bg-black">
            <video ref={setMediaRef} playsInline className="pointer-events-none absolute inset-0 size-full bg-black object-contain" {...sharedMediaProps} />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(9,9,14,0.12)_70%,rgba(9,9,14,0.38)_100%)]" />
            <div className="absolute inset-0 flex items-center justify-center">{toggleButton}</div>
          </div>
          <div className="flex min-w-0 flex-col justify-center gap-3 px-4">
            <div data-testid="presentation-editor-media-preview-filename" className="truncate text-sm font-semibold" title={element.source.fileName}>{element.source.fileName}</div>
            <div className="flex items-center gap-2">
              {seekControl}
              <span className="shrink-0 text-[10px] tabular-nums text-white/75">{formatMediaTime(safeCurrentTime)} / {formatMediaTime(safeDuration)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** On-demand editor transport for the selected Fabric media proxy. */
export function PresentationEditorMediaPreview({ element }: PresentationEditorMediaPreviewProps) {
  return <PresentationEditorMediaPreviewSession key={element.id} element={element} />
}

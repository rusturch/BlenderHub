import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import Dropdown from '../../components/Dropdown'
import { useTranslation } from '../../lib/i18n'
import { hexToRgb, hslToHsv, hsvToHsl, hsvToRgb, rgbToHex, rgbToHsv } from './color-utils'
import type { Hsv } from './color-utils'
import { EyedropperIcon } from './icons'

// Custom color picker: the native <input type="color"> popup cannot be
// restyled, so this rebuilds it — the SV square with a hue strip underneath,
// plus RGB ⇄ HSL channel sliders instead of the native number fields.

const RAINBOW =
  'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)'

const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window

// Chromium can clamp a controlled range's value against the not-yet-applied max
// while the input (re)mounts — the RGB⇄HSL switch remounts the channel rows, so
// a thumb could freeze at the default max (100) while the readout is correct.
// Re-asserting the DOM value after every render keeps the thumb honest.
const syncRangeValue = (el: HTMLInputElement | null, value: number): void => {
  if (el && el.value !== String(value)) el.value = String(value)
}

interface Channel {
  key: string
  label: string
  value: number
  max: number
  track: string
  set: (value: number) => void
}

export function ColorPicker({
  hex,
  onChange
}: {
  hex: string
  onChange: (hex: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'rgb' | 'hsl'>('rgb')

  // HSV is the picker's source of truth while open — hue/saturation survive on
  // grays and black (where hex carries neither); it re-syncs from hex only on
  // EXTERNAL changes (typed hex, other window), tracked via selfHex
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(hexToRgb(hex)))
  const selfHex = useRef(hex)
  useEffect(() => {
    if (hex !== selfHex.current) {
      setHsv(rgbToHsv(hexToRgb(hex)))
      selfHex.current = hex
    }
  }, [hex])

  const emit = (next: Hsv): void => {
    setHsv(next)
    const nextHex = rgbToHex(hsvToRgb(next))
    selfHex.current = nextHex
    if (nextHex !== hex) onChange(nextHex)
  }

  const squareRef = useRef<HTMLDivElement | null>(null)
  const dragSquare = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = squareRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    const s = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100))
    const v = Math.min(100, Math.max(0, (1 - (event.clientY - rect.top) / rect.height) * 100))
    emit({ ...hsv, s, v })
  }

  const pickFromScreen = async (): Promise<void> => {
    const Ctor = (
      window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }
    ).EyeDropper
    if (!Ctor) return
    try {
      const result = await new Ctor().open()
      if (result?.sRGBHex) {
        // external-style update: let the sync effect adopt it
        onChange(result.sRGBHex)
      }
    } catch {
      // the user dismissed the eyedropper — nothing to do
    }
  }

  const rgb = hsvToRgb(hsv)
  const hsl = hsvToHsl(hsv)

  // channel edits preserve what the target space cannot express: a gray keeps
  // its hue, black keeps hue and saturation
  const emitRgbChannel = (channel: 'r' | 'g' | 'b', value: number): void => {
    const next = rgbToHsv({ ...rgb, [channel]: value })
    if (next.s === 0) next.h = hsv.h
    if (next.v === 0) {
      next.h = hsv.h
      next.s = hsv.s
    }
    emit(next)
  }
  const emitHslChannel = (channel: 's' | 'l', value: number): void => {
    emit(hslToHsv({ ...hsl, [channel]: value }))
  }

  const channels: Channel[] =
    mode === 'rgb'
      ? [
          {
            key: 'r',
            label: 'R',
            value: rgb.r,
            max: 255,
            track: `linear-gradient(to right, rgb(0,${rgb.g},${rgb.b}), rgb(255,${rgb.g},${rgb.b}))`,
            set: (value) => emitRgbChannel('r', value)
          },
          {
            key: 'g',
            label: 'G',
            value: rgb.g,
            max: 255,
            track: `linear-gradient(to right, rgb(${rgb.r},0,${rgb.b}), rgb(${rgb.r},255,${rgb.b}))`,
            set: (value) => emitRgbChannel('g', value)
          },
          {
            key: 'b',
            label: 'B',
            value: rgb.b,
            max: 255,
            track: `linear-gradient(to right, rgb(${rgb.r},${rgb.g},0), rgb(${rgb.r},${rgb.g},255))`,
            set: (value) => emitRgbChannel('b', value)
          }
        ]
      : [
          {
            key: 'h',
            label: 'H',
            value: hsl.h,
            max: 360,
            track: RAINBOW,
            set: (value) => emit({ ...hsv, h: value })
          },
          {
            key: 's',
            label: 'S',
            value: hsl.s,
            max: 100,
            track: `linear-gradient(to right, hsl(${hsl.h},0%,${hsl.l}%), hsl(${hsl.h},100%,${hsl.l}%))`,
            set: (value) => emitHslChannel('s', value)
          },
          {
            key: 'l',
            label: 'L',
            value: hsl.l,
            max: 100,
            track: `linear-gradient(to right, hsl(${hsl.h},${hsl.s}%,0%), hsl(${hsl.h},${hsl.s}%,50%), hsl(${hsl.h},${hsl.s}%,100%))`,
            set: (value) => emitHslChannel('l', value)
          }
        ]

  return (
    <Dropdown
      open={open}
      onClose={() => setOpen(false)}
      align="right"
      menuClassName="w-60 rounded-lg border border-white/10 bg-surface-menu p-3 shadow-xl"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          title={t('settings.colorPickerOpen')}
          className="h-6 w-9 shrink-0 cursor-pointer rounded border border-white/10"
          style={{ backgroundColor: hex }}
        />
      }
    >
      <div className="flex flex-col gap-3">
        <div
          ref={squareRef}
          onPointerDown={(event) => {
            event.preventDefault()
            try {
              event.currentTarget.setPointerCapture(event.pointerId)
            } catch {
              // synthetic events may carry no real pointerId
            }
            dragSquare(event)
          }}
          onPointerMove={(event) => {
            if (event.buttons & 1) dragSquare(event)
          }}
          className="relative h-32 w-full cursor-crosshair touch-none rounded"
          style={{
            // no border and no repeat: a gradient tile wrapping under a
            // semi-transparent border paints thin false-color edge stripes
            background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${Math.round(hsv.h)}, 100%, 50%))`,
            backgroundRepeat: 'no-repeat'
          }}
        >
          <span
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
            style={{ left: `${hsv.s}%`, bottom: `${hsv.v}%`, backgroundColor: hex }}
          />
        </div>
        <input
          type="range"
          ref={(el) => syncRangeValue(el, Math.round(hsv.h))}
          min={0}
          max={360}
          value={Math.round(hsv.h)}
          onChange={(event) => emit({ ...hsv, h: Number(event.target.value) })}
          className="theme-slider h-2.5 w-full"
          style={{ background: RAINBOW }}
        />
        <div className="flex items-center justify-between">
          {hasEyeDropper ? (
            <button
              type="button"
              onClick={pickFromScreen}
              title={t('settings.colorPickerEyedropper')}
              className="rounded-md border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200"
            >
              <EyedropperIcon className="h-4 w-4" />
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => setMode((value) => (value === 'rgb' ? 'hsl' : 'rgb'))}
            title={t('settings.colorPickerMode')}
            className="rounded-md border border-white/10 px-2 py-1.5 text-[10px] font-semibold text-zinc-300 transition-colors hover:bg-white/10"
          >
            {mode.toUpperCase()}
          </button>
        </div>
        {channels.map((channel) => (
          <div key={channel.key} className="flex items-center gap-2">
            <span className="w-3 text-center text-[10px] font-medium text-zinc-400">
              {channel.label}
            </span>
            <input
              type="range"
              ref={(el) => syncRangeValue(el, Math.round(channel.value))}
              min={0}
              max={channel.max}
              value={Math.round(channel.value)}
              onChange={(event) => channel.set(Number(event.target.value))}
              className="theme-slider h-2.5 flex-1"
              style={{ background: channel.track }}
            />
            <span className="w-7 text-right font-mono text-[10px] text-zinc-500">
              {Math.round(channel.value)}
            </span>
          </div>
        ))}
      </div>
    </Dropdown>
  )
}

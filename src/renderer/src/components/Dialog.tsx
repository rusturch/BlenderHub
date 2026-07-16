import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../lib/i18n'

type DialogVariant = 'none' | 'warning' | 'danger'
type DialogTone = 'default' | 'danger'

interface ConfirmOptions {
  title: string
  message: ReactNode
  variant?: DialogVariant
  tone?: DialogTone
  confirmLabel?: string
  cancelLabel?: string
}

interface AlertOptions {
  title?: string
  message: ReactNode
  variant?: DialogVariant
  okLabel?: string
}

interface DialogContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  alert: (options: AlertOptions | string) => Promise<void>
}

const DialogContext = createContext<DialogContextValue | null>(null)

function WarningIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" x2="12" y1="9" y2="13" />
      <line x1="12" x2="12.01" y1="17" y2="17" />
    </svg>
  )
}

const VARIANT_BOX: Record<Exclude<DialogVariant, 'none'>, string> = {
  warning: 'border-amber-500/20 bg-amber-500/5 text-amber-400',
  danger: 'border-red-500/20 bg-red-500/5 text-red-400'
}

type PendingDialog =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'alert'; options: AlertOptions; resolve: () => void }

export function DialogProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<PendingDialog | null>(null)

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ kind: 'confirm', options, resolve })
    })
  }, [])

  const alertFn = useCallback((options: AlertOptions | string) => {
    const normalized = typeof options === 'string' ? { message: options } : options
    return new Promise<void>((resolve) => {
      setPending({ kind: 'alert', options: normalized, resolve })
    })
  }, [])

  const close = useCallback((result: boolean) => {
    setPending((current) => {
      if (!current) return null
      if (current.kind === 'confirm') current.resolve(result)
      else current.resolve()
      return null
    })
  }, [])

  const value = useMemo(() => ({ confirm, alert: alertFn }), [confirm, alertFn])

  const variant = pending?.options.variant ?? 'none'
  const tone: DialogTone = (pending?.kind === 'confirm' && pending.options.tone) || 'default'
  const primaryButtonClass =
    tone === 'danger'
      ? 'rounded-lg bg-red-500/90 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500'
      : 'rounded-lg bg-blender px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blender/90'

  return (
    <DialogContext.Provider value={value}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => close(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-white/10 bg-[#1c1c1c] p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-100">
              {pending.kind === 'confirm' ? pending.options.title : (pending.options.title ?? t('common.error'))}
            </h2>
            {variant === 'none' ? (
              <p className="mt-3 text-sm leading-relaxed text-zinc-300">{pending.options.message}</p>
            ) : (
              <div className={`mt-3 flex gap-3 rounded-lg border p-3 ${VARIANT_BOX[variant]}`}>
                <WarningIcon className="mt-0.5 h-5 w-5 shrink-0" />
                <p className="text-sm leading-relaxed text-zinc-300">{pending.options.message}</p>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              {pending.kind === 'confirm' && (
                <button
                  onClick={() => close(false)}
                  className="rounded-lg border border-white/10 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5"
                >
                  {pending.options.cancelLabel ?? t('common.cancel')}
                </button>
              )}
              <button onClick={() => close(true)} className={primaryButtonClass}>
                {pending.kind === 'confirm' ? (pending.options.confirmLabel ?? t('common.confirm')) : (pending.options.okLabel ?? t('common.ok'))}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  )
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialog must be used within DialogProvider')
  return ctx
}

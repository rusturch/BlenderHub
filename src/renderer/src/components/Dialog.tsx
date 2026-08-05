import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../lib/i18n'
import { useBackdropClose } from '../lib/use-backdrop-close'

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

export interface ChoiceButton {
  id: string
  label: string
  kind?: 'primary' | 'secondary' | 'danger'
}

interface ChooseOptions {
  title: string
  message: ReactNode
  variant?: DialogVariant
  /** rendered left to right; backdrop click resolves null */
  buttons: ChoiceButton[]
}

interface DialogContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  alert: (options: AlertOptions | string) => Promise<void>
  choose: (options: ChooseOptions) => Promise<string | null>
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
  | { kind: 'choose'; options: ChooseOptions; resolve: (value: string | null) => void }

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

  const choose = useCallback((options: ChooseOptions) => {
    return new Promise<string | null>((resolve) => {
      setPending({ kind: 'choose', options, resolve })
    })
  }, [])

  const close = useCallback((result: boolean | string | null) => {
    setPending((current) => {
      if (!current) return null
      if (current.kind === 'confirm') current.resolve(result === true)
      else if (current.kind === 'choose') current.resolve(typeof result === 'string' ? result : null)
      else current.resolve()
      return null
    })
  }, [])

  const value = useMemo(() => ({ confirm, alert: alertFn, choose }), [confirm, alertFn, choose])
  const backdrop = useBackdropClose(() => close(false))

  const variant = pending?.options.variant ?? 'none'
  const tone: DialogTone = (pending?.kind === 'confirm' && pending.options.tone) || 'default'
  const primaryButtonClass =
    tone === 'danger'
      ? 'rounded-lg bg-red-500/90 px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-red-500'
      : 'rounded-lg bg-accent-button px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-button-hover'

  return (
    <DialogContext.Provider value={value}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          {...backdrop}
        >
          <div
            className="w-full max-w-md rounded-xl border border-white/10 bg-surface-dialog p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-100">
              {pending.kind === 'confirm' ? pending.options.title : (pending.options.title ?? t('common.error'))}
            </h2>
            {/* whitespace-pre-line: callers build multi-line bodies (bulleted failure lists,
                "\n\n" notes appended to a confirm). Without it every newline collapses into a
                space and the whole thing reads as one run-on paragraph. max-h + scroll keeps a
                long list (one line per add-on × version) from growing past the window. */}
            {variant === 'none' ? (
              <p className="mt-3 max-h-[50vh] overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-zinc-300">
                {pending.options.message}
              </p>
            ) : (
              <div className={`mt-3 flex gap-3 rounded-lg border p-3 ${VARIANT_BOX[variant]}`}>
                <WarningIcon className="mt-0.5 h-5 w-5 shrink-0" />
                <p className="max-h-[50vh] overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-zinc-300">
                  {pending.options.message}
                </p>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              {pending.kind === 'choose' ? (
                pending.options.buttons.map((button) => (
                  <button
                    key={button.id}
                    onClick={() => close(button.id)}
                    className={
                      button.kind === 'danger'
                        ? 'rounded-lg bg-red-500/90 px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-red-500'
                        : button.kind === 'primary'
                          ? 'rounded-lg bg-accent-button px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-button-hover'
                          : 'rounded-lg border border-white/10 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10'
                    }
                  >
                    {button.label}
                  </button>
                ))
              ) : (
                <>
                  {pending.kind === 'confirm' && (
                    <button
                      onClick={() => close(false)}
                      className="rounded-lg border border-white/10 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10"
                    >
                      {pending.options.cancelLabel ?? t('common.cancel')}
                    </button>
                  )}
                  <button onClick={() => close(true)} className={primaryButtonClass}>
                    {pending.kind === 'confirm'
                      ? (pending.options.confirmLabel ?? t('common.confirm'))
                      : (pending.options.okLabel ?? t('common.ok'))}
                  </button>
                </>
              )}
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

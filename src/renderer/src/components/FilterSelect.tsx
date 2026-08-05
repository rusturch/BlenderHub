import { useState } from 'react'
import Dropdown from './Dropdown'

function ChevronDownIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function CheckIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  width = 'w-28'
}: {
  /** what this filter is — shown on hover rather than as a caption above the control */
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  width?: string
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  return (
    <Dropdown
      open={open}
      onClose={() => setOpen(false)}
      align="left"
      menuClassName={`${width} overflow-hidden rounded-lg border border-white/10 bg-surface-menu py-1 shadow-xl`}
      trigger={
        <button
          type="button"
          title={label}
          onClick={() => setOpen((prev) => !prev)}
          className={`flex ${width} items-center justify-between gap-1.5 rounded-lg border border-white/10 bg-surface-panel px-2.5 py-1 text-sm text-zinc-200 transition-colors hover:bg-white/10`}
        >
          <span className="truncate">{current?.label ?? value}</span>
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        </button>
      }
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => {
            onChange(option.value)
            setOpen(false)
          }}
          className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10"
        >
          <span className="truncate">{option.label}</span>
          {option.value === value && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-blender" />}
        </button>
      ))}
    </Dropdown>
  )
}

/**
 * The search field in a center page's header. One width, one markup shape.
 *
 * It is a <label>, not a <div>: wrapping the icon and the input means clicking
 * anywhere in the box focuses the field. Skills used a <div> and quietly lost
 * that — the icon was dead to the pointer.
 */
import { cn } from '@/lib/cn'
import { Icons } from './Icons'

export function SearchBox({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-bg-input border border-border-subtle w-[220px]',
        className,
      )}
    >
      {Icons.search(14)}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
      />
    </label>
  )
}

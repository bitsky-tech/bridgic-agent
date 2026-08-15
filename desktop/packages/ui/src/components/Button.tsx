import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2',
    'disabled:pointer-events-none disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900',
        secondary: 'bg-slate-200 text-slate-900 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-100',
        ghost: 'hover:bg-slate-100 dark:hover:bg-slate-800',
        danger: 'bg-red-600 text-white hover:bg-red-700',
      },
      size: {
        sm: 'h-7 px-2',
        md: 'h-9 px-3',
        lg: 'h-11 px-4',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, ...rest },
  ref,
) {
  return <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...rest} />
})

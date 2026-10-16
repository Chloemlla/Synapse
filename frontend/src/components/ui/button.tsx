import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { isValidElement } from 'react';

import { cn } from '@/utils/cn';

/**
 * shell（sidebar / sheet / tooltip）用的按钮。
 *
 * 配色与圆角已经收敛到 studioTheme 的基准（slate-900 主操作 + slate 边框 + white/80 面 +
 * rose 语义危险色 + rounded-2xl / rounded-full），不再吃 sidebar-theme.css 的 oklch 主色，
 * 否则同一个站点会出现两种主按钮颜色
 * （docs/audit/audit-2026-10-16-frontend-design-language.md FD-004 / FD-005）。
 * `max-sm:min-h-11` 保证移动端触控目标 ≥44px（FD-067）。
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-2xl border-2 border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition outline-none select-none max-sm:min-h-11 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-rose-300 aria-invalid:ring-2 aria-invalid:ring-rose-200/60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-slate-900 text-white hover:bg-slate-800',
        outline:
          'border-slate-200 bg-white/80 text-slate-700 hover:border-slate-300 hover:text-slate-900 aria-expanded:border-slate-300 aria-expanded:text-slate-900',
        secondary:
          'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 aria-expanded:bg-slate-100',
        ghost:
          'text-slate-600 hover:bg-slate-100 hover:text-slate-900 aria-expanded:bg-slate-100',
        destructive:
          'border-rose-200 bg-rose-50/80 text-rose-700 hover:bg-rose-100 focus-visible:ring-rose-300',
        link: 'text-slate-700 underline-offset-4 hover:text-slate-900 hover:underline',
      },
      size: {
        default:
          'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 px-2 text-xs in-data-[slot=button-group]:rounded-2xl has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-2xl has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        icon: 'size-8 rounded-full',
        'icon-xs': "size-6 rounded-full [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-7 rounded-full',
        'icon-lg': 'size-9 rounded-full',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function isNativeButtonRender(render: ButtonPrimitive.Props['render']) {
  if (!render || !isValidElement(render)) {
    return true;
  }

  return render.type === 'button';
}

function Button({
  className,
  variant = 'default',
  size = 'default',
  nativeButton,
  render,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot='button'
      className={cn(buttonVariants({ variant, size, className }))}
      nativeButton={nativeButton ?? isNativeButtonRender(render)}
      render={render}
      {...props}
    />
  );
}

export { Button, buttonVariants };

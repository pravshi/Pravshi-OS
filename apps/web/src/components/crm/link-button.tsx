import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import type { VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

/**
 * A next/link styled exactly like the shadcn Button (this codebase's base-ui
 * Button carries no asChild prop, so links can't compose through it).
 */
export function LinkButton({
  href,
  variant,
  size,
  className,
  children,
}: {
  href: string;
  variant?: VariantProps<typeof buttonVariants>['variant'];
  size?: VariantProps<typeof buttonVariants>['size'];
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant, size }), className)}>
      {children}
    </Link>
  );
}

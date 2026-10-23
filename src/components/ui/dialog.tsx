// shadcn/ui Dialog composition with Radix focus management and keyboard support.
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import { Button } from './button'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  returnFocusRef,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children: ReactNode
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content
          className="dialog-content"
          onCloseAutoFocus={(event) => {
            if (returnFocusRef?.current?.isConnected) {
              event.preventDefault()
              returnFocusRef.current.focus()
            }
          }}
        >
          <DialogPrimitive.Title className="text-xl font-semibold">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="muted mt-2 mb-6">
            {description}
          </DialogPrimitive.Description>
          {children}
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              className="dialog-close"
              aria-label="Cerrar"
            >
              <X size={18} />
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

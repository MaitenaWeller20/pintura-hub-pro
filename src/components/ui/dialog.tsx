"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  /** Impide Escape, clic afuera y la X mientras una operación no puede interrumpirse. */
  closeDisabled?: boolean;
  hideClose?: boolean;
};

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(
  (
    {
      className,
      children,
      closeDisabled = false,
      hideClose = false,
      onEscapeKeyDown,
      onPointerDownOutside,
      onInteractOutside,
      ...props
    },
    ref,
  ) => (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          // El alto máximo va acá, en el componente base, y no en cada diálogo: el
          // contenido está centrado con translate-y-[-50%], así que uno más alto
          // que la pantalla se derrama por arriba Y por abajo, y sin límite no hay
          // forma de llegar al footer — el botón de guardar quedaba fuera de la
          // pantalla en monitores bajos.
          // dvh y no vh: en el navegador del celular la barra de direcciones se
          // come parte del vh y el footer volvería a quedar tapado.
          "fixed left-[50%] top-[50%] z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] flex-col border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg",
          className,
        )}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (closeDisabled) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          onPointerDownOutside?.(event);
          if (closeDisabled) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (closeDisabled) event.preventDefault();
        }}
        {...props}
      >
        {/* El que scrollea es este envoltorio, no el diálogo entero: así la X de
          cerrar —que se posiciona contra el diálogo— no se va de la pantalla al
          bajar en un formulario largo. El padding queda afuera para que un
          diálogo que lo pise (className="p-0") siga funcionando igual.
          min-h-0 porque un hijo flex no encoge por debajo de su contenido sin eso,
          y sin encoger no aparece el scroll.
          grid-cols-[minmax(0,1fr)] por lo mismo pero a lo ancho: una columna de
          grid tiene min-width:auto, así que un hijo ancho (una tabla) estira el
          diálogo en vez de encogerse. En el celular eso cortaba el título y los
          nombres de los productos. */}
        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-4 overflow-y-auto">
          {children}
        </div>
        {hideClose ? null : (
          <DialogPrimitive.Close
            disabled={closeDisabled}
            className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-sm opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-30 data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Cerrar</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  ),
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      // sticky: el footer vive DENTRO del envoltorio que scrollea, así que en una
      // pantalla baja se iba abajo de todo y los botones quedaban cortados por el
      // borde del diálogo — se veía un "Crear remito" partido al medio y había que
      // adivinar que se llegaba scrolleando. Pegado al fondo está siempre a mano.
      // El bg tapa el contenido que pasa por atrás; el pt-3 evita que el texto
      // quede besando el borde del botón.
      "sticky bottom-0 z-10 flex flex-col-reverse bg-background pt-3 sm:flex-row sm:justify-end sm:space-x-2",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};

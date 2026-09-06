"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "~/lib/utils";

function Slider({ className, ...props }: SliderPrimitive.Root.Props) {
  return (
    <SliderPrimitive.Root
      className={cn(
        "group/slider relative flex w-full touch-none select-none items-center data-[disabled]:opacity-50",
        className,
      )}
      data-slot="slider"
      {...props}
    />
  );
}

function SliderControl({ className, ...props }: SliderPrimitive.Control.Props) {
  return (
    <SliderPrimitive.Control
      className={cn(
        "relative flex h-10 w-full cursor-grab items-center data-[dragging]:cursor-grabbing data-[disabled]:cursor-not-allowed group-data-[slider-snapping]/slider:pointer-events-none",
        className,
      )}
      data-slot="slider-control"
      {...props}
    />
  );
}

function SliderTrack({ className, ...props }: SliderPrimitive.Track.Props) {
  return (
    <SliderPrimitive.Track
      className={cn(
        "relative h-8 w-full overflow-hidden rounded-full bg-muted/80 shadow-inner transition-[background-color,box-shadow,transform] duration-200 ease-out motion-reduce:transition-none group-hover/slider:bg-muted group-hover/slider:scale-y-105 group-focus-within/slider:ring-2 group-focus-within/slider:ring-blue-400/30",
        className,
      )}
      data-slot="slider-track"
      {...props}
    />
  );
}

function SliderIndicator({ className, ...props }: SliderPrimitive.Indicator.Props) {
  return (
    <SliderPrimitive.Indicator
      className={cn(
        "relative rounded-full bg-blue-500 transition-[background-color] duration-200 ease-out motion-reduce:transition-none data-[dragging]:transition-none group-data-[slider-snapping]/slider:transition-[width,background-color] group-data-[slider-snapping]/slider:duration-[240ms] group-data-[slider-snapping]/slider:ease-[cubic-bezier(0.22,1,0.36,1)]",
        className,
      )}
      data-slot="slider-indicator"
      {...props}
    />
  );
}

function SliderThumb({ className, ...props }: SliderPrimitive.Thumb.Props) {
  return (
    <SliderPrimitive.Thumb
      className={cn(
        "relative z-10 size-9 cursor-grab rounded-full border border-white/70 bg-white shadow-[0_3px_12px_rgb(0_0_0/0.2)] outline-none transition-[transform,box-shadow,scale] duration-200 ease-out motion-reduce:transition-none hover:scale-105 hover:shadow-[0_4px_18px_rgb(59_130_246/0.32)] focus-visible:scale-102 focus-visible:ring-2 focus-visible:ring-blue-400/70 data-[dragging]:scale-105 data-[dragging]:cursor-grabbing data-[dragging]:shadow-[0_4px_18px_rgb(59_130_246/0.32)] [&_input]:cursor-grab [&_input:active]:cursor-grabbing",
        className,
      )}
      data-slot="slider-thumb"
      {...props}
    />
  );
}

export { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack };

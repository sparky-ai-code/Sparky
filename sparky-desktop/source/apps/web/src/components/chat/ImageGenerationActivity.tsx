export function ImageGenerationActivity() {
  return (
    <div
      className="mt-2 overflow-hidden rounded-lg border border-border/60 bg-muted/25"
      role="status"
      aria-live="polite"
    >
      <div className="relative h-24 w-full overflow-hidden">
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted/50 via-background/70 to-muted/40" />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-full border border-border/60 bg-background/75 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
            Generating image…
          </span>
        </div>
      </div>
    </div>
  );
}

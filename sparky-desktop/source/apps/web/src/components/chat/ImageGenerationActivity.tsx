export function ImageGenerationActivity() {
  return (
    <div
      className="mt-2 rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      Generating image…
    </div>
  );
}

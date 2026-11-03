import { ImageGeneration } from "img-fx";

const GENERATION_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 96'%3E%3Crect width='320' height='96' fill='%23d1d5db'/%3E%3C/svg%3E";

export function ImageGenerationActivity() {
  return (
    <div
      className="mt-2 overflow-hidden rounded-lg border border-border/60 bg-muted/25"
      role="status"
      aria-live="polite"
    >
      <ImageGeneration preset="sweep-gradient" autoReveal images={[GENERATION_PLACEHOLDER]}>
        <div className="relative h-24 w-full">
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-muted/50 via-background/70 to-muted/40">
            <span className="rounded-full border border-border/60 bg-background/75 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
              Generating image…
            </span>
          </div>
        </div>
      </ImageGeneration>
    </div>
  );
}

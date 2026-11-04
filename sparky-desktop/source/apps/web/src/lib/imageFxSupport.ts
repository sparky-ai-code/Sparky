export function shouldUseImageFx(): boolean {
  if (typeof window === "undefined") return false;
  if (/^Win/i.test(window.navigator.platform)) return false;
  return (
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

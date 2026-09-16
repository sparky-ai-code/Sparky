import { SparkyLogo } from "./SparkyLogo";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex size-24 items-center justify-center" aria-label="Sparky splash screen">
        <SparkyLogo role="img" aria-label="Sparky" className="size-16 text-foreground" />
      </div>
    </div>
  );
}

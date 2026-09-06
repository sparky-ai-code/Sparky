export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex size-24 items-center justify-center" aria-label="Sparky splash screen">
        <img alt="Sparky" className="size-16 object-contain" src="/sparky-logo-small.svg?v=real-sparky-1" />
      </div>
    </div>
  );
}

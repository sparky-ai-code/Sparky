// Account onboarding now happens entirely in the Clerk sign-in gate. Keeping
// this component as a no-op avoids scattering conditional onboarding state
// through the rest of the app while preserving the existing root composition.
export function OnboardingGate() {
  return null;
}

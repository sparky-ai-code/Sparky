import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@sparky/marketing'",
  buildCommand: "vp run --filter @sparky/marketing build",
  outputDirectory: "dist",
};

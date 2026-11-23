import { useId, type SVGProps } from "react";

// The mask renders at most ~80px, so a 256px copy of the approved artwork is
// enough (3x density) and keeps ~170KB of base64 out of the main JS bundle.
import logoUrl from "../assets/sparky-logo-mask-256.png?inline";

/** Use the approved artwork's alpha, so the mark follows the surrounding text color. */
export function SparkyLogo(props: SVGProps<SVGSVGElement>) {
  const maskId = `sparky-logo-${useId().replaceAll(":", "")}`;

  return (
    <svg {...props} viewBox="0 0 1024 1024" fill="none">
      <defs>
        <mask id={maskId} style={{ maskType: "alpha" }}>
          <image href={logoUrl} width="1024" height="1024" />
        </mask>
      </defs>
      <rect width="1024" height="1024" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}

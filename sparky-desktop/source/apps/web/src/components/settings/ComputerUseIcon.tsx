import type { SVGProps } from "react";

export function ComputerUseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect x="3" y="4" width="18" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="m10 8 4.6 4.1-2.2.35-.95 2.05L10 8Z" fill="currentColor" />
    </svg>
  );
}

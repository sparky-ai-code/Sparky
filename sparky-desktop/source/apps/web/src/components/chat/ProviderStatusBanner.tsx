import { type ServerProvider } from "@sparky/contracts";
import { memo } from "react";
import { InfoIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const isDemoRenderer = () => {
  if (typeof window === "undefined") return false;

  if (window.location.hostname === "127.0.0.1" && window.location.port === "13823") {
    return true;
  }

  const demoRequested = new URLSearchParams(window.location.search).get("demo") === "1";
  if (demoRequested) {
    window.sessionStorage.setItem("sparky-demo-renderer", "1");
  }
  return demoRequested || window.sessionStorage.getItem("sparky-demo-renderer") === "1";
};

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  if (isDemoRenderer() || !status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const title = isUnauthenticated
    ? `${providerName} is unauthenticated`
    : `${providerName} provider status`;
  const message = isUnauthenticated
    ? "Sign in via the CLI to authenticate again."
    : (status.message ??
      (status.status === "error"
        ? `${providerName} provider is unavailable.`
        : `${providerName} provider has limited availability.`));

  return (
    <div className="mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <Alert className="gap-3" variant={status.status === "warning" ? "warning" : "error"}>
        <InfoIcon className="size-4 shrink-0" aria-hidden />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3 text-muted-foreground" />}>
              {message}
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
      </Alert>
    </div>
  );
});

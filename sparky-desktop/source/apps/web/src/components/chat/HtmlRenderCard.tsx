import { Maximize2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2000;

function readPayload(value: unknown): { html: string; title: string; height: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const outer = value as Record<string, unknown>;
  const data = (typeof outer.item === "object" && outer.item !== null
    ? outer.item
    : outer) as Record<string, unknown>;
  const argumentsValue = data.arguments ?? data.input ?? data.rawInput;
  const payload = (typeof argumentsValue === "object" && argumentsValue !== null
    ? argumentsValue
    : data) as Record<string, unknown>;
  if (typeof payload.html !== "string" || typeof payload.title !== "string") return null;
  const height =
    typeof payload.height === "number" && Number.isFinite(payload.height)
      ? Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(payload.height)))
      : 480;
  return { html: payload.html, title: payload.title, height };
}

const THEME_VARIABLES = [
  "background", "foreground", "muted", "muted-foreground", "card", "card-foreground",
  "popover", "popover-foreground", "secondary", "secondary-foreground", "border", "input",
  "ring", "primary", "primary-foreground", "accent", "accent-foreground", "destructive",
  "destructive-foreground", "warning", "success", "info", "code-background", "code-foreground",
  "chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6", "radius", "font-sans", "font-mono",
] as const;

function themedDocument(html: string, appearance: "light" | "dark", variables: Readonly<Record<string, string>>) {
  const declarations = Object.entries(variables)
    .map(([name, value]) => `--${name}:${value.replace(/[;{}<>]/g, "")};`)
    .join("");
  const bootstrap = `<style id="sparky-visual-theme">:root{color-scheme:${appearance};${declarations}}html{box-sizing:border-box;padding:8px;background:transparent;color:var(--foreground);font:14px/1.5 var(--font-sans,system-ui,sans-serif);-webkit-font-smoothing:antialiased}*,*::before,*::after{box-sizing:inherit}body{margin:0}code,pre{font-family:var(--font-mono,ui-monospace,monospace)}</style>`;
  const resizeScript = `<script>(function(){var send=function(){var d=document.documentElement,h=Math.ceil(Math.max(d.scrollHeight,d.getBoundingClientRect().height));if(h>0&&window.parent!==window)window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:h}},"*")};if(window.ResizeObserver){var o=new ResizeObserver(send);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);send()})}window.addEventListener("load",send)})();</script>`;
  const markup = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data: blob:; script-src 'unsafe-inline' 'unsafe-eval'; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'">${bootstrap}${resizeScript}`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${markup}`);
  if (/<html(?:\s[^>]*)?>/i.test(html)) return html.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${markup}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${markup}</head><body>${html}</body></html>`;
}

function readThemeVariables(): Readonly<Record<string, string>> {
  if (typeof document === "undefined") return {};
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    THEME_VARIABLES.flatMap((name) => {
      const value = styles.getPropertyValue(`--${name}`).trim();
      return value ? [[name, value]] : [];
    }),
  );
}

export function HtmlRenderCard(props: { toolData: unknown; appearance: "light" | "dark" }) {
  const payload = readPayload(props.toolData);
  const [expanded, setExpanded] = useState(false);
  const themeVariables = useMemo(readThemeVariables, [props.appearance]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState<number>();
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (typeof event.data !== "object" || event.data === null) return;
      const message = event.data as { jsonrpc?: unknown; method?: unknown; params?: unknown };
      if (message.jsonrpc !== "2.0" || message.method !== "ui/notifications/size-changed") return;
      if (typeof message.params !== "object" || message.params === null) return;
      const height = (message.params as { height?: unknown }).height;
      if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return;
      setContentHeight(Math.min(20_000, Math.max(MIN_HEIGHT, Math.ceil(height))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);
  const srcDoc = useMemo(
    () => (payload ? themedDocument(payload.html, props.appearance, themeVariables) : ""),
    [payload, props.appearance, themeVariables],
  );
  if (!payload) return null;

  const frame = (expanded: boolean) => (
    <iframe
      title={payload.title}
      srcDoc={srcDoc}
      ref={expanded ? undefined : frameRef}
      sandbox="allow-scripts allow-forms allow-popups"
      referrerPolicy="no-referrer"
      className="block w-full border-0 bg-transparent"
      style={{ height: expanded ? "100%" : (contentHeight ?? payload.height) }}
    />
  );

  return (
    <section className="group relative mt-2 min-w-0" aria-label={payload.title}>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label="Open visual reply full screen"
        className="absolute right-2 top-2 z-10 rounded-md bg-background/80 p-1.5 text-muted-foreground shadow backdrop-blur-sm transition-opacity hover:bg-accent/80 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Maximize2Icon className="size-3.5" />
      </button>
      {frame(false)}
      {expanded ? (
        <div className="fixed inset-0 z-[100] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label={payload.title}>
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
            <span className="truncate text-sm font-medium">{payload.title}</span>
            <button type="button" onClick={() => setExpanded(false)} aria-label="Close full screen visual reply" className="rounded p-2 text-muted-foreground hover:bg-accent/30">
              <XIcon className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1">{frame(true)}</div>
        </div>
      ) : null}
    </section>
  );
}

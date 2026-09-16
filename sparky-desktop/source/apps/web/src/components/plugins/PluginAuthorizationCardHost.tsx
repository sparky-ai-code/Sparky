import { CheckCircle2Icon, LoaderCircleIcon, MessageCircleIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { PluginLogo } from "./PluginLogo";
import {
  cancelPluginAuthorization,
  connectPlugin,
  listPendingPluginAuthorizations,
  loadPluginSessionToken,
  type PendingPluginAuthorization,
} from "./pluginApi";
import { getPluginById, type PluginId } from "./pluginCatalog";

const ACTIVE_POLL_INTERVAL_MS = 1_000;
const IDLE_POLL_INTERVAL_MS = 5_000;
const HIDDEN_POLL_INTERVAL_MS = 30_000;

function focusChatComposer(): void {
  const form = document.querySelector<HTMLElement>('[data-chat-composer-form="true"]');
  const editor = form?.querySelector<HTMLElement>('[contenteditable="true"]') ?? null;
  editor?.focus();
  editor?.scrollIntoView({ block: "nearest" });
}

export function PluginAuthorizationCardHost() {
  const [pending, setPending] = useState<PendingPluginAuthorization[]>([]);
  const pendingCountRef = useRef(0);
  const [busyPluginId, setBusyPluginId] = useState<PluginId | null>(null);
  const [completedPluginId, setCompletedPluginId] = useState<PluginId | null>(null);
  const [cancelledPluginId, setCancelledPluginId] = useState<PluginId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const sessionToken = loadPluginSessionToken();
    if (!sessionToken) {
      pendingCountRef.current = 0;
      setPending([]);
      return;
    }
    try {
      const nextPending = await listPendingPluginAuthorizations(sessionToken);
      pendingCountRef.current = nextPending.length;
      setPending(nextPending);
    } catch {
      // This host is supplemental UI. A temporary worker outage should not
      // create a repeating toast or interfere with the active conversation.
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timeout: number | null = null;
    let running = false;

    const schedule = () => {
      if (stopped) return;
      const delay =
        document.visibilityState !== "visible"
          ? HIDDEN_POLL_INTERVAL_MS
          : pendingCountRef.current > 0
            ? ACTIVE_POLL_INTERVAL_MS
            : IDLE_POLL_INTERVAL_MS;
      timeout = window.setTimeout(() => void tick(), delay);
    };

    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        await refresh();
      } finally {
        running = false;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (timeout !== null) {
        window.clearTimeout(timeout);
        timeout = null;
      }
      void tick();
    };

    void tick();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [refresh]);

  const connect = useCallback(
    async (pluginId: PluginId) => {
      const sessionToken = loadPluginSessionToken();
      if (!sessionToken || busyPluginId) return;
      setBusyPluginId(pluginId);
      setCancelledPluginId(null);
      setError(null);
      try {
        await connectPlugin(sessionToken, pluginId);
        setCompletedPluginId(pluginId);
        await refresh();
        window.setTimeout(() => setCompletedPluginId(null), 1_500);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Authorization failed.");
      } finally {
        setBusyPluginId(null);
      }
    },
    [busyPluginId, refresh],
  );

  const cancel = useCallback(
    async (pluginId: PluginId) => {
      const sessionToken = loadPluginSessionToken();
      if (!sessionToken || busyPluginId) return;
      setBusyPluginId(pluginId);
      setError(null);
      try {
        await cancelPluginAuthorization(sessionToken, pluginId);
        setPending((current) => {
          const next = current.filter((entry) => entry.pluginId !== pluginId);
          pendingCountRef.current = next.length;
          return next;
        });
        setCompletedPluginId(null);
        setCancelledPluginId(pluginId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not cancel authorization.");
      } finally {
        setBusyPluginId(null);
      }
    },
    [busyPluginId],
  );

  const request = pending[0] ?? null;
  const plugin = request ? getPluginById(request.pluginId) : null;
  const completedPlugin = completedPluginId ? getPluginById(completedPluginId) : null;
  const cancelledPlugin = cancelledPluginId ? getPluginById(cancelledPluginId) : null;

  if (!plugin && !completedPlugin && !cancelledPlugin) return null;

  if (!plugin && completedPlugin) {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[120] flex justify-center px-4">
        <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-popover/78 px-4 py-3 text-sm text-popover-foreground shadow-2xl backdrop-blur-3xl">
          <CheckCircle2Icon className="size-4 text-emerald-500" />
          <PluginLogo pluginId={completedPlugin.id} className="size-5" />
          <span>{completedPlugin.name} connected</span>
        </div>
      </div>
    );
  }

  if (!plugin && cancelledPlugin) {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[120] flex justify-center px-4">
        <section className="pointer-events-auto w-full max-w-[430px] rounded-2xl border border-black/10 bg-white/66 p-3 text-neutral-950 shadow-[0_20px_64px_rgba(0,0,0,0.16)] backdrop-blur-3xl dark:border-white/12 dark:bg-neutral-950/58 dark:text-neutral-50 dark:shadow-[0_24px_80px_rgba(0,0,0,0.5)]">
          <div className="flex items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-black/8 bg-white/55 dark:border-white/10 dark:bg-white/[0.055]">
              <PluginLogo pluginId={cancelledPlugin.id} className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {cancelledPlugin.name} authorization cancelled
              </p>
              <p className="mt-0.5 text-sm font-semibold">Tell Sparky what to do</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setCancelledPluginId(null);
                window.requestAnimationFrame(focusChatComposer);
              }}
            >
              <MessageCircleIcon className="size-3.5" />
              Continue
            </Button>
          </div>
        </section>
      </div>
    );
  }

  if (!plugin || !request) return null;
  const busy = busyPluginId === plugin.id;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[120] flex justify-center px-4">
      <section
        aria-label={`${plugin.name} authorization requested`}
        className="pointer-events-auto w-full max-w-[430px] overflow-hidden rounded-2xl border border-black/10 bg-white/68 text-neutral-950 shadow-[0_22px_70px_rgba(0,0,0,0.18)] backdrop-blur-3xl dark:border-white/12 dark:bg-neutral-950/60 dark:text-neutral-50 dark:shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      >
        <div className="flex items-start gap-3 px-4 pb-3 pt-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-black/8 bg-white/55 dark:border-white/10 dark:bg-white/[0.055]">
            <PluginLogo pluginId={plugin.id} className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Sparky wants to authorize {plugin.name}</p>
            <p className="mt-1 text-xs leading-5 text-neutral-600 dark:text-neutral-400">
              Sparky requested access to {plugin.name} for the task you asked it to perform. You can
              cancel and the conversation will continue normally.
            </p>
          </div>
        </div>
        {error ? (
          <p className="mx-4 mb-3 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2 border-t border-black/8 bg-black/[0.015] px-4 py-3 dark:border-white/8 dark:bg-white/[0.02]">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void cancel(plugin.id)}
          >
            <XIcon className="size-3.5" />
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void connect(plugin.id)}
          >
            {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
            {busy ? "Authorizing…" : "Authorize"}
          </Button>
        </div>
      </section>
    </div>
  );
}

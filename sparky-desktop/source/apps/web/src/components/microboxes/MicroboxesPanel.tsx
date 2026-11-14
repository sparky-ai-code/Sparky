import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import { Monitor, Settings2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ScopedThreadRef, MicroboxSnapshot } from "@sparky/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { microboxesEnvironment } from "../../state/microboxes";
import { useRightPanelStore } from "../../rightPanelStore";

interface Props {
  enabled: boolean;
  internetAllowed: boolean;
  boxId: string | null;
  threadRef: ScopedThreadRef;
}

export function MicroboxesPanel({ enabled, internetAllowed, boxId, threadRef }: Props) {
  const environmentId = threadRef.environmentId;
  const threadId = threadRef.threadId;
  const images = useEnvironmentQuery(
    microboxesEnvironment.images({ environmentId, input: {} }),
  );
  const boxes = useEnvironmentQuery(
    microboxesEnvironment.list({ environmentId, input: { threadId } }),
  );
  const takeSnapshot = useAtomCommand(microboxesEnvironment.snapshot, { reportFailure: false });
  const clickBox = useAtomCommand(microboxesEnvironment.click, { reportFailure: false });
  const dragBox = useAtomCommand(microboxesEnvironment.drag, { reportFailure: false });
  const scrollBox = useAtomCommand(microboxesEnvironment.scroll, { reportFailure: false });
  const typeBox = useAtomCommand(microboxesEnvironment.type, { reportFailure: false });
  const pressBox = useAtomCommand(microboxesEnvironment.press, { reportFailure: false });

  const [screen, setScreen] = useState<MicroboxSnapshot | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const pending = useRef(false);
  const screenRef = useRef<HTMLImageElement | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const selectedBox = boxes.data?.find((box) => box.boxId === boxId);
  const running = selectedBox?.state === "running";
  const booting = selectedBox?.state === "starting";
  const showingScreen = running || booting;
  const acceptsInput = showingScreen; // Input is valid during startup, before the desktop-ready marker.

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      boxes.refresh();
      images.refresh();
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [enabled, boxes.refresh, images.refresh]);

  const refreshScreen = useCallback(async () => {
    if (!enabled || !boxId || pending.current) return;
    pending.current = true;
    try {
      const result = await takeSnapshot({
        environmentId, input: { threadId, boxId },
      });
      if (result._tag === "Success") {
        setScreen(result.value);
        setScreenError(null);
      } else {
        setScreenError("Unable to capture the graphical desktop.");
      }
    } finally {
      pending.current = false;
    }
  }, [enabled, boxId, environmentId, threadId, takeSnapshot]);

  useEffect(() => {
    setScreen(null);
    setScreenError(null);
    if (!showingScreen) return;
    void refreshScreen();
    const timer = window.setInterval(() => void refreshScreen(), 1_000);
    return () => window.clearInterval(timer);
  }, [showingScreen, refreshScreen]);

  const imagePoint = (element: HTMLImageElement, clientX: number, clientY: number) => {
    if (!screen) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(screen.width - 1, Math.max(0, Math.floor((clientX - rect.left) * screen.width / rect.width))),
      y: Math.min(screen.height - 1, Math.max(0, Math.floor((clientY - rect.top) * screen.height / rect.height))),
    };
  };

  const reportInput = (op: Promise<{ readonly _tag: string }>) => {
    void op.then((result) => {
      if (result._tag !== "Success") setScreenError("The guest did not accept that input.");
    }).catch(() => setScreenError("The guest did not accept that input."));
  };
  const onPointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (!acceptsInput || !boxId || event.button !== 0) return;
    pointerStart.current = imagePoint(event.currentTarget, event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
  };
  const onPointerUp = (event: PointerEvent<HTMLImageElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!acceptsInput || !boxId || !start) return;
    const end = imagePoint(event.currentTarget, event.clientX, event.clientY);
    if (!end) return;
    if (Math.hypot(end.x - start.x, end.y - start.y) > 6) {
      reportInput(dragBox({
        environmentId,
        input: { threadId, boxId, fromX: start.x, fromY: start.y, toX: end.x, toY: end.y },
      }));
    } else {
      reportInput(clickBox({
        environmentId, input: { threadId, boxId, x: end.x, y: end.y, button: "left" },
      }));
    }
  };
  const onContextMenu = (event: MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    if (!acceptsInput || !boxId) return;
    const end = imagePoint(event.currentTarget, event.clientX, event.clientY);
    if (!end) return;
    reportInput(clickBox({ environmentId, input: { threadId, boxId, ...end, button: "right" } }));
  };

  const onScreenWheel = (event: WheelEvent<HTMLImageElement>) => {
    if (!acceptsInput || !boxId || event.deltaY === 0) return;
    const direction = event.deltaY < 0 ? "up" : "down";
    const steps = Math.min(16, Math.max(1, Math.round(Math.abs(event.deltaY) / 100)));
    reportInput(scrollBox({ environmentId, input: { threadId, boxId, direction, steps } }));
  };

  const onScreenKey = (event: KeyboardEvent<HTMLImageElement>) => {
    if (!acceptsInput || !boxId || event.repeat) return;
    let key: string | null = null;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      const modifiers = [
        ...(event.ctrlKey ? ["Ctrl"] : []),
        ...(event.altKey ? ["Alt"] : []),
        ...(event.metaKey ? ["Meta"] : []),
        ...(event.shiftKey ? ["Shift"] : []),
      ];
      key = [...modifiers, event.key].join("+");
    } else if (event.key.length === 1) {
      event.preventDefault();
      reportInput(typeBox({ environmentId, input: { threadId, boxId, text: event.key } }));
      return;
    } else if (["Enter", "Escape", "Backspace", "Tab", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      key = event.key;
    }
    if (key) {
      event.preventDefault();
      reportInput(pressBox({ environmentId, input: { threadId, boxId, key } }));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Monitor className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{selectedBox?.name || "Sparky Microboxes"}</span>
          {selectedBox ? <span className="text-muted-foreground">· {selectedBox.state}</span> : null}
          {selectedBox ? <span className="truncate text-[10px] text-muted-foreground" title={selectedBox.imageId}>
            · image {selectedBox.imageId.slice(-12)}
          </span> : null}
        </div>
        <div className="flex items-center gap-2">
          <Link to="/settings/microboxes" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <Settings2 className="size-3.5" /> Settings
          </Link>
        </div>
      </div>

      {enabled && boxId && showingScreen ? (
        <div className="flex min-h-0 flex-1 flex-col bg-black">
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
            {screen ? (
              <img
                ref={screenRef}
                src={`data:image/png;base64,${screen.data}`}
                alt="Live graphical desktop inside Sparky Microbox"
                role="button"
                tabIndex={0}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerCancel={() => { pointerStart.current = null; }}
                onContextMenu={onContextMenu}
                onWheel={onScreenWheel}
                onKeyDown={onScreenKey}
                draggable={false}
                className="max-h-full max-w-full cursor-crosshair object-contain outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
            ) : <span className="text-xs text-white/60">Connecting to the box display…</span>}
          </div>
          <p className="shrink-0 border-t border-white/10 px-3 py-1.5 text-center text-[11px] text-white/60">
            Click the display to focus it. Keyboard and mouse input also work while the guest starts.
          </p>
          {selectedBox?.bootMessage ? (
            <p role="status" className="px-3 py-2 text-center text-xs text-amber-200">
              {selectedBox.bootMessage}
            </p>
          ) : null}
          {screenError ? <p role="status" className="px-3 py-1 text-center text-xs text-yellow-300">{screenError}</p> : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
          {!enabled ? (
            <div className="mx-auto max-w-sm space-y-2 py-8 text-center">
              <Monitor className="mx-auto size-7 text-muted-foreground" />
              <p className="text-sm font-medium">Microboxes are off</p>
              <p className="text-xs text-muted-foreground">Enable Microboxes in Settings to let Sparky use an isolated desktop.</p>
            </div>
          ) : (
            <>
              <div className="mx-auto max-w-sm space-y-2 py-5 text-center">
                <Monitor className="mx-auto size-7 text-muted-foreground" />
                <p className="text-sm font-medium">{boxId ? "Box is not running" : "Your boxes"}</p>
                <p className="text-xs text-muted-foreground">
                  Sparky creates and manages boxes when needed. Active boxes appear here automatically.
                </p>
                {!images.data && !images.error ? (
                  <p role="status" className="text-xs text-muted-foreground">Preparing built-in Linux image…</p>
                ) : null}
                {selectedBox?.bootMessage ? <p role="alert" className="text-xs text-destructive">{selectedBox.bootMessage}</p> : null}
              </div>
              {(boxes.data ?? []).length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">This thread</h3>
                  {(boxes.data ?? []).map((box) => (
                    <button
                      key={box.boxId}
                      type="button"
                      onClick={() => useRightPanelStore.getState().openBox(threadRef, box.boxId)}
                      className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left text-xs hover:bg-muted/40"
                    >
                      <span className="truncate">{box.name}</span>
                      <span className="text-muted-foreground">{box.state}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}
          {images.error || boxes.error ? <p role="alert" className="text-xs text-destructive">{images.error || boxes.error}</p> : null}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import { Monitor, Settings2, Plus, Square, Trash2, RefreshCw } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ScopedThreadRef, MicroboxSnapshot } from "@sparky/contracts";
import { Button } from "../ui/button";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { microboxesEnvironment } from "../../state/microboxes";
import { useRightPanelStore } from "../../rightPanelStore";
import { MicroboxesSetupControl } from "./MicroboxesSetupControl";

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
  const createBox = useAtomCommand(microboxesEnvironment.create, { reportFailure: false });
  const takeSnapshot = useAtomCommand(microboxesEnvironment.snapshot, { reportFailure: false });
  const clickBox = useAtomCommand(microboxesEnvironment.click, { reportFailure: false });
  const dragBox = useAtomCommand(microboxesEnvironment.drag, { reportFailure: false });
  const scrollBox = useAtomCommand(microboxesEnvironment.scroll, { reportFailure: false });
  const typeBox = useAtomCommand(microboxesEnvironment.type, { reportFailure: false });
  const pressBox = useAtomCommand(microboxesEnvironment.press, { reportFailure: false });
  const stopBox = useAtomCommand(microboxesEnvironment.stop, { reportFailure: false });
  const destroyBox = useAtomCommand(microboxesEnvironment.destroy, { reportFailure: false });

  const [chosenImageId, setChosenImageId] = useState("");
  const [allowInternet, setAllowInternet] = useState(false);
  const [memoryMiB, setMemoryMiB] = useState(512);
  const [cpus, setCpus] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<MicroboxSnapshot | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const pending = useRef(false);
  const screenRef = useRef<HTMLImageElement | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const selectedImage = chosenImageId || images.data?.[0]?.imageId || "";
  const selectedBox = boxes.data?.find((box) => box.boxId === boxId);
  const running = selectedBox?.state === "running";
  const booting = selectedBox?.state === "starting";
  const showingScreen = running || booting;

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

  const create = async () => {
    if (!enabled || !selectedImage || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createBox({
        environmentId,
        input: {
          threadId, imageId: selectedImage, memoryMiB, cpus,
          ...(allowInternet && internetAllowed ? { internet: true } : {}),
        },
      });
      if (result._tag === "Success") {
        useRightPanelStore.getState().openBox(threadRef, result.value.boxId);
        boxes.refresh();
      } else {
        setError("Couldn't create this box. Check that its image and host components are installed.");
      }
    } catch {
      setError("Couldn't create this box.");
    } finally {
      setBusy(false);
    }
  };

  const endBox = async (destroy: boolean) => {
    if (!boxId || busy) return;
    if (destroy && !window.confirm("Permanently delete this box and its private disk?")) return;
    setBusy(true);
    try {
      const action = destroy ? destroyBox : stopBox;
      const result = await action({ environmentId, input: { threadId, boxId } });
      if (result._tag === "Success") {
        boxes.refresh();
        if (destroy) {
          useRightPanelStore.getState().closeSurface(threadRef, `box:${boxId}`);
        }
      } else {
        setError("Couldn't complete the box action.");
      }
    } finally {
      setBusy(false);
    }
  };

  const imagePoint = (element: HTMLImageElement, clientX: number, clientY: number) => {
    if (!screen) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(screen.width - 1, Math.max(0, Math.floor((clientX - rect.left) * screen.width / rect.width))),
      y: Math.min(screen.height - 1, Math.max(0, Math.floor((clientY - rect.top) * screen.height / rect.height))),
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (!running || !boxId || event.button !== 0) return;
    pointerStart.current = imagePoint(event.currentTarget, event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
  };
  const onPointerUp = (event: PointerEvent<HTMLImageElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!running || !boxId || !start) return;
    const end = imagePoint(event.currentTarget, event.clientX, event.clientY);
    if (!end) return;
    if (Math.hypot(end.x - start.x, end.y - start.y) > 6) {
      void dragBox({
        environmentId,
        input: { threadId, boxId, fromX: start.x, fromY: start.y, toX: end.x, toY: end.y },
      });
    } else {
      void clickBox({
        environmentId, input: { threadId, boxId, x: end.x, y: end.y, button: "left" },
      });
    }
  };
  const onContextMenu = (event: MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    if (!running || !boxId) return;
    const end = imagePoint(event.currentTarget, event.clientX, event.clientY);
    if (!end) return;
    void clickBox({ environmentId, input: { threadId, boxId, ...end, button: "right" } });
  };

  const onScreenWheel = (event: WheelEvent<HTMLImageElement>) => {
    if (!running || !boxId || event.deltaY === 0) return;
    const direction = event.deltaY < 0 ? "up" : "down";
    const steps = Math.min(16, Math.max(1, Math.round(Math.abs(event.deltaY) / 100)));
    void scrollBox({ environmentId, input: { threadId, boxId, direction, steps } });
  };

  const onScreenKey = (event: KeyboardEvent<HTMLImageElement>) => {
    if (!running || !boxId || event.repeat) return;
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
      void typeBox({ environmentId, input: { threadId, boxId, text: event.key } });
      return;
    } else if (["Enter", "Escape", "Backspace", "Tab", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      key = event.key;
    }
    if (key) {
      event.preventDefault();
      void pressBox({ environmentId, input: { threadId, boxId, key } });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Monitor className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{selectedBox?.name || "Sparky Microboxes"}</span>
          {selectedBox ? <span className="text-muted-foreground">· {selectedBox.state}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {boxId ? (
            <>
              <Button size="icon-xs" variant="ghost" onClick={() => void refreshScreen()} aria-label="Refresh VM screen" disabled={!showingScreen}>
                <RefreshCw className="size-3.5" />
              </Button>
              <Button size="icon-xs" variant="ghost" onClick={() => void endBox(false)} aria-label="Stop box" disabled={busy || !selectedBox || selectedBox.state === "stopped" || selectedBox.state === "stopping"}>
                <Square className="size-3.5" />
              </Button>
              <Button size="icon-xs" variant="ghost" onClick={() => void endBox(true)} aria-label="Destroy box" disabled={busy}>
                <Trash2 className="size-3.5" />
              </Button>
            </>
          ) : null}
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
            Click the display to focus it, then use your keyboard.
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
            <p className="text-sm text-muted-foreground">Enable Sparky Microboxes in settings before starting a box.</p>
          ) : (
            <>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">{boxId && selectedBox?.state === "error" ? "Box could not boot" : boxId ? "Box is not running" : "Create a graphical box"}</h3>
                {selectedBox?.bootMessage ? (
                  <p role="alert" className="text-xs text-destructive">{selectedBox.bootMessage}</p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Choose a previously installed guest image. Your agent can also create and control boxes when this feature is enabled.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium" htmlFor="microboxes-image">Guest image</label>
                <select
                  id="microboxes-image"
                  value={selectedImage}
                  onChange={(event) => setChosenImageId(event.target.value)}
                  className="w-full rounded-md border border-border bg-background p-2 text-xs"
                  disabled={!images.data?.length}
                >
                  {(images.data ?? []).map((image) => (
                    <option key={image.imageId} value={image.imageId}>{image.name} · {image.architecture}</option>
                  ))}
                </select>
                {!images.data?.length ? <p className="text-xs text-muted-foreground">No guest images installed. Use Settings → Microboxes to prepare an image.</p> : null}
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-xs font-medium">
                    Memory
                    <select
                      value={memoryMiB}
                      onChange={(event) => setMemoryMiB(Number(event.target.value))}
                      className="w-full rounded-md border border-border bg-background p-2 text-xs"
                    >
                      <option value={512}>512 MiB</option>
                      <option value={1024}>1 GiB</option>
                      <option value={2048}>2 GiB</option>
                      <option value={4096}>4 GiB</option>
                      <option value={8192}>8 GiB</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium">
                    CPU cores
                    <select
                      value={cpus}
                      onChange={(event) => setCpus(Number(event.target.value))}
                      className="w-full rounded-md border border-border bg-background p-2 text-xs"
                    >
                      <option value={1}>1 core</option>
                      <option value={2}>2 cores</option>
                      <option value={4}>4 cores</option>
                    </select>
                  </label>
                </div>
                {internetAllowed ? (
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={allowInternet} onChange={(event) => setAllowInternet(event.target.checked)} />
                    Enable guest internet access
                  </label>
                ) : null}
                <Button size="sm" disabled={!selectedImage || busy} onClick={() => void create()}>
                  <Plus className="size-3.5" /> {busy ? "Starting box…" : "Create box"}
                </Button>
              </div>
              <div className="space-y-2">
                <h3 className="text-xs font-semibold">Boxes in this thread</h3>
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
              <MicroboxesSetupControl enabled />
            </>
          )}
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          {images.error || boxes.error ? <p role="alert" className="text-xs text-destructive">{images.error || boxes.error}</p> : null}
        </div>
      )}
    </div>
  );
}

import { scopeProjectRef } from "@sparky/client-runtime/environment";
import {
  runAtomCommand,
  squashAtomCommandFailure,
} from "@sparky/client-runtime/state/runtime";
import type { EnvironmentProject } from "@sparky/client-runtime/state/shell";
import type { ContextMenuItem, LocalApi } from "@sparky/contracts";

import { archiveProject } from "./archivedProjectsState";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";
import { useComposerDraftStore } from "./composerDraftStore";
import { showContextMenuFallback } from "./contextMenuFallback";
import { derivePhysicalProjectKey } from "./logicalProject";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";
import { environmentProjects, projectEnvironment } from "./state/projects";

let cachedApi: LocalApi | undefined;

function unavailableLocalBackendError(): Error {
  return new Error("Local backend API is unavailable before a backend is paired.");
}

function projectRemovalPhysicalKeyFromSelection<T extends string>(
  items: readonly ContextMenuItem<T>[],
  clicked: T | null,
): string | null {
  if (clicked === null || !clicked.startsWith("delete:")) return null;

  const removeMenuItem = items.find((item) => {
    if (item.label !== "Remove") return false;
    if (item.id === clicked) return true;
    return item.children?.some((child) => child.id === clicked) ?? false;
  });
  if (!removeMenuItem) return null;

  const physicalProjectKey = clicked.slice("delete:".length);
  return physicalProjectKey.length > 0 && physicalProjectKey !== "submenu"
    ? physicalProjectKey
    : null;
}

function findProjectByPhysicalKey(physicalProjectKey: string): EnvironmentProject | null {
  const projects = appAtomRegistry.get(environmentProjects.projectsAtom);
  return (
    projects.find((project) => derivePhysicalProjectKey(project) === physicalProjectKey) ?? null
  );
}

async function removeProjectFromSparky(project: EnvironmentProject): Promise<string | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.delete,
    {
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        force: true,
      },
    },
    {
      label: "project removal",
      reportFailure: false,
    },
  );

  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    return error instanceof Error ? error.message : "Unknown error removing project.";
  }

  const projectRef = scopeProjectRef(project.environmentId, project.id);
  const draftStore = useComposerDraftStore.getState();
  const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
  if (projectDraftThread) {
    draftStore.clearDraftThread(projectDraftThread.draftId);
  }
  draftStore.clearProjectDraftThreadId(projectRef);
  return null;
}

function createProjectRemovalButton(input: {
  readonly title: string;
  readonly destructive?: boolean;
  readonly onClick: () => void;
}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = [
    "inline-flex min-h-9 cursor-pointer items-center justify-center rounded-md border border-border bg-transparent px-3 py-1.5 text-sm font-medium",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55",
    "hover:bg-accent",
  ].join(" ");

  const title = document.createElement("span");
  title.className = input.destructive ? "text-destructive" : "text-foreground";
  title.dataset.projectRemovalLabel = "true";
  title.textContent = input.title;
  button.append(title);
  button.addEventListener("click", input.onClick);
  return button;
}

async function showProjectRemovalDialog(project: EnvironmentProject): Promise<void> {
  if (typeof document === "undefined") return;

  return new Promise<void>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-[3px]";
    overlay.setAttribute("role", "presentation");

    const dialog = document.createElement("div");
    dialog.className =
      "w-full max-w-[480px] rounded-2xl border border-border/80 bg-popover p-5 text-popover-foreground shadow-2xl";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "sparky-project-removal-title");

    let archiveButton: HTMLButtonElement;
    let removeButton: HTMLButtonElement;
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className =
      "inline-flex cursor-pointer items-center gap-2 rounded-md text-sm font-medium text-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55";
    const cancelIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    cancelIcon.setAttribute("viewBox", "0 0 24 24");
    cancelIcon.setAttribute("fill", "none");
    cancelIcon.setAttribute("stroke", "currentColor");
    cancelIcon.setAttribute("stroke-width", "2");
    cancelIcon.setAttribute("stroke-linecap", "round");
    cancelIcon.setAttribute("stroke-linejoin", "round");
    cancelIcon.setAttribute("aria-hidden", "true");
    cancelIcon.classList.add("size-4");
    const cancelPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    cancelPath.setAttribute("d", "m15 18-6-6 6-6");
    cancelIcon.append(cancelPath);
    cancelButton.append(cancelIcon, document.createTextNode("Cancel"));

    const header = document.createElement("div");
    header.className = "space-y-3";
    const headerTop = document.createElement("div");
    headerTop.className = "flex items-center justify-between";
    headerTop.append(cancelButton);
    const title = document.createElement("h2");
    title.id = "sparky-project-removal-title";
    title.className = "text-xl font-semibold tracking-[-0.02em] text-foreground";
    title.textContent = "Remove this project?";
    const description = document.createElement("p");
    description.className = "max-w-[42ch] text-sm leading-5 text-foreground/65";
    description.textContent =
      "Remove the project and its Sparky conversations, or archive it to hide it for now. Your project folder stays on disk.";
    header.append(headerTop, title, description);

    const path = document.createElement("div");
    path.className =
      "mt-5 overflow-hidden rounded-lg border border-border/60 bg-muted/30 px-3 py-2 font-mono text-[11px] text-foreground/55";
    path.textContent = project.workspaceRoot;
    path.title = project.workspaceRoot;

    const actions = document.createElement("div");
    actions.className = "mt-7 flex items-center justify-end gap-2";

    const errorMessage = document.createElement("div");
    errorMessage.className =
      "mt-3 hidden rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs leading-5 text-destructive";

    let settled = false;
    let busy = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      finish();
    };

    const setBusy = (nextBusy: boolean) => {
      busy = nextBusy;
      archiveButton.disabled = nextBusy;
      removeButton.disabled = nextBusy;
      cancelButton.disabled = nextBusy;
      removeButton.querySelector("[data-project-removal-label]")?.replaceChildren(
        document.createTextNode(nextBusy ? "Removing…" : "Remove from Sparky"),
      );
    };

    archiveButton = createProjectRemovalButton({
      title: "Archive project",
      onClick: () => {
        archiveProject({
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        });
        finish();
      },
    });

    removeButton = createProjectRemovalButton({
      title: "Remove from Sparky",
      destructive: true,
      onClick: () => {
        if (busy) return;
        errorMessage.classList.add("hidden");
        setBusy(true);
        void removeProjectFromSparky(project)
          .then((error) => {
            if (error === null) {
              finish();
              return;
            }
            errorMessage.textContent = error;
            errorMessage.classList.remove("hidden");
            setBusy(false);
          })
          .catch((error) => {
            errorMessage.textContent =
              error instanceof Error ? error.message : "Unknown error removing project.";
            errorMessage.classList.remove("hidden");
            setBusy(false);
          });
      },
    });
    actions.append(archiveButton, removeButton);

    cancelButton.addEventListener("click", () => {
      if (!busy) finish();
    });

    dialog.append(header, path, actions, errorMessage);
    overlay.append(dialog);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay && !busy) finish();
    });
    document.addEventListener("keydown", onKeyDown, true);
    document.body.append(overlay);
    archiveButton.focus();
  });
}

function decorateLocalApi(api: LocalApi): LocalApi {
  // Keep partially injected browser/native test doubles usable while the
  // optional decoration is applied. Production LocalApi instances always
  // provide this service, but a missing context menu should not make account
  // bootstrap fail before the sign-in surface can render.
  const contextMenu = api.contextMenu ?? {
    show: showContextMenuFallback,
  };
  const fallbackContextMenuShow = contextMenu.show.bind(contextMenu);
  return {
    ...api,
    contextMenu: {
      ...contextMenu,
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        const clicked = await fallbackContextMenuShow(items, position);
        const physicalProjectKey = projectRemovalPhysicalKeyFromSelection(items, clicked);
        if (physicalProjectKey === null) {
          return clicked;
        }

        const project = findProjectByPhysicalKey(physicalProjectKey);
        if (!project) {
          return clicked;
        }

        await showProjectRemovalDialog(project);
        // The styled dialog owns the archive/remove action. Returning null prevents
        // Sidebar's legacy "project is not empty" toast and native confirm path.
        return null;
      },
    },
  };
}

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    shell: {
      openInEditor: () => Promise.reject(unavailableLocalBackendError()),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
    },
    server: {
      getConfig: () => Promise.reject(unavailableLocalBackendError()),
      refreshProviders: () => Promise.reject(unavailableLocalBackendError()),
      updateProvider: () => Promise.reject(unavailableLocalBackendError()),
      upsertKeybinding: () => Promise.reject(unavailableLocalBackendError()),
      removeKeybinding: () => Promise.reject(unavailableLocalBackendError()),
      getSettings: () => Promise.reject(unavailableLocalBackendError()),
      updateSettings: () => Promise.reject(unavailableLocalBackendError()),
      discoverSourceControl: () => Promise.reject(unavailableLocalBackendError()),
      getTraceDiagnostics: () => Promise.reject(unavailableLocalBackendError()),
      getProcessDiagnostics: () => Promise.reject(unavailableLocalBackendError()),
      getProcessResourceHistory: () => Promise.reject(unavailableLocalBackendError()),
      signalProcess: () => Promise.reject(unavailableLocalBackendError()),
    },
  };
}

export function createLocalApi(): LocalApi {
  return decorateLocalApi(createBrowserLocalApi());
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  if (window.nativeApi) {
    cachedApi = decorateLocalApi(window.nativeApi);
    return cachedApi;
  }

  cachedApi = createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  const { __resetClientSettingsPersistenceForTests } = await import("./hooks/useSettings");
  __resetClientSettingsPersistenceForTests();
  resetRequestLatencyStateForTests();
}

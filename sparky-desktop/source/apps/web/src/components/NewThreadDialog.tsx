import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@sparky/contracts";
import { scopedProjectKey, scopeProjectRef } from "@sparky/client-runtime/environment";
import {
  createModelSelection,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@sparky/shared/model";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { mergeEnvironmentSettings, useClientSettings } from "../hooks/useSettings";
import { useProjects, useServerConfigs } from "../state/entities";
import { usePaginatedBranches } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { getAppModelOptionsForInstance } from "../modelSelection";
import { getProviderModelCapabilities } from "../providerModels";
import {
  availableExistingWorktrees,
  resolveNewThreadWorkspace,
  type ThreadWorkspaceChoice,
} from "../newThreadSetup";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

const fieldClassName =
  "h-9 min-w-0 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

interface ModelChoice {
  key: string;
  entry: ProviderInstanceEntry;
  slug: string;
  name: string;
}

function getChoiceKey(instanceId: string, model: string): string {
  return `${instanceId}:${model}`;
}

function currentDescriptorValue(descriptor: SelectDescriptor): string {
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string"
    ? value
    : (descriptor.options.find((option) => option.isDefault)?.id ??
        descriptor.options[0]?.id ??
        "");
}

function buildModelSelection(
  choice: ModelChoice,
  projectDefaultSelection: ModelSelection | null | undefined,
  selectedTraits: Readonly<Record<string, string | boolean>>,
): ModelSelection {
  const options: ProviderOptionSelection[] =
    projectDefaultSelection?.instanceId === choice.entry.instanceId &&
    projectDefaultSelection.model === choice.slug
      ? [...(projectDefaultSelection.options ?? [])]
      : [];
  for (const [id, value] of Object.entries(selectedTraits)) {
    const index = options.findIndex((option) => option.id === id);
    if (index >= 0) options.splice(index, 1);
    options.push({ id, value });
  }
  return createModelSelection(choice.entry.instanceId, choice.slug, options);
}

/**
 * A global thread entry point: each physical project (including remote
 * environments) is selectable without first navigating to that project.
 * Model traits are taken from the selected provider's actual model catalog.
 */
export function NewThreadDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const clientSettings = useClientSettings();
  const createDraftThread = useNewThreadHandler();

  const [projectKey, setProjectKey] = useState("");
  const [workspaceChoice, setWorkspaceChoice] = useState<ThreadWorkspaceChoice>("current");
  const [baseBranch, setBaseBranch] = useState("");
  const [existingWorktreePath, setExistingWorktreePath] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [selectedTraits, setSelectedTraits] = useState<Record<string, string | boolean>>({});
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setProjectKey("");
      setWorkspaceChoice("current");
      setBaseBranch("");
      setExistingWorktreePath("");
      setModelKey("");
      setSelectedTraits({});
      setPrompt("");
      setBusy(false);
    }
  }, [open]);

  const selectedProject =
    projects.find(
      (project) =>
        scopedProjectKey(scopeProjectRef(project.environmentId, project.id)) === projectKey,
    ) ??
    projects[0] ??
    null;
  const selectedProjectKey = selectedProject
    ? scopedProjectKey(scopeProjectRef(selectedProject.environmentId, selectedProject.id))
    : "";

  const branchState = usePaginatedBranches({
    environmentId: open ? (selectedProject?.environmentId ?? null) : null,
    cwd: open ? (selectedProject?.workspaceRoot ?? null) : null,
  });
  const status = useEnvironmentQuery(
    open && selectedProject
      ? vcsEnvironment.status({
          environmentId: selectedProject.environmentId,
          input: { cwd: selectedProject.workspaceRoot },
        })
      : null,
  );
  const currentBranch =
    status.data?.refName ?? branchState.refs.find((ref) => ref.current)?.name ?? null;
  const existingWorktrees = useMemo(
    () => availableExistingWorktrees(branchState.refs, selectedProject?.workspaceRoot ?? ""),
    [branchState.refs, selectedProject?.workspaceRoot],
  );
  const serverConfig = selectedProject ? serverConfigs.get(selectedProject.environmentId) : null;
  const settings = useMemo(
    () => mergeEnvironmentSettings(serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS, clientSettings),
    [serverConfig?.settings, clientSettings],
  );
  const providerEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(serverConfig?.providers ?? []),
          settings,
        ),
      ).filter((entry) => entry.enabled && entry.isAvailable),
    [serverConfig?.providers, settings],
  );
  const modelChoices = useMemo<ReadonlyArray<ModelChoice>>(
    () =>
      providerEntries.flatMap((entry) =>
        getAppModelOptionsForInstance(settings, entry).map((option) => ({
          key: getChoiceKey(entry.instanceId, option.slug),
          entry,
          slug: option.slug,
          name: option.name,
        })),
      ),
    [providerEntries, settings],
  );
  const defaultModel = selectedProject?.defaultModelSelection;
  const selectedModel =
    modelChoices.find((choice) => choice.key === modelKey) ??
    modelChoices.find(
      (choice) =>
        choice.entry.instanceId === defaultModel?.instanceId &&
        choice.slug === defaultModel?.model,
    ) ??
    modelChoices[0] ??
    null;

  const descriptors = useMemo(
    () =>
      selectedModel
        ? getProviderOptionDescriptors({
            caps: getProviderModelCapabilities(
              selectedModel.entry.models,
              selectedModel.slug,
              selectedModel.entry.driverKind,
            ),
            selections:
              defaultModel?.instanceId === selectedModel.entry.instanceId &&
              defaultModel.model === selectedModel.slug
                ? defaultModel.options
                : undefined,
          })
        : [],
    [defaultModel, selectedModel],
  );
  const reasoningDescriptor = descriptors.find(
    (descriptor): descriptor is SelectDescriptor =>
      descriptor.type === "select" &&
      /reason|effort|thinking|thought/iu.test(`${descriptor.id} ${descriptor.label}`),
  );
  const thinkingDescriptor = descriptors.find(
    (descriptor) => descriptor.type === "boolean" &&
      /thinking|reason/iu.test(`${descriptor.id} ${descriptor.label}`),
  );
  const contextDescriptor = descriptors.find(
    (descriptor): descriptor is SelectDescriptor =>
      descriptor.type === "select" &&
      /contextwindow|context window|context size/iu.test(
        `${descriptor.id} ${descriptor.label}`,
      ),
  );

  const resolvedWorkspace =
    selectedProject !== null
      ? resolveNewThreadWorkspace({
          choice: workspaceChoice,
          currentBranch,
          selectedBranch: baseBranch || null,
          selectedWorktreePath: existingWorktreePath || null,
          projectRoot: selectedProject.workspaceRoot,
          refs: branchState.refs,
        })
      : null;
  const canCreate = selectedProject !== null && selectedModel !== null && resolvedWorkspace !== null && !busy;

  const createThread = async () => {
    if (!canCreate || !selectedProject || !selectedModel || !resolvedWorkspace) return;
    setBusy(true);
    try {
      await createDraftThread(
        scopeProjectRef(selectedProject.environmentId, selectedProject.id),
        {
          ...resolvedWorkspace,
          forceNew: true,
          modelSelection: buildModelSelection(
            selectedModel,
            defaultModel,
            selectedTraits,
          ),
          initialPrompt: prompt,
        },
      );
      onOpenChange(false);
      onCreated?.();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      setBusy(false);
    }
  };

  const renderTrait = (label: string, descriptor: SelectDescriptor | undefined) => (
    <label className="grid gap-1.5 text-xs font-medium text-foreground">
      {label}
      <select
        aria-label={label}
        className={fieldClassName}
        disabled={!descriptor || busy}
        value={descriptor ? (selectedTraits[descriptor.id] ?? currentDescriptorValue(descriptor)) : ""}
        onChange={(event) => {
          if (!descriptor) return;
          setSelectedTraits((previous) => ({
            ...previous,
            [descriptor.id]: event.target.value,
          }));
        }}
      >
        {!descriptor ? <option value="">Provider default (not configurable)</option> : null}
        {descriptor?.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}{option.isDefault ? " (default)" : ""}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="max-w-xl" data-testid="new-thread-dialog">
        <DialogHeader>
          <DialogTitle>Create thread</DialogTitle>
          <DialogDescription>
            Start a thread in any project, choosing its checkout, model, and supported model settings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[65dvh] space-y-4 overflow-y-auto">
          <label className="grid gap-1.5 text-xs font-medium text-foreground">
            Project and environment
            <select
              className={fieldClassName}
              aria-label="Project and environment"
              value={selectedProjectKey}
              disabled={busy || projects.length === 0}
              onChange={(event) => {
                setProjectKey(event.target.value);
                setWorkspaceChoice("current");
                setBaseBranch("");
                setExistingWorktreePath("");
                setModelKey("");
                setSelectedTraits({});
              }}
            >
              {projects.length === 0 ? <option value="">No projects available</option> : null}
              {projects.map((project) => (
                <option
                  key={scopedProjectKey(scopeProjectRef(project.environmentId, project.id))}
                  value={scopedProjectKey(scopeProjectRef(project.environmentId, project.id))}
                >
                  {project.title || project.workspaceRoot} · {project.environmentId}
                </option>
              ))}
            </select>
          </label>
          {selectedProject ? (
            <p className="truncate text-xs text-muted-foreground" title={selectedProject.workspaceRoot}>
              {selectedProject.workspaceRoot}
            </p>
          ) : null}

          <label className="grid gap-1.5 text-xs font-medium text-foreground">
            Workspace
            <select
              aria-label="Workspace"
              className={fieldClassName}
              disabled={busy || !selectedProject}
              value={workspaceChoice}
              onChange={(event) => {
                setWorkspaceChoice(event.target.value as ThreadWorkspaceChoice);
                setBaseBranch("");
                setExistingWorktreePath("");
              }}
            >
              <option value="current">Current checkout</option>
              <option value="new-worktree" disabled={branchState.data?.isRepo === false}>
                New worktree
              </option>
              <option value="existing-worktree" disabled={branchState.data?.isRepo === false}>
                Existing worktree
              </option>
            </select>
          </label>

          {workspaceChoice === "current" ? (
            <p className="text-xs text-muted-foreground">
              Branch: {currentBranch ?? "No Git branch"}. Uses the checkout as-is without switching its branch.
            </p>
          ) : workspaceChoice === "new-worktree" ? (
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Base branch for new worktree
              <select
                aria-label="Base branch for new worktree"
                className={fieldClassName}
                value={baseBranch || currentBranch || ""}
                disabled={busy || branchState.refs.length === 0}
                onChange={(event) => setBaseBranch(event.target.value)}
              >
                {branchState.refs.length === 0 ? <option value="">No branches available</option> : null}
                {branchState.refs.map((ref) => (
                  <option key={ref.name} value={ref.name}>{ref.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Existing worktree and branch
              <select
                aria-label="Existing worktree and branch"
                className={fieldClassName}
                value={existingWorktreePath}
                disabled={busy || existingWorktrees.length === 0}
                onChange={(event) => setExistingWorktreePath(event.target.value)}
              >
                <option value="">Choose an existing worktree</option>
                {existingWorktrees.map((ref) => (
                  <option key={ref.worktreePath} value={ref.worktreePath ?? ""}>
                    {ref.name} · {ref.worktreePath}
                  </option>
                ))}
              </select>
            </label>
          )}
          {workspaceChoice !== "current" && branchState.data?.nextCursor != null ? (
            <Button size="sm" variant="outline" disabled={busy || branchState.isPending} onClick={branchState.loadNext}>
              Load more branches/worktrees
            </Button>
          ) : null}
          {branchState.error && workspaceChoice !== "current" ? (
            <p className="text-xs text-destructive" role="alert">{branchState.error}</p>
          ) : null}

          <label className="grid gap-1.5 text-xs font-medium text-foreground">
            Model
            <select
              aria-label="Model"
              className={fieldClassName}
              value={selectedModel?.key ?? ""}
              disabled={busy || modelChoices.length === 0}
              onChange={(event) => {
                setModelKey(event.target.value);
                setSelectedTraits({});
              }}
            >
              {modelChoices.length === 0 ? <option value="">No available models</option> : null}
              {providerEntries.map((entry) => (
                <optgroup key={entry.instanceId} label={entry.displayName}>
                  {modelChoices.filter((choice) => choice.entry.instanceId === entry.instanceId).map((choice) => (
                    <option key={choice.key} value={choice.key}>{choice.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {reasoningDescriptor ? renderTrait("Reasoning", reasoningDescriptor) : thinkingDescriptor ? (
              <label className="flex items-center gap-2 text-xs font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={Boolean(selectedTraits[thinkingDescriptor.id] ?? thinkingDescriptor.currentValue ?? false)}
                  disabled={busy}
                  onChange={(event) => setSelectedTraits((prev) => ({ ...prev, [thinkingDescriptor.id]: event.target.checked }))}
                />
                Reasoning / thinking
              </label>
            ) : renderTrait("Reasoning", undefined)}
            {renderTrait("Context window", contextDescriptor)}
          </div>
          <p className="text-xs text-muted-foreground">
            Only settings supported by the chosen model can be changed. Unavailable settings use the provider default.
          </p>
          <label className="grid gap-1.5 text-xs font-medium text-foreground">
            Starting message (optional)
            <textarea
              aria-label="Starting message (optional)"
              className="min-h-20 w-full resize-y rounded-lg border border-input bg-background p-3 text-sm font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={prompt}
              disabled={busy}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe what this thread should work on..."
            />
          </label>
          {workspaceChoice !== "current" && !resolvedWorkspace ? (
            <p className="text-xs text-muted-foreground" role="status">
              {workspaceChoice === "new-worktree"
                ? "Select an existing base branch to prepare an isolated worktree."
                : "Select a worktree from the selected project's Git repository."}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            data-testid="new-thread-create"
            disabled={!canCreate}
            onClick={() => void createThread()}
          >
            {busy ? "Creating…" : "Create thread"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

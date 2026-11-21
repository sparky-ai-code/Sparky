import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@sparky/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  UNSCOPED_CHAT_PROJECT_ID,
  type ScopedProjectRef,
} from "@sparky/contracts";
import { useCallback } from "react";

import {
  markPromotedDraftThreadByRef,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  resolveNewDraftStartFromOrigin,
  shouldApplyStickyModelSelection,
} from "../lib/chatThreadActions";
import { newDraftId, newThreadId } from "../lib/utils";
import { readThreadShell, useProjects, useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useClientSettings } from "./useSettings";

function normalizeRoot(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

/**
 * The Sparky project that backs a team project's agent chat: the project whose folder matches the
 * team project's local folder, or the unscoped chat project when no folder matches.
 */
export function useTeamAgentProjectRef(localPath: string | null): ScopedProjectRef | null {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (localPath !== null) {
    const wanted = normalizeRoot(localPath);
    const match = projects.find((project) => normalizeRoot(project.workspaceRoot) === wanted);
    if (match) {
      return scopeProjectRef(match.environmentId, match.id);
    }
  }
  if (primaryEnvironmentId === null) {
    return null;
  }
  return scopeProjectRef(primaryEnvironmentId, UNSCOPED_CHAT_PROJECT_ID);
}

/**
 * Returns a function that gives the draft for a project's chat. It reuses the unpromoted draft for
 * that project, like the new-chat button does, and otherwise creates one. It never navigates.
 */
export function useTeamAgentDraft() {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);

  return useCallback(
    (projectRef: ScopedProjectRef): DraftId => {
      const store = useComposerDraftStore.getState();
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);

      const stored = store.getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (stored) {
        const storedRef = scopeThreadRef(stored.environmentId, stored.threadId);
        if (readThreadShell(storedRef) === null) {
          return stored.draftId;
        }
        // The stored draft already became a real thread, so start a fresh draft.
        markPromotedDraftThreadByRef(storedRef);
      }

      const environmentSettings =
        serverConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const initialEnvMode = environmentSettings.defaultThreadEnvMode;
      store.setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt,
        branch: null,
        worktreePath: null,
        envMode: initialEnvMode,
        startFromOrigin: resolveNewDraftStartFromOrigin({
          envMode: initialEnvMode,
          newWorktreesStartFromOrigin: environmentSettings.newWorktreesStartFromOrigin,
        }),
        runtimeMode: DEFAULT_RUNTIME_MODE,
      });
      if (shouldApplyStickyModelSelection(projectRef.projectId)) {
        store.applyStickyState(draftId);
      }
      return draftId;
    },
    [projectGroupingSettings, projects, serverConfigs],
  );
}

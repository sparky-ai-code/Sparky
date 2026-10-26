type EnvironmentProject<T extends { readonly environmentId: string | null }> = T & {
  readonly environmentId: string;
};

export function findPullRequestReviewWorkspace<T extends { readonly environmentId: string | null }>(
  projects: ReadonlyArray<T>,
  primaryEnvironmentId: string | null,
): EnvironmentProject<T> | null {
  if (!primaryEnvironmentId) return null;
  return (
    projects.find(
      (project): project is EnvironmentProject<T> => project.environmentId === primaryEnvironmentId,
    ) ?? null
  );
}

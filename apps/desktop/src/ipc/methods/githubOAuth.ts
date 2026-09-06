export const GITHUB_OAUTH_SCOPE = "repo";

export function githubUserRepositoriesPath(page: number): string {
  const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
  return `/user/repos?visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100&sort=updated&direction=desc&page=${normalizedPage}`;
}

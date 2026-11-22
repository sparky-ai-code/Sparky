// Public copy is reviewed here instead of importing build and packaging notes.
// Stable release tags v1.1.23–v1.1.47, dated from their tag timestamps, with user-facing highlights from shipped changes.
const releases = [
  {
    version: "1.1.47",
    publishedAt: "2026-11-17",
    name: "A workspace that feels like yours",
    fixes: [
      "Choose an accent palette or custom color, then save your favorite look as a named theme.",
      "Tune light, dark, or system color mode, hover highlights, corner shapes, and compact spacing.",
      "Reset appearance settings at any time without losing your saved themes.",
    ],
  },
  {
    version: "1.1.46",
    publishedAt: "2026-11-16",
    name: "More dependable ChatGPT sign-in",
    fixes: [
      "Improved ChatGPT sign-in with a device authorization flow that does not depend on a browser callback.",
      "Made sign-in more resilient when the network is slow or the authorization response takes longer than expected.",
    ],
  },
  {
    version: "1.1.45",
    publishedAt: "2026-11-16",
    name: "Skills and ChatGPT compatibility",
    fixes: [
      "Sparky now discovers user-installed skills from both ~/.sparky/skills and ~/.agents/skills.",
      "Improved compatibility with ChatGPT subscription-based Codex sessions.",
    ],
  },
  {
    version: "1.1.44",
    publishedAt: "2026-11-15",
    name: "Smoother long-running work",
    fixes: [
      "Agents can now start threads in project folders that are not Git repositories.",
      "Improved recovery when desktop services or chat streams disconnect, and reduced idle resource use.",
    ],
  },
  {
    version: "1.1.43",
    publishedAt: "2026-11-14",
    name: "Work across threads and projects",
    fixes: [
      "Agents can discover, create, read, message, and steer threads across connected projects and environments.",
      "Improved ChatGPT sign-in on slow networks so authorization is more likely to finish successfully.",
    ],
  },
  {
    version: "1.1.42",
    publishedAt: "2026-11-12",
    name: "Persistent browser sessions, independent PR actions",
    fixes: [
      "Choose whether browser previews keep website sign-ins and storage across app restarts or use temporary sessions.",
      "Handle pull request reviews and merges independently, without selecting a batch of PRs.",
    ],
  },
  {
    version: "1.1.41",
    publishedAt: "2026-11-10",
    name: "Usage, now with subscription limits",
    fixes: [
      "Renamed the model analytics page to Usage and made token and cost breakdowns easier to read.",
      "View available ChatGPT plan usage limits alongside your recorded model usage.",
    ],
  },
  {
    version: "1.1.40",
    publishedAt: "2026-11-10",
    name: "Steer a running task",
    fixes: [
      "Send an additional instruction to a running thread without restarting its provider session.",
      "Clearer activity indicators show when a thread is working or has received a new direction.",
    ],
  },
  {
    version: "1.1.39",
    publishedAt: "2026-11-09",
    name: "Clean shutdowns",
    fixes: [
      "Active provider sessions now shut down cleanly when you close the app.",
    ],
  },
  {
    version: "1.1.38",
    publishedAt: "2026-11-08",
    name: "Charts, visual replies, and MCP setup",
    fixes: [
      "Assistant replies can now include rendered charts, diagrams, comparisons, and other focused visuals.",
      "Use Sparky's guided setup tool to add a streamable HTTP MCP server from its endpoint and authorization details.",
    ],
  },
  {
    version: "1.1.37",
    publishedAt: "2026-11-07",
    name: "More complete coding tasks",
    fixes: [
      "Improved Sparky's task guidance so it follows requested work through to completion instead of leaving partial implementations behind.",
    ],
  },
  {
    version: "1.1.36",
    publishedAt: "2026-11-06",
    name: "Review and merge pull requests together",
    fixes: [
      "Added bulk pull request review and merge actions for teams working through a larger queue.",
      "Clarified when project and backend changes are part of a requested task.",
    ],
  },
  {
    version: "1.1.35",
    publishedAt: "2026-11-05",
    name: "A clearer view of agent activity",
    fixes: [
      "Added progress updates and recognizable icons for connected MCP tools in the conversation timeline.",
      "Starting a project opens the folder picker directly, and tool activity is easier to scan.",
    ],
  },
  {
    version: "1.1.34",
    publishedAt: "2026-11-04",
    name: "Faster starts and more efficient sessions",
    fixes: [
      "Added a setting to prewarm Sparky processes for faster starts, with control to turn it off.",
      "Compressed supported provider requests and reduced unnecessary clarification checks to keep work moving efficiently.",
    ],
  },
  {
    version: "1.1.33",
    publishedAt: "2026-11-03",
    name: "Track model usage",
    fixes: [
      "Added an on-device usage dashboard with token totals, estimated costs, trends, and model-by-model breakdowns.",
      "Introduced published developer beta releases for people who opt in to preview updates.",
    ],
  },
  {
    version: "1.1.32",
    publishedAt: "2026-11-02",
    name: "More reliable AI pull request reviews",
    fixes: [
      "Refined the AI pull request review workflow for more consistent findings and clearer summaries.",
    ],
  },
  {
    version: "1.1.31",
    publishedAt: "2026-11-01",
    name: "Clearer tool activity",
    fixes: [
      "Improved the presentation of tool calls so ongoing work and completed results are easier to follow.",
    ],
  },
  {
    version: "1.1.30",
    publishedAt: "2026-10-31",
    name: "A new model for ChatGPT users",
    fixes: [
      "Added GPT-6.1 Terra to the ChatGPT model catalog.",
      "Retired the nightly desktop update track as Sparky moved to opt-in developer beta releases.",
    ],
  },
  {
    version: "1.1.29",
    publishedAt: "2026-10-30",
    name: "Work with files beyond the project folder",
    fixes: [
      "File tools can now work with absolute paths when your task calls for files outside the open project.",
      "Final responses now point more clearly to the key files that changed.",
    ],
  },
  {
    version: "1.1.28",
    publishedAt: "2026-10-26",
    name: "More reliable browser previews",
    fixes: [
      "Improved browser tab reuse and recovery so repeated preview requests are less likely to open duplicate tabs.",
      "Made navigation and browser automation waits more dependable.",
    ],
  },
  {
    version: "1.1.27",
    publishedAt: "2026-10-25",
    name: "Better long-running commands",
    fixes: [
      "Shell commands that take longer now keep streaming output while they run, so progress remains visible.",
      "Reduced overhead when working with long conversations.",
    ],
  },
  {
    version: "1.1.26",
    publishedAt: "2026-10-23",
    name: "Manage MCP connections",
    fixes: [
      "Added settings for adding, enabling, disabling, and checking the status of MCP servers.",
      "Improved model reasoning controls and made the selected desktop update track easier to identify.",
    ],
  },
  {
    version: "1.1.25",
    publishedAt: "2026-10-22",
    name: "Developer updates and long-running work",
    fixes: [
      "Added an opt-in developer beta update track for trying prerelease builds.",
      "You can monitor commands that continue running in the background and follow their output as it arrives.",
    ],
  },
  {
    version: "1.1.24",
    publishedAt: "2026-10-20",
    name: "Personalize settings and start chats with context",
    fixes: [
      "Added appearance controls and project-aware chat creation from the sidebar.",
      "Improved message streaming, pull request review summaries, and the organization of settings.",
    ],
  },
  {
    version: "1.1.23",
    publishedAt: "2026-10-06",
    name: "More consistent pull request reviews",
    fixes: [
      "Normalized AI review output so findings are presented more consistently.",
    ],
  },
  {
    version: "1.1.22",
    publishedAt: "2026-10-03",
    name: "OpenAI models and built-in PR reviews",
    fixes: [
      "Added an AI-powered pull request reviewer directly to the Pull Requests page.",
      "Sign in with your ChatGPT account to use eligible plan usage, alongside OpenAI API keys.",
      "Added support for the official OpenAI SDK and the newest OpenAI and Anthropic models.",
    ],
  },
  {
    version: "1.1.15",
    publishedAt: "2026-09-21",
    name: "More providers and a smoother workspace",
    fixes: [
      "Added Fireworks and Ollama Cloud as new providers in Settings, Models.",
      "Added split chats so two conversations can be viewed and compared side by side.",
      "Improved Codex sign-in and OAuth reliability, including safer model and context handling.",
      "Fixed provider discovery, model selection, split-pane controls, and other desktop bugs.",
    ],
  },
  {
    version: "1.1.14",
    publishedAt: "2026-09-16",
    name: "A clearer way to work",
    fixes: [
      "Refreshed the thread experience with a cleaner layout and easier navigation.",
      "Updated the sidebar so projects and threads are easier to find and manage.",
      "Added Focus Mode to dim working and inactive threads while keeping completed work easy to scan.",
      "Included a broad set of bug fixes and stability improvements across the desktop app.",
    ],
  },
  {
    version: "1.1.13",
    publishedAt: "2026-09-05",
    name: "Sign-in and connected apps",
    fixes: [
      "Fixed sign-in being lost after restarting Sparky.",
      "Plugin activity now shows the name and logo of the connected app.",
    ],
  },
  {
    version: "1.1.11",
    publishedAt: "2026-08-24",
    name: "Models and scheduled tasks",
    fixes: [
      "Fixed errors when using OX alpha Free.",
      "Fixed incorrect provider logos in the model picker.",
      "You can now choose a model for a scheduled task and change it later.",
    ],
  },
];

const list = document.getElementById("changelog-list");
for (const release of releases) {
  const article = document.createElement("article");
  article.className = "cl-entry";
  article.id = `release-${release.version}`;
  const meta = document.createElement("div");
  meta.className = "cl-meta";
  const version = document.createElement("a");
  version.className = "cl-version";
  version.href = `#${article.id}`;
  version.textContent = `v${release.version}`;
  version.setAttribute("aria-label", `Sparky ${release.version} release notes`);
  const date = document.createElement("time");
  date.className = "cl-date";
  date.dateTime = release.publishedAt;
  date.textContent = new Date(release.publishedAt).toLocaleDateString("en", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
  meta.append(version, date);
  const body = document.createElement("div");
  body.className = "cl-body";
  const heading = document.createElement("h2");
  heading.textContent = release.name;
  const fixes = document.createElement("ul");
  for (const text of release.fixes) {
    const item = document.createElement("li");
    item.textContent = text;
    fixes.append(item);
  }
  body.append(heading, fixes);
  article.append(meta, body);
  list.append(article);
}
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();

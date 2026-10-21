// Public copy is reviewed here instead of importing build and packaging notes.
// Sources: merged Sparky 1.1.22 features and published release notes for earlier releases.
const releases = [
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

// Public copy is reviewed here instead of importing build and packaging notes.
// Sources: published release notes for v1.1.13 (2026-09-05) and v1.1.11 (2026-08-24).
const releases = [
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

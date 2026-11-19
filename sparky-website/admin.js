const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content?.trim() || "";
const convexUrl = meta("convex-client-url");
const clerkKey = meta("clerk-publishable-key");
const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat("en-US");
const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

let clerk;
let convex;
let refreshInFlight = false;

function setConnection(label, state = "pending") {
  const element = $("#connection-status");
  element.textContent = label;
  element.className = `status-pill status-${state}`;
}

function setAuthMessage(message) {
  $("#auth-message").textContent = message;
}

function showAuth(show) {
  $("#auth-state").hidden = !show;
  $("#dashboard").hidden = show;
  $("#sign-out").hidden = show || !clerk?.session;
}

function textCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value == null || value === "" ? "—" : String(value);
  if (className) cell.className = className;
  return cell;
}

function row(cells) {
  const element = document.createElement("tr");
  cells.forEach((cell) => element.append(cell));
  return element;
}

function formatDuration(milliseconds) {
  const minutes = Math.round((milliseconds || 0) / 60000);
  if (minutes < 60) return `${number.format(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return `${number.format(hours)}h ${minutes % 60}m`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function renderMetrics(totals) {
  const metrics = [
    ["Unique visitors", totals.uniqueVisitors, "all time"],
    ["Sessions", totals.sessions, "all time"],
    ["Page views", totals.pageViews, "all time"],
    ["Downloads", totals.downloads, "completed downloads"],
    ["Download clicks", totals.downloadClicks, "all platforms"],
    ["App users", totals.appUsers, "installations"],
    ["Model requests", totals.modelRequests, "tracked requests"],
    ["Engaged time", formatDuration(totals.engagedMs), "across site sessions"],
  ];
  const grid = $("#metric-grid");
  grid.replaceChildren(...metrics.map(([label, value, detail]) => {
    const card = document.createElement("article");
    card.className = "metric";
    const labelElement = document.createElement("div");
    labelElement.className = "metric-label";
    labelElement.textContent = label;
    const valueElement = document.createElement("div");
    valueElement.className = "metric-value";
    valueElement.textContent = typeof value === "number" ? number.format(value) : value;
    const detailElement = document.createElement("div");
    detailElement.className = "metric-detail";
    detailElement.textContent = detail;
    card.append(labelElement, valueElement, detailElement);
    return card;
  }));
}

function renderDaily(daily) {
  const target = $("#daily-rows");
  target.replaceChildren(...daily.slice().reverse().map((day) => row([
    textCell(day.date),
    textCell(number.format(day.uniqueVisitors)),
    textCell(number.format(day.sessions)),
    textCell(number.format(day.pageViews)),
    textCell(number.format(day.downloads)),
    textCell(number.format(day.appLaunches)),
    textCell(number.format(day.modelRequests)),
  ])));
  if (!daily.length) target.append(row([textCell("No daily metrics yet")]));
}

function renderBreakdown(targetSelector, items, label, value, extra = () => "") {
  const target = $(targetSelector);
  target.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No data yet.";
    target.append(empty);
    return;
  }
  const max = Math.max(...items.map(value), 1);
  items.forEach((item) => {
    const wrapper = document.createElement("div");
    wrapper.className = "breakdown-item";
    const labels = document.createElement("div");
    labels.className = "breakdown-label";
    const name = document.createElement("span");
    name.textContent = label(item);
    const count = document.createElement("strong");
    count.textContent = `${number.format(value(item))}${extra(item)}`;
    labels.append(name, count);
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(3, (value(item) / max) * 100)}%`;
    bar.append(fill);
    wrapper.append(labels, bar);
    target.append(wrapper);
  });
}

function renderEvents(events) {
  const target = $("#event-rows");
  target.replaceChildren(...events.map((event) => {
    const context = [event.label, event.path, event.platform, event.release, event.browser, event.os].filter(Boolean).join(" · ");
    const usage = event.model
      ? `${event.model}${event.totalTokens ? ` · ${number.format(event.totalTokens)} tokens` : ""}`
      : event.downloadId ? "download" : "—";
    return row([
      textCell(dateTime.format(new Date(event.at))),
      textCell(event.kind, "event-kind"),
      textCell(event.source),
      textCell(context, "event-context"),
      textCell(event.outcome || (event.status ? `HTTP ${event.status}` : "—")),
      textCell(usage, "event-usage"),
    ]);
  }));
  if (!events.length) target.append(row([textCell("No visible events yet")]));
}

function renderReleases(releases) {
  const target = $("#release-rows");
  target.replaceChildren(...releases.map((release) => {
    const status = document.createElement("span");
    status.className = `badge badge-${release.status}`;
    status.textContent = release.status;
    return row([
      textCell(release.version),
      textCell(release.channel),
      (() => { const cell = document.createElement("td"); cell.append(status); return cell; })(),
      textCell(dateTime.format(new Date(release.createdAt))),
      textCell(release.publishedAt ? dateTime.format(new Date(release.publishedAt)) : "—"),
      textCell(`${release.files.length} · ${number.format(release.files.reduce((sum, file) => sum + file.size, 0))} bytes`),
    ]);
  }));
  if (!releases.length) target.append(row([textCell("No releases found")]));
}

function renderDashboard(data, releases) {
  renderMetrics(data.totals);
  renderDaily(data.daily);
  renderBreakdown("#download-breakdown", data.downloadBreakdown, (item) => item.platform, (item) => item.clicks + item.requests, (item) => ` · ${number.format(item.errors)} errors`);
  renderBreakdown("#environment-breakdown", data.environmentBreakdown, (item) => `${item.browser} · ${item.os}`, (item) => item.visitors, (item) => item.device === "unknown" ? "" : ` · ${item.device}`);
  renderEvents(data.recent);
  renderReleases(releases);
  $("#last-updated").textContent = `Updated ${dateTime.format(new Date())} · live Convex data`;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const isPaused = /free plan limits|deployments have been disabled/iu.test(message);
  const banner = $("#error-banner");
  banner.textContent = message.includes("Administrator access")
    ? "This Clerk account is not authorized for the admin dashboard."
    : isPaused
      ? "Live analytics is temporarily unavailable because Convex paused this deployment after its plan limit was exceeded. No stored data was deleted; reactivate the deployment to resume live data."
      : "The live dashboard could not be loaded. Check the deployment and try again.";
  banner.hidden = false;
  $("#last-updated").textContent = isPaused
    ? "Live data is paused by the Convex deployment"
    : "Live data is currently unavailable";
}

async function refreshDashboard() {
  if (!convex || !clerk?.session || refreshInFlight) return;
  refreshInFlight = true;
  $("#error-banner").hidden = true;
  setConnection("Loading…", "pending");
  try {
    await convex.setAuth(() => clerk.session?.getToken({ template: "convex" }) ?? null);
    const [dashboard, releases] = await Promise.all([
      convex.query("analytics:dashboard", {}),
      convex.query("releases:listAdmin", {}),
    ]);
    renderDashboard(dashboard, releases);
    showAuth(false);
    setConnection("Live", "live");
  } catch (error) {
    const isAdminAccessError = error instanceof Error && error.message.includes("Administrator access");
    showError(error);
    if (isAdminAccessError) {
      showAuth(true);
      setAuthMessage("The signed-in account does not have administrator access.");
    } else {
      showAuth(false);
    }
    setConnection("Unavailable", "error");
  } finally {
    refreshInFlight = false;
  }
}

async function updateAuth() {
  if (!clerk?.session) {
    showAuth(true);
    $("#sign-in").disabled = false;
    $("#sign-in").textContent = "Sign in to continue";
    $("#sign-out").hidden = true;
    setConnection("Sign-in required", "pending");
    return;
  }
  $("#sign-out").hidden = false;
  await refreshDashboard();
}

async function boot() {
  if (!convexUrl || !clerkKey) {
    setConnection("Configuration missing", "error");
    setAuthMessage("The Convex or Clerk public configuration is missing from this build.");
    return;
  }
  try {
    const [{ Clerk }, { ConvexHttpClient }] = await Promise.all([
      import("https://esm.sh/@clerk/clerk-js@5.86.0"),
      import("https://esm.sh/convex@1.36.1/browser"),
    ]);
    clerk = new Clerk(clerkKey);
    await clerk.load();
    convex = new ConvexHttpClient(convexUrl);
    clerk.addListener(() => void updateAuth());
    $("#sign-in").addEventListener("click", () => clerk.openSignIn());
    $("#sign-out").addEventListener("click", async () => {
      await clerk.signOut();
      showAuth(true);
    });
    $("#refresh").addEventListener("click", () => void refreshDashboard());
    await updateAuth();
  } catch (error) {
    setConnection("Startup failed", "error");
    setAuthMessage("The admin console could not initialize its authentication client.");
    console.error(error);
  }
}

void boot();

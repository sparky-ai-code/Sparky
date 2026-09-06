import {
  BellRingIcon,
  CircleIcon,
  FileSearchIcon,
  NotebookPenIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import {
  buildScheduledTask,
  DEFAULT_SCHEDULED_TASKS,
  formatScheduleSummary,
  formatTimeLabel,
  getNextRunLabel,
  matchesScheduledTask,
  removePreloadedScheduledTasks,
  SCHEDULED_TASKS_STORAGE_KEY,
  SCHEDULED_TASKS_SUGGESTION_CYCLE_STORAGE_KEY,
  selectCycledSuggestions,
  type ScheduleDraft,
  type ScheduleFrequency,
  type ScheduledTask,
  type ScheduledTaskAccent,
  ScheduledTaskListSchema,
  WEEKDAY_OPTIONS,
} from "../../scheduledTasks";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";

type TaskFilter = "all" | "active" | "paused";

const FILTER_OPTIONS: ReadonlyArray<{ value: TaskFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
];

const FREQUENCY_OPTIONS: ReadonlyArray<{
  value: ScheduleFrequency;
  label: string;
  description: string;
}> = [
  { value: "hourly", label: "Loop", description: "Repeat on an interval" },
  { value: "daily", label: "Every day", description: "Run once a day" },
  { value: "weekly", label: "Specific day", description: "Run on a weekday" },
  { value: "once", label: "Once", description: "Run one time" },
];

const ACCENT_CYCLE: readonly ScheduledTaskAccent[] = ["blue", "violet", "green"];
const SUGGESTION_PAGE_SIZE = 3;
const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-muted/60 px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20";
const SELECT_TRIGGER_CLASS =
  "h-9 min-h-9 w-full rounded-lg border border-input bg-muted/60 px-3 text-[13px] text-foreground shadow-none outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20";
const DROPDOWN_POPUP_CLASS = "bg-popover/95 backdrop-blur-sm";
const TEXTAREA_CLASS =
  "min-h-20 w-full resize-y rounded-lg border border-input bg-muted/60 px-3 py-2 text-[13px] leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20";
const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const totalMinutes = index * 15;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const value = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
  return { value, label: formatTimeLabel(value) };
});

interface ScheduleSuggestion {
  title: string;
  schedule: string;
  description: string;
  accent: ScheduledTaskAccent;
  icon: ComponentType<{ className?: string }>;
  draft: ScheduleDraft;
}

function tomorrowDateInputValue(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function emptyScheduleDraft(): ScheduleDraft {
  return {
    title: "",
    prompt: "",
    frequency: "daily",
    intervalHours: 1,
    time: "08:00",
    dayOfWeek: "monday",
    date: tomorrowDateInputValue(),
  };
}

const SUGGESTIONS: readonly ScheduleSuggestion[] = [
  {
    title: "Daily brief",
    schedule: "Weekdays at 8:00 AM",
    description: "Start each weekday with a summary of your calendar, unread email, and priorities",
    accent: "blue",
    icon: BellRingIcon,
    draft: {
      title: "Daily brief",
      prompt: "Start each weekday with a summary of my calendar, unread email, and priorities.",
      frequency: "weekly",
      intervalHours: 1,
      time: "08:00",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Weekly review",
    schedule: "Fridays at 4:00 PM",
    description: "Turn your recent work into a concise status update every Friday",
    accent: "violet",
    icon: NotebookPenIcon,
    draft: {
      title: "Weekly review",
      prompt: "Turn my recent work into a concise status update every Friday.",
      frequency: "weekly",
      intervalHours: 1,
      time: "16:00",
      dayOfWeek: "friday",
      date: "",
    },
  },
  {
    title: "Follow-up monitor",
    schedule: "Weekdays at 9:00 AM",
    description:
      "Review recent email and calendar activity and flag anything that needs your attention",
    accent: "green",
    icon: FileSearchIcon,
    draft: {
      title: "Follow-up monitor",
      prompt:
        "Review recent email and calendar activity and flag anything that needs my attention.",
      frequency: "weekly",
      intervalHours: 1,
      time: "09:00",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Inbox zero check",
    schedule: "Every day at 5:00 PM",
    description: "Summarize unanswered messages and suggest the next follow-up for each one",
    accent: "blue",
    icon: BellRingIcon,
    draft: {
      title: "Inbox zero check",
      prompt: "Summarize unanswered messages and suggest the next follow-up for each one.",
      frequency: "daily",
      intervalHours: 1,
      time: "17:00",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Stand-up prep",
    schedule: "Weekdays at 9:15 AM",
    description: "Turn yesterday's work and today's calendar into a short stand-up update",
    accent: "violet",
    icon: NotebookPenIcon,
    draft: {
      title: "Stand-up prep",
      prompt: "Turn yesterday's work and today's calendar into a short stand-up update.",
      frequency: "weekly",
      intervalHours: 1,
      time: "09:15",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Project pulse",
    schedule: "Mondays at 10:00 AM",
    description: "Review project activity and call out risks, blockers, and recent progress",
    accent: "green",
    icon: FileSearchIcon,
    draft: {
      title: "Project pulse",
      prompt: "Review project activity and call out risks, blockers, and recent progress.",
      frequency: "weekly",
      intervalHours: 1,
      time: "10:00",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Reading roundup",
    schedule: "Sundays at 6:00 PM",
    description: "Collect the articles I saved this week and summarize the ideas worth revisiting",
    accent: "blue",
    icon: NotebookPenIcon,
    draft: {
      title: "Reading roundup",
      prompt: "Collect the articles I saved this week and summarize the ideas worth revisiting.",
      frequency: "weekly",
      intervalHours: 1,
      time: "18:00",
      dayOfWeek: "sunday",
      date: "",
    },
  },
  {
    title: "Meeting prep",
    schedule: "Weekdays at 8:30 AM",
    description:
      "Prepare a concise briefing from the day's meetings, attendees, and open decisions",
    accent: "violet",
    icon: BellRingIcon,
    draft: {
      title: "Meeting prep",
      prompt: "Prepare a concise briefing from the day's meetings, attendees, and open decisions.",
      frequency: "weekly",
      intervalHours: 1,
      time: "08:30",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Expense check",
    schedule: "Fridays at 3:00 PM",
    description: "Review recent expenses and flag missing receipts or unusual charges",
    accent: "green",
    icon: FileSearchIcon,
    draft: {
      title: "Expense check",
      prompt: "Review recent expenses and flag missing receipts or unusual charges.",
      frequency: "weekly",
      intervalHours: 1,
      time: "15:00",
      dayOfWeek: "friday",
      date: "",
    },
  },
  {
    title: "Repository watch",
    schedule: "Every 2 hours",
    description: "Watch the repository for important changes and summarize new activity",
    accent: "blue",
    icon: FileSearchIcon,
    draft: {
      title: "Repository watch",
      prompt: "Watch the repository for important changes and summarize new activity.",
      frequency: "hourly",
      intervalHours: 2,
      time: "",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Focus plan",
    schedule: "Every day at 8:45 AM",
    description: "Choose three priorities for today from my active projects and calendar",
    accent: "violet",
    icon: NotebookPenIcon,
    draft: {
      title: "Focus plan",
      prompt: "Choose three priorities for today from my active projects and calendar.",
      frequency: "daily",
      intervalHours: 1,
      time: "08:45",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Team update",
    schedule: "Thursdays at 2:00 PM",
    description: "Draft a clear team update from the week's completed work and open questions",
    accent: "green",
    icon: BellRingIcon,
    draft: {
      title: "Team update",
      prompt: "Draft a clear team update from the week's completed work and open questions.",
      frequency: "weekly",
      intervalHours: 1,
      time: "14:00",
      dayOfWeek: "thursday",
      date: "",
    },
  },
  {
    title: "News digest",
    schedule: "Every day at 7:30 AM",
    description: "Summarize the most important news for the topics I am tracking",
    accent: "blue",
    icon: BellRingIcon,
    draft: {
      title: "News digest",
      prompt: "Summarize the most important news for the topics I am tracking.",
      frequency: "daily",
      intervalHours: 1,
      time: "07:30",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Calendar sweep",
    schedule: "Mondays at 8:15 AM",
    description:
      "Look ahead at the next seven days and flag schedule conflicts or preparation gaps",
    accent: "violet",
    icon: FileSearchIcon,
    draft: {
      title: "Calendar sweep",
      prompt: "Look ahead at the next seven days and flag schedule conflicts or preparation gaps.",
      frequency: "weekly",
      intervalHours: 1,
      time: "08:15",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Customer feedback",
    schedule: "Wednesdays at 11:00 AM",
    description: "Group new customer feedback into themes and highlight the most urgent requests",
    accent: "green",
    icon: NotebookPenIcon,
    draft: {
      title: "Customer feedback",
      prompt: "Group new customer feedback into themes and highlight the most urgent requests.",
      frequency: "weekly",
      intervalHours: 1,
      time: "11:00",
      dayOfWeek: "wednesday",
      date: "",
    },
  },
  {
    title: "Learning log",
    schedule: "Saturdays at 5:30 PM",
    description:
      "Review this week's notes and turn the most useful lessons into a short learning log",
    accent: "blue",
    icon: NotebookPenIcon,
    draft: {
      title: "Learning log",
      prompt:
        "Review this week's notes and turn the most useful lessons into a short learning log.",
      frequency: "weekly",
      intervalHours: 1,
      time: "17:30",
      dayOfWeek: "saturday",
      date: "",
    },
  },
  {
    title: "End-of-day recap",
    schedule: "Every day at 6:30 PM",
    description: "Summarize what changed today and carry unfinished priorities into tomorrow",
    accent: "violet",
    icon: BellRingIcon,
    draft: {
      title: "End-of-day recap",
      prompt: "Summarize what changed today and carry unfinished priorities into tomorrow.",
      frequency: "daily",
      intervalHours: 1,
      time: "18:30",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Dependency watch",
    schedule: "Every 4 hours",
    description: "Check dependencies for important updates and note anything that needs review",
    accent: "green",
    icon: FileSearchIcon,
    draft: {
      title: "Dependency watch",
      prompt: "Check dependencies for important updates and note anything that needs review.",
      frequency: "hourly",
      intervalHours: 4,
      time: "",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Personal planning",
    schedule: "Sundays at 7:00 PM",
    description: "Plan the week ahead around my priorities, commitments, and available focus time",
    accent: "blue",
    icon: NotebookPenIcon,
    draft: {
      title: "Personal planning",
      prompt: "Plan the week ahead around my priorities, commitments, and available focus time.",
      frequency: "weekly",
      intervalHours: 1,
      time: "19:00",
      dayOfWeek: "sunday",
      date: "",
    },
  },
  {
    title: "Launch monitor",
    schedule: "Once on a specific date",
    description: "Check launch-day activity and report anything that needs an immediate response",
    accent: "violet",
    icon: FileSearchIcon,
    draft: {
      title: "Launch monitor",
      prompt: "Check launch-day activity and report anything that needs an immediate response.",
      frequency: "once",
      intervalHours: 1,
      time: "10:00",
      dayOfWeek: "monday",
      date: tomorrowDateInputValue(),
    },
  },
];

function accentClass(accent: ScheduledTaskAccent): string {
  switch (accent) {
    case "blue":
      return "text-blue-500";
    case "violet":
      return "text-violet-500";
    case "green":
      return "text-emerald-500";
  }
}

function taskMatchesFilter(task: ScheduledTask, filter: TaskFilter): boolean {
  if (filter === "all") return true;
  return filter === "active" ? task.active : !task.active;
}

export function ScheduledTasksPage() {
  const [tasks, setTasks] = useLocalStorage(
    SCHEDULED_TASKS_STORAGE_KEY,
    DEFAULT_SCHEDULED_TASKS,
    ScheduledTaskListSchema,
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [suggestionCycleIndex, setSuggestionCycleIndex] = useLocalStorage(
    SCHEDULED_TASKS_SUGGESTION_CYCLE_STORAGE_KEY,
    0,
    Schema.Number,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(emptyScheduleDraft);
  const [formError, setFormError] = useState("");
  const didAdvanceSuggestionCycle = useRef(false);

  useEffect(() => {
    if (didAdvanceSuggestionCycle.current) return;
    didAdvanceSuggestionCycle.current = true;
    setSuggestionCycleIndex((currentIndex) => currentIndex + 1);
  }, [setSuggestionCycleIndex]);

  useEffect(() => {
    const cleanedTasks = removePreloadedScheduledTasks(tasks);
    if (cleanedTasks.length !== tasks.length) {
      setTasks(cleanedTasks);
    }
  }, [setTasks, tasks]);

  const visibleTasks = useMemo(
    () =>
      tasks.filter((task) => taskMatchesFilter(task, filter) && matchesScheduledTask(task, query)),
    [filter, query, tasks],
  );

  const visibleSuggestions = useMemo(
    () => selectCycledSuggestions(SUGGESTIONS, suggestionCycleIndex, SUGGESTION_PAGE_SIZE),
    [suggestionCycleIndex],
  );

  const editingTask =
    editingTaskId === null ? null : tasks.find((task) => task.id === editingTaskId);

  const openCreateDialog = (suggestionDraft?: ScheduleDraft) => {
    setEditingTaskId(null);
    setDraft(suggestionDraft ? { ...suggestionDraft } : emptyScheduleDraft());
    setFormError("");
    setDialogOpen(true);
  };

  const openEditDialog = (task: ScheduledTask) => {
    setEditingTaskId(task.id);
    setDraft({
      title: task.title,
      prompt: task.description,
      frequency: task.frequency,
      intervalHours: task.intervalHours,
      time: task.time,
      dayOfWeek: task.dayOfWeek,
      date: task.date,
    });
    setFormError("");
    setDialogOpen(true);
  };

  const handleTaskSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.title.trim()) {
      setFormError("Add a name for this scheduled task.");
      return;
    }
    if (!draft.prompt.trim()) {
      setFormError("Describe what Sparky should do when this task runs.");
      return;
    }

    if (editingTask) {
      const updatedTask = buildScheduledTask(draft, editingTask.id, editingTask.accent);
      setTasks((currentTasks) =>
        currentTasks.map((task) =>
          task.id === editingTask.id
            ? { ...updatedTask, active: editingTask.active, statusLabel: editingTask.statusLabel }
            : task,
        ),
      );
    } else {
      const nextAccent = ACCENT_CYCLE[tasks.length % ACCENT_CYCLE.length] ?? "blue";
      setTasks((currentTasks) => [
        ...currentTasks,
        buildScheduledTask(draft, `scheduled-${Date.now()}`, nextAccent),
      ]);
    }

    setDialogOpen(false);
    setFormError("");
  };

  const toggleTask = (taskId: string) => {
    setTasks((currentTasks) =>
      currentTasks.map((task) =>
        task.id === taskId
          ? { ...task, active: !task.active, statusLabel: task.active ? "Paused" : "Scheduled" }
          : task,
      ),
    );
  };

  const deleteEditingTask = () => {
    if (!editingTaskId) return;
    setTasks((currentTasks) => currentTasks.filter((task) => task.id !== editingTaskId));
    setDialogOpen(false);
    setEditingTaskId(null);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="relative min-h-0 flex-1 overflow-y-auto bg-background">
        <div
          aria-labelledby="scheduled-tasks-title"
          className="mx-auto w-full max-w-[820px] px-4 pt-16 pb-12 sm:pt-[68px]"
        >
          <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <h1
                id="scheduled-tasks-title"
                className="text-[30px] font-normal leading-[1.15] tracking-[-0.035em] text-foreground"
              >
                Scheduled tasks
              </h1>
              <p className="mt-2 text-base leading-6 tracking-[-0.01em] text-muted-foreground">
                Ask Sparky to schedule tasks, set reminders, or monitor for updates
              </p>
            </div>
            <button
              type="button"
              data-testid="schedules-create-button"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 self-start rounded-[10px] bg-foreground px-3 text-sm font-normal text-background shadow-sm transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={() => openCreateDialog()}
            >
              <PlusIcon className="size-3.5" />
              Create
            </button>
          </header>

          <label className="mt-5 flex h-9 items-center rounded-full border border-input bg-muted/80 px-3 text-muted-foreground shadow-inner shadow-black/10 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              aria-label="Search scheduled tasks"
              className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder="Search scheduled tasks"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="mt-5 flex items-center gap-1" role="tablist" aria-label="Task status">
            {FILTER_OPTIONS.map((option) => {
              const isSelected = filter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-sm leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    isSelected
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <section className="mt-3" aria-label="Scheduled task list">
            {visibleTasks.length > 0 ? (
              <div className="divide-y-0">
                {visibleTasks.map((task, index) => (
                  <article
                    key={task.id}
                    className={cn(
                      "grid grid-cols-[18px_minmax(0,1fr)] gap-2 px-3 py-2.5",
                      index > 0 && "mt-2",
                    )}
                    data-testid={`scheduled-task-${task.id}`}
                  >
                    <button
                      type="button"
                      aria-label={task.active ? `Pause ${task.title}` : `Resume ${task.title}`}
                      className="mt-0.5 inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      onClick={() => toggleTask(task.id)}
                    >
                      <CircleIcon className="size-4 stroke-[1.7]" />
                    </button>
                    <button
                      type="button"
                      className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      onClick={() => openEditDialog(task)}
                    >
                      <span className="block truncate text-[15px] leading-5 text-foreground">
                        {task.title}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] leading-5 text-muted-foreground">
                        <span>{task.active ? task.statusLabel : "Paused"}</span>
                        <span aria-hidden="true">·</span>
                        <span>{task.nextRunLabel}</span>
                      </span>
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <p className="px-3 py-4 text-[13px] text-muted-foreground">
                {query.trim()
                  ? "No scheduled tasks match your search."
                  : "No scheduled tasks yet. Create one to get started."}
              </p>
            )}
          </section>

          <section className="mt-1 border-t border-border pt-4" aria-labelledby="suggestions-title">
            <h2 id="suggestions-title" className="text-lg leading-6 text-muted-foreground">
              Suggestions
            </h2>
            <div className="mt-2">
              {visibleSuggestions.map((suggestion, index) => {
                const Icon = suggestion.icon;
                return (
                  <button
                    key={suggestion.title}
                    type="button"
                    className={cn(
                      "grid w-full grid-cols-[18px_minmax(0,1fr)] gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      index > 0 && "mt-2",
                    )}
                    onClick={() => openCreateDialog(suggestion.draft)}
                  >
                    <Icon className={cn("mt-0.5 size-4", accentClass(suggestion.accent))} />
                    <span className="min-w-0">
                      <span className="block text-[15px] leading-5 text-foreground">
                        {suggestion.title}
                        <span className="ml-1.5 text-muted-foreground">{suggestion.schedule}</span>
                      </span>
                      <span className="mt-0.5 block text-[13px] leading-5 text-muted-foreground">
                        {suggestion.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className="max-w-md overflow-hidden border-border bg-popover text-popover-foreground shadow-2xl shadow-black/50">
          <form onSubmit={handleTaskSubmit}>
            <DialogHeader className="gap-1.5 border-b border-border bg-popover p-5 pb-3">
              <DialogTitle className="text-lg text-popover-foreground">
                {editingTask ? "Edit scheduled task" : "Create scheduled task"}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Tell Sparky what to do and choose when it should run.
              </DialogDescription>
            </DialogHeader>
            <div data-slot="dialog-panel" className="space-y-4 bg-popover px-5 pt-1 pb-5">
              <label className="grid gap-2">
                <span className="text-[13px] font-medium text-foreground">Task name</span>
                <input
                  aria-label="Task name"
                  autoFocus
                  className={FIELD_CLASS}
                  data-testid="schedule-task-name"
                  placeholder="e.g. Daily brief"
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, title: event.target.value }))
                  }
                />
              </label>

              <label className="grid gap-2">
                <span className="text-[13px] font-medium text-foreground">
                  What should Sparky do?
                </span>
                <textarea
                  aria-label="Task prompt"
                  className={TEXTAREA_CLASS}
                  data-testid="schedule-task-prompt"
                  placeholder="Review my recent work and send me the important changes."
                  value={draft.prompt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, prompt: event.target.value }))
                  }
                />
              </label>

              <div className="grid gap-2">
                <span className="text-[13px] font-medium text-foreground">Repeat</span>
                <Select
                  value={draft.frequency}
                  onValueChange={(value) => {
                    if (!value) return;
                    setDraft((current) => ({
                      ...current,
                      frequency: value as ScheduleFrequency,
                    }));
                  }}
                >
                  <SelectTrigger aria-label="Repeat frequency" className={SELECT_TRIGGER_CLASS}>
                    <SelectValue>
                      {FREQUENCY_OPTIONS.find((option) => option.value === draft.frequency)
                        ?.label ?? "Every day"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup
                    className="max-h-56"
                    popupClassName={DROPDOWN_POPUP_CLASS}
                    alignItemWithTrigger={false}
                  >
                    {FREQUENCY_OPTIONS.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        hideIndicator
                        className="min-h-10 py-1.5"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[13px] font-medium">{option.label}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {option.description}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

              {draft.frequency === "hourly" ? (
                <label className="grid gap-2">
                  <span className="text-[13px] font-medium text-foreground">Loop interval</span>
                  <span className="flex items-center gap-2">
                    <input
                      aria-label="Loop interval in hours"
                      className={cn(FIELD_CLASS, "w-24")}
                      min={1}
                      max={24}
                      type="number"
                      value={draft.intervalHours}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          intervalHours: Math.max(1, Number(event.target.value) || 1),
                        }))
                      }
                    />
                    <span className="text-[13px] text-muted-foreground">hour(s)</span>
                  </span>
                </label>
              ) : null}

              {draft.frequency === "daily" ||
              draft.frequency === "weekly" ||
              draft.frequency === "once" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {draft.frequency === "weekly" ? (
                    <label className="grid gap-2">
                      <span className="text-[13px] font-medium text-foreground">Day</span>
                      <Select
                        value={draft.dayOfWeek}
                        onValueChange={(value) => {
                          if (!value) return;
                          setDraft((current) => ({
                            ...current,
                            dayOfWeek: value as ScheduleDraft["dayOfWeek"],
                          }));
                        }}
                      >
                        <SelectTrigger aria-label="Day of week" className={SELECT_TRIGGER_CLASS}>
                          <SelectValue>
                            {WEEKDAY_OPTIONS.find((option) => option.value === draft.dayOfWeek)
                              ?.label ?? "Mondays"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup
                          className="max-h-52"
                          popupClassName={DROPDOWN_POPUP_CLASS}
                          alignItemWithTrigger={false}
                        >
                          {WEEKDAY_OPTIONS.map((option) => (
                            <SelectItem
                              key={option.value}
                              value={option.value}
                              hideIndicator
                              className="min-h-7 py-1 text-[13px]"
                            >
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </label>
                  ) : null}
                  {draft.frequency === "once" ? (
                    <label className="grid gap-2">
                      <span className="text-[13px] font-medium text-foreground">Date</span>
                      <input
                        aria-label="Scheduled date"
                        className={FIELD_CLASS}
                        type="date"
                        value={draft.date}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, date: event.target.value }))
                        }
                      />
                    </label>
                  ) : null}
                  <label className="grid gap-2">
                    <span className="text-[13px] font-medium text-foreground">Time</span>
                    <Select
                      value={draft.time}
                      onValueChange={(value) => {
                        if (!value) return;
                        setDraft((current) => ({ ...current, time: value }));
                      }}
                    >
                      <SelectTrigger aria-label="Scheduled time" className={SELECT_TRIGGER_CLASS}>
                        <SelectValue>{formatTimeLabel(draft.time)}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup
                        className="max-h-52"
                        popupClassName={DROPDOWN_POPUP_CLASS}
                        alignItemWithTrigger={false}
                      >
                        {TIME_OPTIONS.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            hideIndicator
                            className="min-h-7 py-1 text-[13px]"
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </label>
                </div>
              ) : null}

              <div className="rounded-lg border border-border bg-muted/60 px-3 py-2.5 text-[13px] text-muted-foreground">
                <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  Schedule preview
                </span>
                <span className="mt-1 block text-sm text-foreground">
                  {formatScheduleSummary(draft)}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {getNextRunLabel(draft)}
                </span>
              </div>

              {formError ? (
                <p className="text-sm text-destructive" role="alert">
                  {formError}
                </p>
              ) : null}
            </div>
            <DialogFooter
              variant="bare"
              className="border-t border-border bg-muted/50 px-5 pt-3 pb-4"
            >
              {editingTask ? (
                <button
                  type="button"
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
                  onClick={deleteEditingTask}
                >
                  <Trash2Icon className="size-4" />
                  Delete
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 items-center justify-center rounded-lg px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  onClick={() => setDialogOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="inline-flex h-8 items-center justify-center rounded-lg bg-foreground px-3 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {editingTask ? "Save changes" : "Schedule task"}
                </button>
              </div>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}

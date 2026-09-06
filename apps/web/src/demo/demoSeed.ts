import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  type OrchestrationThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerConfig,
  ThreadId,
  type ThreadId as ThreadIdType,
  TurnId,
} from "@sparky/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@sparky/shared/keybindings";
import * as Schema from "effect/Schema";

export const DEMO_ENVIRONMENT_ID = EnvironmentId.make("sparky-demo");
export const DEMO_PROJECT_ID = ProjectId.make("sparky-project");
export const DEMO_INITIAL_THREAD_ID = ThreadId.make("desktop-release");

const demoProviderInstanceId = ProviderInstanceId.make("codex");

const now = "2026-07-28T13:30:00.000Z";
const modelSelection = {
  instanceId: demoProviderInstanceId,
  model: "gpt-5.6-sol",
  options: [{ id: "reasoning_effort", value: "high" }],
} as const;

const thread = (
  id: ThreadIdType,
  title: string,
  branch: string,
  messages: OrchestrationThread["messages"],
): OrchestrationThread => ({
  id,
  projectId: DEMO_PROJECT_ID,
  title,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch,
  worktreePath: null,
  latestTurn: {
    turnId: TurnId.make(`${id}-turn`),
    state: "completed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    assistantMessageId: messages.findLast((message) => message.role === "assistant")?.id ?? null,
  },
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  messages,
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: id,
    status: "ready",
    providerName: "Sparky",
    providerInstanceId: demoProviderInstanceId,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
  },
});

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: string,
): OrchestrationThread["messages"][number] => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: TurnId.make(turnId),
  streaming: false,
  createdAt: now,
  updatedAt: now,
});

export const DEMO_THREADS: ReadonlyArray<OrchestrationThread> = [
  thread(DEMO_INITIAL_THREAD_ID, "Ship the Windows desktop", "release/desktop-0.0.28", [
    message(
      "desktop-user",
      "user",
      "Prepare the Windows desktop release, run the focused checks, and tell me exactly what is ready to ship.",
      "desktop-release-turn",
    ),
    message(
      "desktop-assistant",
      "assistant",
      "The Windows desktop release is ready. I built the packaged app, verified the updater metadata, and checked the download route against the published artifact.\n\n- Desktop package completed successfully\n- 40 focused update and release tests passed\n- Installer checksum matches the published manifest",
      "desktop-release-turn",
    ),
  ]),
  thread(ThreadId.make("rust-harness"), "Connect the Sparky harness", "feat/rust-runtime", [
    message(
      "rust-user",
      "user",
      "Keep Sparky's own Rust harness and connect the desktop surface to it without replacing the agent loop.",
      "rust-harness-turn",
    ),
    message(
      "rust-assistant",
      "assistant",
      "I traced the renderer, provider driver, and Rust AgentLoop boundaries. The next change keeps the Rust harness in control while the desktop consumes its streamed session events.\n\n- Rust AgentLoop remains the execution owner\n- Desktop provider selection stays independent\n- Session events are mapped at the renderer boundary",
      "rust-harness-turn",
    ),
  ]),
  thread(ThreadId.make("website-demo"), "Publish the real interactive demo", "main", [
    message(
      "website-user",
      "user",
      "Render the actual desktop application at /demo and embed that same page on the homepage.",
      "website-demo-turn",
    ),
    message(
      "website-assistant",
      "assistant",
      "The standalone demo now boots the production Sparky renderer. The sidebar, thread route, transcript, review controls, and composer come from the desktop codebase; only the local snapshot and safe demo transport are substituted.",
      "website-demo-turn",
    ),
  ]),
];

const shellThreads = DEMO_THREADS.map(
  ({ messages, proposedPlans, activities, checkpoints, deletedAt, ...value }) => ({
    ...value,
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }),
);

const serverConfig: ServerConfig = {
  environment: {
    environmentId: DEMO_ENVIRONMENT_ID,
    label: "Sparky demo",
    platform: { os: "windows", arch: "x64" },
    serverVersion: "0.0.28",
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  },
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "C:\\Sparky",
  keybindingsConfigPath: "C:\\Sparky\\keybindings.json",
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  issues: [],
  providers: [
    {
      instanceId: demoProviderInstanceId,
      driver: ProviderDriverKind.make("codex"),
      displayName: "Sparky",
      accentColor: "#22b8f0",
      showInteractionModeToggle: true,
      enabled: true,
      installed: true,
      version: "0.104.0",
      status: "ready",
      auth: {
        status: "authenticated",
        type: "demo",
        label: "Demo account",
        email: "demo@sparky.llc",
      },
      checkedAt: now,
      availability: "available",
      models: [
        {
          slug: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          shortName: "5.6 Sol",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ],
  availableEditors: ["vscode"],
  observability: {
    logsDirectoryPath: "C:\\Sparky\\logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    textGenerationModelSelection: modelSelection,
  },
  shellResumeCompletionMarker: true,
  threadResumeCompletionMarker: true,
};

function requestToPromise(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
}

export async function seedDemoDatabase(): Promise<void> {
  localStorage.setItem(
    "t3code:client-settings:v1",
    JSON.stringify({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompleted: true,
      onboardingUseCase: "Improve an existing codebase",
      cloudDataSharingEnabled: false,
    }),
  );
  const open = indexedDB.open("t3code:connection-runtime", 4);
  open.addEventListener("upgradeneeded", () => {
    for (const name of ["catalog", "shell", "thread", "server-config", "vcs-refs"]) {
      if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
    }
  });
  await requestToPromise(open);
  const database = open.result;
  const transaction = database.transaction(
    ["catalog", "shell", "thread", "server-config"],
    "readwrite",
  );
  const catalog = {
    schemaVersion: 1,
    targets: [
      {
        _tag: "BearerConnectionTarget",
        environmentId: DEMO_ENVIRONMENT_ID,
        label: "Sparky demo",
        connectionId: "sparky-demo-connection",
      },
    ],
    profiles: [
      {
        _tag: "BearerConnectionProfile",
        connectionId: "sparky-demo-connection",
        environmentId: DEMO_ENVIRONMENT_ID,
        label: "Sparky demo",
        httpBaseUrl: "https://demo.invalid",
        wsBaseUrl: "wss://demo.invalid",
      },
    ],
    credentials: [
      {
        connectionId: "sparky-demo-connection",
        credential: { _tag: "BearerConnectionCredential", token: "public-demo" },
      },
    ],
    remoteDpopTokens: [],
  };
  transaction.objectStore("catalog").put(JSON.stringify(catalog), "document");
  transaction.objectStore("shell").put(
    JSON.stringify({
      schemaVersion: 1,
      environmentId: DEMO_ENVIRONMENT_ID,
      snapshot: {
        snapshotSequence: 1,
        projects: [
          {
            id: DEMO_PROJECT_ID,
            title: "Sparky",
            workspaceRoot: "C:\\Sparky",
            repositoryIdentity: null,
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        threads: shellThreads,
        updatedAt: now,
      },
    }),
    DEMO_ENVIRONMENT_ID,
  );
  for (const demoThread of DEMO_THREADS) {
    transaction.objectStore("thread").put(
      JSON.stringify({
        schemaVersion: 2,
        environmentId: DEMO_ENVIRONMENT_ID,
        threadId: demoThread.id,
        snapshot: { snapshotSequence: 1, thread: demoThread },
      }),
      `${DEMO_ENVIRONMENT_ID}:${demoThread.id}`,
    );
  }
  const encodedServerConfig = Schema.encodeSync(ServerConfig)(serverConfig);
  transaction.objectStore("server-config").put(
    JSON.stringify({
      schemaVersion: 1,
      environmentId: DEMO_ENVIRONMENT_ID,
      config: encodedServerConfig,
    }),
    DEMO_ENVIRONMENT_ID,
  );
  await transactionToPromise(transaction);
  database.close();
}

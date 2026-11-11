import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  MicroboxError, MicroboxStatus, MicroboxImage, MicroboxSnapshot, MicroboxTarget,
  MicroboxCreateInput, MicroboxClickInput, MicroboxTypeInput, MicroboxKeyInput,
} from "@sparky/contracts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Microboxes from "../../../microboxes/Microboxes.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, Microboxes.Microboxes];
const target = Schema.Struct({ boxId: MicroboxTarget.fields.boxId });
const empty = Schema.Struct({});
const make = <T extends Tool.Any>(tool: T): T => tool.annotate(Tool.OpenWorld, false) as T;
const readonly = <T extends Tool.Any>(tool: T): T =>
  make(tool).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false) as T;
const mutate = <T extends Tool.Any>(tool: T): T =>
  make(tool).annotate(Tool.Destructive, true) as T;

export const BoxImagesTool = readonly(Tool.make("box_images", {
  description: "List installed guest operating system images. Use one of these image IDs with box_create.",
  parameters: empty, success: Schema.Array(MicroboxImage), failure: MicroboxError, dependencies,
}).annotate(Tool.Title, "List Microboxes images"));
export const BoxListTool = readonly(Tool.make("box_list", {
  description: "List this agent thread's graphical virtual machines and their status.",
  parameters: empty, success: Schema.Array(MicroboxStatus), failure: MicroboxError, dependencies,
}).annotate(Tool.Title, "List graphical boxes"));
export const BoxCreateTool = mutate(Tool.make("box_create", {
  description: "Start an isolated GUI virtual machine from a previously installed image. This tool only works after the user explicitly enables Sparky Microboxes. Use artifactRelativePath to attach a compiled installer from your thread workspace as a read-only virtual USB disk during boot; click the installer in the guest GUI to test it. Internet access is separately opt-in and disabled by default.",
  parameters: Schema.Struct({
    imageId: MicroboxCreateInput.fields.imageId,
    name: Schema.optionalKey(Schema.String),
    memoryMiB: MicroboxCreateInput.fields.memoryMiB,
    cpus: MicroboxCreateInput.fields.cpus,
    internet: MicroboxCreateInput.fields.internet,
    artifactRelativePath: MicroboxCreateInput.fields.artifactRelativePath,
  }),
  success: MicroboxStatus, failure: MicroboxError, dependencies,
}).annotate(Tool.Title, "Create graphical box"));
export const BoxStatusTool = readonly(Tool.make("box_status", {
  description: "Inspect one virtual machine owned by this thread.",
  parameters: target, success: MicroboxStatus, failure: MicroboxError, dependencies,
}).annotate(Tool.Title, "Get box status"));
export const BoxSnapshotTool = readonly(Tool.make("box_snapshot", {
  description: "Capture a screenshot of the real graphical desktop inside a running box.",
  parameters: target, success: MicroboxSnapshot, failure: MicroboxError, dependencies,
}).annotate(Tool.Title, "Capture VM screen"));
export const BoxClickTool = mutate(Tool.make("box_click", {
  description: "Click the graphical desktop at guest-screen pixel coordinates. Get the current image dimensions from box_snapshot first.",
  parameters: Schema.Struct({
    ...target.fields,
    x: MicroboxClickInput.fields.x,
    y: MicroboxClickInput.fields.y,
    button: MicroboxClickInput.fields.button,
  }),
  success: Schema.Null, failure: MicroboxError, dependencies,
}).annotate(Tool.Title, "Click inside box"));
export const BoxTypeTool = mutate(Tool.make("box_type", {
  description: "Type text into the currently focused graphical application in a VM.",
  parameters: Schema.Struct({ ...target.fields, text: MicroboxTypeInput.fields.text }),
  success: Schema.Null, failure: MicroboxError, dependencies,
}).annotate(Tool.Title, "Type inside box"));
export const BoxPressTool = mutate(Tool.make("box_press", {
  description: "Send a keyboard shortcut to a VM, for example Ctrl+S, Alt+Tab or Enter.",
  parameters: Schema.Struct({ ...target.fields, key: MicroboxKeyInput.fields.key }),
  success: Schema.Null, failure: MicroboxError, dependencies,
}).annotate(Tool.Title, "Press VM key"));
export const BoxStopTool = mutate(Tool.make("box_stop", {
  description: "Stop a box while retaining its private disk for debugging.",
  parameters: target, success: Schema.Null, failure: MicroboxError, dependencies,
}).annotate(Tool.Title, "Stop box"));
export const BoxDestroyTool = mutate(Tool.make("box_destroy", {
  description: "Permanently discard a box and its private disk. Destructive.",
  parameters: target, success: Schema.Null, failure: MicroboxError, dependencies,
}).annotate(Tool.Title, "Destroy box"));

export const MicroboxesToolkit = Toolkit.make(
  BoxImagesTool, BoxListTool, BoxCreateTool, BoxStatusTool, BoxSnapshotTool, BoxClickTool,
  BoxTypeTool, BoxPressTool, BoxStopTool, BoxDestroyTool,
);

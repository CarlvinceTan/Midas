import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  isViewportTUI,
  matchesKey,
  ProcessTerminal,
  SettingsList,
  stripTerminalSequences,
  TuiAltScreen,
  TuiMainScreen,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type ScrollView,
  type SlashCommand,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type ViewportTUI,
} from "@earendil-works/pi-tui";
import { copyToClipboard, initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, basename, join, relative, resolve, sep } from "node:path";
import { findImagePaths, readImageAttachment, type PromptAttachment } from "../lib/attachments.ts";
import type { AgentChoice, AuthMethod, AuthPrompt, CommandChoice, SessionController, ModelChoice } from "../opencode/session.ts";
import { loadCachedAgentStats, readAgentStats, refreshAgentStats } from "../opencode/agent-stats.ts";
import type { Session } from "@opencode-ai/sdk";
import { Transcript, type MessageView, type PartView } from "../state/transcript.ts";
import { computeRuns, formatSeconds, liveRunId } from "./run-model.ts";
import { RunView } from "./components/run-view.ts";
import { setMcpServerNames, toolLiveText } from "./components/tool-call.ts";
import { QueuedMessages } from "./components/queued-messages.ts";
import { FooterComponent, formatCwdForFooter, type FooterData } from "./components/footer.ts";
import { Toast } from "./components/toast.ts";
import { PermissionDialog, type PermissionResponse } from "./components/permission-dialog.ts";
import { QuestionDialog } from "./components/question-dialog.ts";
import { ModelPicker, modelDisplayLabel } from "./components/model-picker.ts";
import { ThinkingPicker } from "./components/thinking-picker.ts";
import { SessionsView } from "./components/sessions-view.ts";
import { AGENT_LABELS, loadAgentSessions, readAgentTranscript, type AgentSession } from "../lib/agent-sessions.ts";
import { upsertMidasSession } from "../lib/session-store.ts";
import { StatsView } from "./components/stats-view.ts";
import { TasksView } from "./components/tasks-view.ts";
import { TaskBoard, gitAsync } from "../tasks/board.ts";
import { TaskDispatcher } from "../tasks/dispatcher.ts";
import { SessionHeader, StartupHeader } from "./components/startup-header.ts";
import { OptionPicker } from "./components/option-picker.ts";
import { PromptDialog } from "./components/prompt-dialog.ts";
import { SPINNER_FRAMES } from "./components/tool-call.ts";
import { FramedEditorDock, PanelOverlay, RoundedDialogFrame } from "./rounded-frame.ts";
import { BlankLine, PaddedBlock, createChatViewport } from "./layout.ts";
import { getEditorTheme, getSettingsListTheme, initTheme, theme } from "../theme/theme.ts";
import { GenerationRate, RateDisplay } from "../features/rate.ts";
import { ContextDisplay, LiveContext, type ContextUsage } from "../features/live-context.ts";
import { markContent, truncateColored } from "../lib/ansi.ts";
import { capitalize, parseShellCommand, truncateWords, usableSessionTitle, type ShellCommand } from "../lib/text.ts";
import { CURRENCY_CHOICES, applyCurrencySetting, currencyLabel, normalizeCurrencyKey } from "../lib/currency.ts";
import { SearchPicker } from "./components/search-picker.ts";
import { readDraft, writeDraft, type StoredDraft } from "../lib/drafts.ts";
import { readSessionState, writeSessionState, type StoredBash } from "../lib/session-state.ts";
import { resolveCdTarget } from "../lib/shell.ts";
import { agentCallerLabel, agentSettingsRows, groupAgentNames, selectableAgentNames, BOARD_WORKER_AGENT, DEFAULT_INTERACTIVE_AGENT, ORCHESTRATOR_AGENT } from "../lib/agents.ts";
import { listSkills, loadPiSettings, piAgentDir, readAuthedProviders, readLastSelectedModel, removeAuthedProvider, rowPad, thinkingLevelFor, updateGlobalSetting, updateModelThinkingLevel, writeLastSelectedModel, type PiSettings, type SkillEntry, midasConfigDir, midasProjectDir, agentsGlobalDir, agentsProjectDir } from "../config/pi.ts";
import { loadCustomCommands, renderCommandTemplate, type CustomCommand } from "../config/commands.ts";
import { spawn } from "node:child_process";

const VERSION = "0.1.0";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** opencode commands hidden from midas's list/autocomplete (midas provides its own). */
const HIDDEN_COMMANDS = new Set([
  "pause_goal",
  "resume_goal",
  "goal",
  "init",
  "review",
  // opencode's built-in embedded skill; not wanted in midas's slash menu.
  "customize-opencode",
  "customise-opencode",
]);
/** Slash commands deferred until the active run settles (they rework the session). */
const QUEUED_COMMANDS = new Set(["compact", "reload"]);
/** Slash commands that would replace the session or start competing work. */
const INTERRUPTING_COMMANDS = new Set(["new"]);
/** Agent midas opens with when nothing else is configured. */
const DEFAULT_AGENT = DEFAULT_INTERACTIVE_AGENT;

/** Whether a persisted working directory still exists. */
function directoryExists(path: string | undefined): path is string {
  if (!path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** How a submitted draft is routed once the editor hands it to `handleSubmit`. */
export type SubmitAction = "send" | "queue" | "requeue" | "command";

/**
 * Decide how a submission should be routed. Kept pure (no editor/controller
 * access) so the routing rules can be exercised without standing up a full app.
 * Busy normal prompts queue as follow-ups in every mode: entering text never
 * steers, only cmd+enter does (that path bypasses this decision).
 *
 * - `command`: slash commands keep their existing, name-specific rules.
 * - `send`: dispatch a normal prompt as a fresh turn.
 * - `queue`: park a normal prompt in the follow-up queue.
 * - `requeue`: return an edited follow-up to its original queue slot.
 */
export function submitAction(input: {
  multitask: boolean;
  runActive: boolean;
  isCommand: boolean;
  editing: boolean;
}): SubmitAction {
  if (input.isCommand) return "command";
  if (!input.runActive) return "send";
  // Multitask affects only the dispatcher keep-alive, never how a busy prompt
  // is delivered: it always queues as a follow-up.
  return input.editing ? "requeue" : "queue";
}

/**
 * Multitask drives the board from submitted prompts, so every submission keeps
 * the runner alive. `ensure` is expected to be idempotent: it returns early when
 * this session already leads the dispatch lease and retries when another session
 * holds it, so repeated submissions never start a duplicate loop.
 */
export function ensureDispatcherOnSubmit(multitask: boolean, ensure: () => void): void {
  if (multitask) ensure();
}

/**
 * Resolve `/voice [on|off]`. An empty argument flips the current state; an
 * unknown argument returns `undefined` so the caller can report usage.
 */
export function voiceToggle(args: string, current: boolean): boolean | undefined {
  if (args === "on") return true;
  if (args === "off") return false;
  if (args === "") return !current;
  return undefined;
}

/**
 * Title drawn into the input frame's top rule. Voice dictation (Listening)
 * outranks the orchestrator's Multitask mode; with both off there is no title.
 */
export function voiceFrameTitle(input: { voice: boolean; orchestrator: boolean }): string | undefined {
  if (input.voice) return "Listening";
  return input.orchestrator ? "Multitask" : undefined;
}

/**
 * Esc leaves voice mode only while listening and with no autocomplete menu
 * open, so the same key can still dismiss the menu or abort a run otherwise.
 */
export function exitVoiceOnEscape(input: { voiceActive: boolean; escape: boolean; autocomplete: boolean }): boolean {
  return input.voiceActive && input.escape && !input.autocomplete;
}

interface LoginEntry {
  providerId: string;
  providerName: string;
  methodIndex: number;
  method: AuthMethod;
}

export interface AppOptions {
  controller: SessionController;
  cwd: string;
  settings: PiSettings;
  model?: ModelChoice;
  agent?: string;
}

interface TranscriptOptions {
  hideThinking: boolean;
  expandedTools: boolean;
}

/** Renders only the transcript runs; the scroll container owns the header. */
class TranscriptMessages implements Component {
  private runViews = new Map<string, RunView>();
  private readonly maxRuns = 200;
  /** Live status row (spinner/Working/Thinking), rendered after the live run. */
  private status?: Component;
  /** Rendered row range of each clickable child, for routing mouse clicks. */
  private ranges: Array<{ component: Component; start: number; end: number }> = [];

  constructor(
    private transcript: Transcript,
    private options: TranscriptOptions,
    private getPad: () => number,
    private cwd: string,
    private borderColor: (text: string) => string,
    private ui: TUI,
  ) {}

  setStatus(component: Component): void {
    this.status = component;
  }

  invalidate(): void {
    this.status?.invalidate?.();
    for (const view of this.runViews.values()) view.invalidate();
  }

  /** Drop rendered views (after switching/new sessions). */
  reset(): void {
    this.runViews.clear();
    this.ranges = [];
  }

  render(width: number): string[] {
    // Pending steers render in the transcript (so they scroll with the output),
    // but the agent's in-flight turn stays the live one until it picks them up.
    const runs = computeRuns(this.transcript.messages);
    const visible = runs.length > this.maxRuns ? runs.slice(runs.length - this.maxRuns) : runs;
    const activeRunId = liveRunId(runs);
    const idle = this.transcript.phase === "idle";
    const lines: string[] = [];
    const ranges: Array<{ component: Component; start: number; end: number }> = [];
    const seen = new Set<string>();
    let statusRendered = false;

    const renderStatus = (): void => {
      if (!this.status) return;
      const rendered = this.status.render(width);
      if (rendered.length === 0) return;
      // Exactly one blank row separates the status from whatever precedes it.
      // The run/prompt may already end with its own separator, so only add one
      // when the previous row is not already blank.
      if (lines.length === 0 || lines[lines.length - 1] !== "") lines.push("");
      const start = lines.length;
      lines.push(...rendered);
      ranges.push({ component: this.status, start, end: lines.length });
      statusRendered = true;
    };

    for (const run of visible) {
      seen.add(run.id);
      let view = this.runViews.get(run.id);
      if (!view) {
        view = new RunView(run, this.getPad, this.cwd, this.options, this.borderColor, this.ui);
        this.runViews.set(run.id, view);
      } else {
        view.setRun(run);
      }
      // Only the newest run stays live while the session is busy; every other
      // run (and the last one once idle) settles into its "Worked for" block.
      view.setActive(run.id === activeRunId && !idle);
      const rendered = view.render(width);
      if (rendered.length === 0) continue;
      const start = lines.length;
      lines.push(...rendered);
      ranges.push({ component: view, start, end: lines.length });
      // Keep the live status with the in-flight turn: for a pending steer it
      // sits above the steer message until the steer is picked up.
      if (run.id === activeRunId) renderStatus();
      lines.push("");
    }
    if (!statusRendered) renderStatus();

    for (const id of [...this.runViews.keys()]) {
      if (!seen.has(id)) this.runViews.delete(id);
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    this.ranges = ranges;
    return lines;
  }

  /** Route a click to the row under the cursor (run header, chain or item). */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    for (const range of this.ranges) {
      if (event.y < range.start || event.y >= range.end) continue;
      return range.component.handleMouse?.({ ...event, y: event.y - range.start, height: range.end - range.start });
    }
    return undefined;
  }
}

export class WorkingIndicator implements Component {
  private currentId = "";

  constructor(
    private status: (
      width: number,
    ) => { id: string; label: string; tone?: "thinking" | "running"; detail?: string } | undefined,
    private frame: () => string,
    private getPad: () => number,
    private expandedFor: () => string | undefined,
    private onPress: (id: string) => void,
  ) {}

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event?.type !== "click" || event?.button !== "left") return undefined;
    this.onPress(this.currentId);
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    const status = this.status(width);
    if (!status) return [];
    this.currentId = status.id;
    const t = theme();
    // Spinner is always blue; thinking is orange, running tools yellow on the verb.
    const glyph = t.fg("accent", this.frame());
    let label: string;
    if (status.tone === "running") {
      const space = status.label.indexOf(" ");
      label =
        space === -1
          ? t.fg("toolTitle", status.label)
          : t.fg("toolTitle", status.label.slice(0, space)) + t.fg("muted", status.label.slice(space));
    } else {
      label = t.fg("mdHeading", status.label);
    }
    const padN = this.getPad();
    const pad = " ".repeat(padN);
    // Mirror the left indent on the right so long commands are truncated with a
    // color-matched ellipsis instead of running into the terminal edge.
    const contentWidth = Math.max(1, width - padN * 2);
    // The transcript composer owns the single blank row above the status; adding
    // one here too would double the gap. No trailing blank, either, so the row
    // doesn't add space before the input box.
    const lines = [pad + markContent(truncateColored(`${glyph} ${label}`, contentWidth))];
    // Clicking reveals only the current action's detail (e.g. streaming thinking).
    if (status.detail && this.expandedFor() === status.id) {
      const detailIndent = padN + 2;
      const detailPad = " ".repeat(detailIndent);
      const detailWidth = Math.max(1, width - detailIndent - padN);
      const detailLines = status.detail
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(-12);
      for (const line of detailLines) {
        lines.push(detailPad + markContent(truncateColored(t.fg("thinkingText", line), detailWidth)));
      }
    }
    return lines;
  }
}

/**
 * Floating "scroll to bottom" pill. Shown/hidden as an overlay (not a layout
 * row) so it never pushes the queue or input up.
 */
class ScrollToBottomButton implements Component {
  static readonly LABEL = " ↓ Scroll to bottom ";

  constructor(private onPress: () => void) {}

  invalidate(): void {}

  render(width: number): string[] {
    const t = theme();
    const label = t.bg("selectedBg", t.fg("text", ScrollToBottomButton.LABEL));
    return [truncateToWidth(label, Math.max(1, width), "")];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event?.type !== "click" || event?.button !== "left") return undefined;
    this.onPress();
    return { handled: true, render: true };
  }
}

/**
 * Zero-height dock sentinel that shows/hides the scroll-to-bottom overlay to
 * match the viewport's follow state. Lives in the layout so it re-syncs on every
 * frame (including scroll), but renders nothing itself.
 */
class ScrollToBottomOverlay implements Component {
  private shown = false;
  private handle: OverlayHandle | undefined;

  constructor(
    private tuiRef: () => TUI | undefined,
    private isScrolled: () => boolean,
  ) {}

  invalidate(): void {}

  render(): string[] {
    const scrolled = this.isScrolled();
    if (scrolled === this.shown) return [];
    this.shown = scrolled;
    // Defer overlay mutation out of the render pass.
    queueMicrotask(() => this.sync());
    return [];
  }

  private sync(): void {
    const tui = this.tuiRef();
    if (!tui) return;
    if (!this.shown) {
      this.handle?.hide();
      this.handle = undefined;
      tui.requestRender();
      return;
    }
    if (this.handle) return;
    // Fullscreen renders the built-in scrollToEndIndicator at the transcript's
    // bottom edge, so a second screen-anchored pill would overlap the input.
    if (isViewportTUI(tui)) return;
    try {
      this.handle = tui.showOverlay(new ScrollToBottomButton(() => this.scrollToBottom()), {
        anchor: "bottom-center",
        offsetY: -4,
        width: ScrollToBottomButton.LABEL.length,
        nonCapturing: true,
      });
    } catch {
      this.handle = undefined;
      this.shown = false;
    }
  }

  private scrollToBottom(): void {
    const tui = this.tuiRef();
    if (!tui) return;
    (tui as TuiAltScreen).scrollToBottom();
    this.shown = false;
    this.handle?.hide();
    this.handle = undefined;
    tui.requestRender();
  }
}

/**
 * SettingsList with search, minus the blank row pi-tui inserts between the
 * search input and the items, so it matches midas's other search rows.
 */
class CompactSearchList implements Component {
  constructor(
    private inner: SettingsList,
    private hideHint = false,
  ) {}

  invalidate(): void {
    this.inner.invalidate();
  }

  render(width: number): string[] {
    const lines = this.inner.render(width);
    const blank = lines.indexOf("");
    if (blank !== -1) lines.splice(blank, 1);
    // The selected item's description wraps over many rows; collapse it to a
    // single line truncated with an ellipsis. It sits between the blank row
    // before the hint (last line) and the blank row that follows the items.
    const gap = lines.length - 2;
    if (gap >= 2 && lines[gap] === "") {
      let start = gap - 1;
      while (start >= 0 && lines[start] !== "") start--;
      const descStart = start + 1;
      // Require the blank separator that precedes a description block; without
      // it the rows above are just items and must not be collapsed.
      if (start >= 0 && descStart < gap) {
        const text = lines
          .slice(descStart, gap)
          .map((line, index) => {
            const plain = stripTerminalSequences(line);
            return index === 0 ? plain : plain.replace(/^\s+/, "");
          })
          .join(" ")
          .trimEnd();
        lines.splice(descStart, gap - descStart, theme().fg("dim", truncateToWidth(text, width, "…")));
      }
    }
    // pi advertises both keys; midas only needs Enter to change a value.
    if (this.hideHint) {
      // Drop the trailing hint row (and the blank line that precedes it).
      if (lines.length > 0) lines.pop();
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return lines;
    }
    const hint = lines[lines.length - 1];
    if (hint) lines[lines.length - 1] = hint.replace("Enter/Space", "Enter");
    return lines;
  }

  handleInput(data: string): void {
    this.inner.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // The removed blank row shifts items up one line; restore the inner offset.
    return this.inner.handleMouse?.({ ...event, y: event.y > 0 ? event.y + 1 : event.y });
  }
}

/** Rewrites pi's "Enter/Space" hint to just "Enter" without touching the list. */
class NoHintList implements Component {
  constructor(private inner: SettingsList) {}

  invalidate(): void {
    this.inner.invalidate();
  }

  render(width: number): string[] {
    const lines = this.inner.render(width);
    // Drop the trailing key-hint row (and the blank line that precedes it).
    if (lines.length > 0) lines.pop();
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  handleInput(data: string): void {
    this.inner.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.inner.handleMouse?.(event);
  }
}

/** A follow-up waiting for the active run to settle. */
interface QueuedPrompt {
  text: string;
  attachments: PromptAttachment[];
}

export class MidasApp {
  private tui: TUI;
  private editor: Editor;
  private transcriptView: TranscriptMessages;
  private footer: FooterComponent;
  private sessionHeader: SessionHeader;
  private header: StartupHeader;
  private scrollView: ScrollView | undefined;
  private generationRate = new GenerationRate();
  private rateDisplay = new RateDisplay();
  private liveContext = new LiveContext();
  private contextDisplay = new ContextDisplay();
  private displayTps: number | null = null;
  private showContext = false;
  private generation = 0;
  private activeAssistantId: string | undefined;
  private streamedChars = 0;
  private rateTimer: NodeJS.Timeout | undefined;
  /** Footer toast: a fully-styled line plus its clear timer. */
  private toastHandle: OverlayHandle | undefined;
  private toastTimer: NodeJS.Timeout | undefined;
  private spinnerIndex = 0;
  private activeOverlay: Component | undefined;
  /** Open stats overlay, updated when a background refresh finishes. */
  private statsView: StatsView | undefined;
  /** Periodic background refresh of the stats cache. */
  private statsTimer?: ReturnType<typeof setInterval>;
  /** Input draft held while an overlay occupies the editor dock. */
  private overlayDraft: string | undefined;
  private editorDock!: FramedEditorDock;
  private currentPermissionId: string | undefined;
  private currentQuestionId: string | undefined;
  private hideThinking: boolean;
  private thinkingLevel = "medium";
  private expandedTools = false;
  /** Id of the live action whose detail is expanded under the status line. */
  private liveExpandedFor: string | undefined;
  /** Sent prompts, read from the editor's own Up/Down history (newest first). */
  private historyView: { index: number; length: number } = { index: -1, length: 0 };
  /** Start of the current "Working for Xs" window, keyed by action id. */
  private workingSince: { id: string; at: number } | undefined;
  /** Start of the current retry, for the "Retrying for Xs" timer. */
  private retryStartedAt: number | undefined;
  /** Shared with rendered transcript components so /reload can update them in place. */
  private transcriptOptions: TranscriptOptions = {
    hideThinking: true,
    expandedTools: false,
  };
  private model: ModelChoice | undefined;
  private models: ModelChoice[] = [];
  private agentGroups: string[][] = [];
  private agentChoices: string[] = [];
  /** Set while choosing a model inside /agents, shown as a border breadcrumb. */
  private agentBreadcrumb: string | undefined;
  /** Full agent catalog (names, modes, configured models). */
  private agentCatalog: AgentChoice[] = [];
  private activeAgent = DEFAULT_AGENT;
  /** True while `/voice` microphone dictation streams into the input. */
  private voiceActive = false;
  /**
   * Speech-to-text backend seam. A later task wires the real controller; with
   * no controller installed the mode still toggles and repaints cleanly.
   */
  private voiceController?: { start(): void; stop(): void };
  /** Branch checked out in the primary worktree, shown in the pinned header. */
  private currentBranch: string | undefined;
  private branchTimer?: ReturnType<typeof setInterval>;
  private agentInitialized = false;
  private mcpNames: string[] = [];
  private commands: CommandChoice[] = [];
  private customCommands: CustomCommand[] = [];
  private queue: QueuedPrompt[] = [];
  /** Queue entry currently loaded into the editor for editing, with its slot. */
  private editingQueue: { index: number; prompt: QueuedPrompt } | undefined;
  private sending = false;
  /** True while a queued slash command is executing. */
  private queueBusy = false;
  /** User-message count when the last queued prompt was dispatched. */
  private queueDispatchedAt = -1;
  /** Pending debounced queue flush. */
  private queueFlushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pending debounced draft save, and the session it belongs to. */
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private draftTimerSession: string | undefined;
  /** Client-side `!` shell history for the active session, persisted on exit. */
  private sessionBash: StoredBash[] = [];
  /** Steered prompts awaiting their transcript user message, to fold into the run. */
  private pendingSteers: Array<{ text: string; at: number }> = [];
  private shellCwd: string;
  private shellProcess: ReturnType<typeof spawn> | undefined;
  private title = "";
  private titleGenerating = false;
  private pendingTitleSource: string | undefined;
  private statusText = "";
  private statusGenerating = false;
  private lastStatusAt = 0;
  private lastTitleAt = 0;
  private wasBusy = false;
  private skillEntries: SkillEntry[] = [];
  private skillNames: string[] = [];
  private pendingResourcesRefresh = false;
  private timer: NodeJS.Timeout | undefined;
  private resolveDone: (() => void) | undefined;
  private done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(private options: AppOptions) {
    this.hideThinking = options.settings.hideThinkingBlock ?? true;
    this.model = options.model;
    // Restore a resumed session's stored title; a fresh session stays untitled.
    this.title = usableSessionTitle(options.controller.title);
    this.skillEntries = listSkills(this.options.cwd);
    this.skillNames = this.skillEntries.map((skill) => skill.name);

    try {
      initPiTheme(typeof options.settings.theme === "string" ? options.settings.theme : undefined, false);
    } catch {
      // Falls back to the built-in theme.
    }
    const thinking = typeof options.settings.defaultThinkingLevel === "string" ? options.settings.defaultThinkingLevel : "medium";
    this.thinkingLevel = thinking;
    const borderColor = theme().getThinkingBorderColor(thinking);

    const fullscreen = options.settings.tuiMode !== "regular";
    const terminal = new ProcessTerminal();
    this.tui = fullscreen
      ? new TuiAltScreen(terminal, false, undefined, {
          // Fullscreen owns the jump-to-end pill: it composites on the last row
          // of the transcript clip (just above the dock) and tracks the input
          // height, unlike a screen-anchored overlay.
          scrollToEndIndicator: () =>
            theme().bg("selectedBg", theme().fg("text", ScrollToBottomButton.LABEL)),
          copyOnSelect: options.settings.fullscreenCopyOnSelect !== false,
          copySelection: async (selection: string) => {
            try {
              await copyToClipboard(selection);
              // Drop the selection highlight once the text has been copied.
              const viewport = this.tui as unknown as { clearTextSelection?: () => void };
              viewport.clearTextSelection?.();
              this.tui.requestRender();
              return true;
            } catch {
              return false;
            }
          },
          openUrl: openExternal,
        })
      : new TuiMainScreen(terminal, false);
    this.tui.setClearOnShrink?.(true);

    this.editor = new Editor(this.tui, getEditorTheme(), { paddingX: this.editorPadding() });
    this.editor.borderColor = borderColor;
    this.shellCwd = options.cwd;
    this.editor.onSubmit = (text, imageAttachments) => void this.handleSubmit(text, imageAttachments);
    this.editor.onChange = (text: string) => {
      // Only a real shell command ("! " / "!! ") colors the border; deleting the
      // space leaves "!cmd", which is sent as a normal prompt, so revert. Voice
      // dictation keeps the border blue while it is listening.
      this.applyEditorBorderColor(text);
      this.scheduleDraftSave();
      this.tui.requestRender();
    };
    this.installAutocomplete();

    this.sessionHeader = new SessionHeader(
      () => ({
        title: this.currentTitle(),
        status: this.computeStatus(),
        path: formatCwdForFooter(this.options.cwd.replace(/[\x00-\x1f\x7f]/g, "?"), homedir()),
        branch: this.currentBranch,
        resources: `${this.skillNames.length} skills • ${this.mcpNames.length} mcps`,
        hidden: !this.terminalTitleEnabled(),
      }),
      () => rowPad(options.cwd),
    );
    this.header = new StartupHeader(
      () => ({
        contextPaths: this.contextPaths(),
        // No agent cycling anymore, so list every agent (not just primaries),
        // grouped entry points / subagents / utilities.
        agentGroups: this.agentGroups,
        skills: this.headerSkills(),
        mcpNames: this.mcpNames,
        version: VERSION,
      }),
      () => rowPad(options.cwd),
    );
    this.transcriptOptions.hideThinking = this.hideThinking;
    this.transcriptOptions.expandedTools = this.expandedTools;
    this.transcriptView = new TranscriptMessages(
      options.controller.transcript,
      this.transcriptOptions,
      () => rowPad(options.cwd),
      options.cwd,
      borderColor,
      this.tui,
    );
    // pi seeds the context slot from the branch on startup; mirror that with
    // whatever the resumed transcript already contains.
    this.showContext = this.hasContextUsage();

    const document = new Container();
    document.addChild(this.header);
    document.addChild(this.transcriptView);
    // The working status is rendered inside the transcript, right after the
    // in-flight run, so a pending steer keeps it above the steer message.
    this.transcriptView.setStatus(
      new WorkingIndicator(
        (width) => this.workingStatus(width),
        () => SPINNER_FRAMES[this.spinnerIndex]!,
        () => rowPad(options.cwd),
        () => this.liveExpandedFor,
        (id) => {
          this.liveExpandedFor = this.liveExpandedFor === id ? undefined : id;
          this.tui.requestRender();
        },
      ),
    );

    const pendingMessages = new Container();
    pendingMessages.addChild(new QueuedMessages(() => this.queue, () => rowPad(options.cwd), (index) => this.editQueued(index)));
    const status = new Container();
    status.addChild(
      new ScrollToBottomOverlay(
        () => this.tui,
        () => !(this.tui as TuiAltScreen).isFollowingOutput,
      ),
    );
    this.editorDock = new FramedEditorDock(() => rowPad(options.cwd));
    this.mountEditor();
    this.footer = new FooterComponent(() => this.footerData(), () => rowPad(options.cwd));
    const footerContainer = new Container();
    footerContainer.addChild(this.footer);

    // Pad the queue/steer block on the side its surrounding dock separator does
    // not already cover, so the queue sits one blank row off the transcript.
    const viewportMode = isViewportTUI(this.tui);
    // Fullscreen dock: its own separator sits ABOVE the queue, so the queue needs
    // no extra row before the input box. Regular mode still gets a bottom blank
    // via the always-present BlankLine added below.
    const pendingBlock = viewportMode
      ? pendingMessages
      : new PaddedBlock(pendingMessages, "top");

    if (viewportMode) {
      const viewport = createChatViewport({
        header: this.sessionHeader,
        document,
        pendingMessages: pendingBlock,
        status,
        editor: this.editorDock,
        footer: footerContainer,
        scrollbar: typeof options.settings.fullscreenScrollbar === "string" ? (options.settings.fullscreenScrollbar as "hidden" | "auto" | "always") : "auto",
        scrollbarTrackStyle: (text) => theme().fg("scrollbarTrack", text),
        scrollbarThumbStyle: (text) => theme().fg("scrollbarThumb", text),
      });
      this.scrollView = viewport.transcript;
      (this.tui as ViewportTUI).setLayoutRoot(viewport.root);
    } else {
      this.tui.addChild(this.sessionHeader);
      this.tui.addChild(document);
      this.tui.addChild(pendingBlock);
      this.tui.addChild(new BlankLine());
      this.tui.addChild(this.editorDock);
      this.tui.addChild(footerContainer);
    }

    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => this.handleGlobalKey(data));
    if (this.title) this.applyTerminalTitle(this.title);
  }

  async run(): Promise<void> {
    // Restore the session's working directory and `!` output, plus any unsent
    // input, before the first paint.
    await this.restoreSessionShellState(this.options.controller.id);
    this.restoreDraft(this.options.controller.id);
    this.tui.start();
    this.watchSettings();
    // A resumed session has no editor history yet; seed it from its prompts.
    this.seedHistoryFromTranscript();
    // Resolve the configured display currency (default/location/code) before
    // the first footer paint; it may fetch an exchange rate.
    void applyCurrencySetting(this.options.settings.currency).then(() => this.tui.requestRender());
    // Warm the agent-stats cache shortly after startup, then keep it fresh in the
    // background so `/stats` opens instantly with near-current numbers.
    const warmStats = setTimeout(() => void this.refreshStatsInBackground(), 5000);
    warmStats.unref?.();
    this.statsTimer = setInterval(() => void this.refreshStatsInBackground(), 10 * 60_000);
    this.statsTimer.unref?.();
    this.options.controller.transcript.subscribe(() => {
      // Debounce follow-up dispatch: a transient idle between steps must not
      // flush the whole queue at once.
      if (this.options.controller.transcript.phase === "idle") this.scheduleQueueFlush();
      else this.cancelQueueFlush();
      this.tagSteers();
      this.syncOverlays();
      this.trackGeneration();
      const busy = this.options.controller.transcript.phase === "busy";
      if (busy) {
        this.maybeGenerateStatus();
      } else if (this.wasBusy) {
        // Back to idle: clear the live status and release the helper session.
        this.statusText = "";
        this.lastStatusAt = 0;
        this.lastTitleAt = 0;
        this.options.controller.disposeHelper();
      }
      this.wasBusy = busy;
      this.pendingResourcesRefresh = true;
      // The scroll view follows the end on its own. Forcing it on every update
      // made the transcript snap back to the bottom (effectively an endless
      // scroll) even after the user scrolled up to read history.
      this.tui.requestRender();
    });
    await this.loadAgents();
    void this.loadRest();
    // Track the checkout's branch for the header; polled because the branch can
    // change outside Midas (a shell `git switch`, or an autonomous promotion).
    void this.refreshBranch();
    this.branchTimer = setInterval(() => void this.refreshBranch(), 2000);
    this.branchTimer.unref?.();
    this.timer = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
      if (this.options.controller.transcript.phase !== "idle") this.tui.requestRender();
    }, 80);
    // Ease the t/s display ~18% every 25ms so the footer fills in between
    // provider samples instead of jumping, then settles on the measured value.
    this.rateTimer = setInterval(() => {
      if (this.rateDisplay.step(this.displayTps)) this.tui.requestRender();
    }, 25);
    this.rateTimer.unref?.();
    await this.done;
  }

  /**
   * Mirror pi's footer stats from opencode's message snapshots: one generation
   * per assistant message, character deltas while streaming, and a usage-based
   * settle on completion. midas receives full snapshots (not deltas), so the delta
   * is derived from the streamed text/reasoning/tool-argument lengths.
   */
  private trackGeneration(): void {
    const messages = this.options.controller.transcript.messages;
    let current: MessageView | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "assistant" && !message.notice && !message.hidden) {
        current = message;
        break;
      }
    }
    if (!current || current.error) return;
    // A completed message we never started tracking (resumed history) is settled
    // by the transcript itself; don't spin up a bogus generation for it.
    if (current.completed && current.id !== this.activeAssistantId) return;
    const now = performance.now();
    // Match pi: character-based live estimates only for explicitly
    // non-reasoning models; reasoning models settle on provider usage.
    const allowLiveEstimate = this.effectiveModel()?.reasoning === false;
    if (current.id !== this.activeAssistantId) {
      this.generation++;
      this.activeAssistantId = current.id;
      this.streamedChars = 0;
      this.generationRate.start(`${current.providerID ?? ""}/${current.modelID ?? ""}`, now, allowLiveEstimate);
      this.liveContext.start(this.contextUsage());
    }
    const chars = streamedCharsOf(current);
    if (chars > this.streamedChars) {
      const delta = chars - this.streamedChars;
      this.streamedChars = chars;
      this.generationRate.add(delta, now);
      this.liveContext.update({ type: "text_delta", delta: "x".repeat(delta) });
      this.showContext = true;
    }
    const usage = {
      input: current.tokens.input,
      output: current.tokens.output,
      cacheRead: current.tokens.cacheRead,
      cacheWrite: current.tokens.cacheWrite,
    };
    this.liveContext.update({}, usage);
    if (usage.input > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0) this.showContext = true;
    if (current.completed) {
      this.generationRate.finish(current.tokens.output, allowLiveEstimate, now);
      this.activeAssistantId = undefined;
    }
    this.displayTps = this.generationRate.rate;
  }

  /** pi resets live context, rate animation and generation on model change. */
  private resetStats(): void {
    this.liveContext.clear();
    this.contextDisplay.clear();
    this.generation++;
    this.displayTps = null;
    this.rateDisplay.reset();
    this.activeAssistantId = undefined;
    this.streamedChars = 0;
  }

  private hasContextUsage(): boolean {
    return this.options.controller.transcript.messages.some(
      (message) =>
        message.role === "assistant" &&
        (message.tokens.input > 0 || message.tokens.cacheRead > 0 || message.tokens.cacheWrite > 0),
    );
  }

  /**
   * Record the grouped agent list (header display) and the cycleable subset
   * (primary agents only). Mode selection is through /multitask.
   */
  private applyAgents(agents: AgentChoice[]): void {
    this.agentCatalog = agents;
    this.agentGroups = groupAgentNames(agents);
    this.agentChoices = selectableAgentNames(agents);
  }

  /** Bound a catalog request so a stalled backend cannot wedge startup or /reload. */
  private withTimeout<T>(operation: Promise<T>, ms = 15_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Catalog request timed out after ${ms}ms`)), ms);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Fast startup path: agents + custom commands, so the header fills instantly. */
  private async loadAgents(): Promise<void> {
    this.customCommands = loadCustomCommands(this.options.cwd);
    try {
      this.applyAgents(await this.withTimeout(this.options.controller.listAgents()));
    } catch {
      this.agentGroups = [];
      this.agentChoices = [];
    }
    // Mode is session-local. Ignore the old cycle/defaultAgent setting, and do
    // not reset an explicit /multitask selection when reloading catalogs.
    if (!this.agentInitialized) {
      this.activeAgent = this.options.agent === BOARD_WORKER_AGENT ? DEFAULT_AGENT : this.options.agent ?? DEFAULT_AGENT;
      this.agentInitialized = true;
    }
    this.options.controller.setAgent(this.activeAgent);
    this.syncDispatcher();
    if (!this.activeOverlay) this.mountEditor();
    this.installAutocomplete();
    this.tui.requestRender();
  }

  /** Slower catalogs (commands, MCPs, models) load after the first render. */
  private async loadRest(): Promise<void> {
    try {
      this.commands = (await this.withTimeout(this.options.controller.listCommands())).filter(
        (command) => !HIDDEN_COMMANDS.has(command.name),
      );
    } catch {
      this.commands = [];
    }
    this.installAutocomplete();
    try {
      this.setMcpNames(await this.withTimeout(this.options.controller.mcpServerNames()));
    } catch {
      this.setMcpNames([]);
    }
    try {
      this.models = await this.withTimeout(this.options.controller.listModels());
    } catch {
      this.models = [];
    }
    // Prefer the model last used in midas (or pi), then opencode's configured
    // default, so a launch resumes where the user left off rather than the
    // provider default.
    if (!this.model) {
      const last = readLastSelectedModel();
      if (last) {
        const known =
          this.models.find((m) => m.providerID === last.providerID && m.modelID === last.modelID) ??
          this.models.find((m) => m.modelID === last.modelID);
        this.model = known ?? {
          providerID: last.providerID,
          modelID: last.modelID,
          name: last.name ?? last.modelID,
          providerName: last.providerID,
        };
      }
    }
    if (!this.model) {
      const fallback = await this.withTimeout(this.options.controller.defaultModel());
      if (fallback) {
        const known = this.models.find((m) => m.providerID === fallback.providerID && m.modelID === fallback.modelID);
        this.model = known ?? { ...fallback, name: fallback.modelID, providerName: fallback.providerID };
      }
    }
    this.handleModelUpdate();
    this.syncControllerModel();
    if (this.pendingTitleSource) this.maybeGenerateTitle(true, this.pendingTitleSource);
    this.tui.requestRender();
  }

  /** Editor inner padding tracks the Padding setting as `padding - 1` (min 0). */
  private editorPadding(): number {
    return Math.max(0, rowPad(this.options.cwd) - 1);
  }

  /** Re-render when pi settings change (outputPad, editorPaddingX, theme...). */
  private watchedSettings: string[] = [];

  private watchSettings(): void {
    const paths = [join(piAgentDir(), "settings.json"), join(this.options.cwd, ".pi", "settings.json")];
    for (const path of paths) {
      watchFile(path, { interval: 400 }, () => {
        this.transcriptView.invalidate();
        this.tui.requestRender();
      });
      this.watchedSettings.push(path);
    }
  }

  private contextPaths(): string[] {
    const candidates = [
      join(midasProjectDir(this.options.cwd), "AGENTS.md"),
      join(agentsProjectDir(this.options.cwd), "AGENTS.md"),
      join(midasConfigDir(), "AGENTS.md"),
      join(agentsGlobalDir(), "AGENTS.md"),
      join(this.options.cwd, "AGENTS.md"),
    ];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const formatted = this.formatContextPath(candidate);
      if (seen.has(formatted)) continue;
      seen.add(formatted);
      result.push(formatted);
    }
    return result;
  }

  private formatContextPath(path: string): string {
    const cwd = resolve(this.options.cwd);
    const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    const globalDirs = [resolve(midasConfigDir()), resolve(agentsGlobalDir())];
    const inside = (parent: string, target: string): boolean => {
      const rel = relative(parent, target);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    if (globalDirs.some((dir) => inside(dir, absolute))) {
      const rel = relative(homedir(), absolute);
      return `~${sep}${rel}`;
    }
    const rel = relative(cwd, absolute);
    if (rel === "") return "./";
    if (rel.startsWith("./") || rel.startsWith("../")) return rel;
    return `./${rel}`;
  }

  private currentThinking(): string {
    return this.thinkingLevel;
  }

  private setActiveAgent(name: string): void {
    this.activeAgent = name;
    this.options.controller.setAgent(name);
    // Each agent can run a different model; adopt it and its reasoning level.
    this.syncControllerModel();
    const model = this.effectiveModel();
    if (model) this.restoreThinkingForModel(model.providerID, model.modelID);
    this.resetStats();
    this.syncDispatcher();
    // The input frame's "Multitask" title follows the mode.
    if (!this.activeOverlay) this.mountEditor();
    this.tui.requestRender();
  }

  /** Explicit per-agent model overrides stored in midas settings. */
  private agentModelMap(): Record<string, string> {
    const value = this.options.settings.agentModels;
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, string>) }
      : {};
  }

  private setAgentModel(agent: string, model: string | undefined): void {
    const map = this.agentModelMap();
    if (model) map[agent] = model;
    else delete map[agent];
    (this.options.settings as Record<string, unknown>).agentModels = map;
    updateGlobalSetting("agentModels", map);
    if (agent === this.activeAgent) {
      this.syncControllerModel();
      const effective = this.effectiveModel();
      if (effective) this.restoreThinkingForModel(effective.providerID, effective.modelID);
      this.resetStats();
    }
    this.tui.requestRender();
  }

  private resolveModelRef(ref: string | undefined): ModelChoice | undefined {
    if (!ref || !ref.includes("/")) return undefined;
    const slash = ref.indexOf("/");
    const providerID = ref.slice(0, slash);
    const modelID = ref.slice(slash + 1);
    return (
      this.models.find((m) => m.providerID === providerID && m.modelID === modelID) ?? {
        providerID,
        modelID,
        name: modelID,
        providerName: providerID,
      }
    );
  }

  /** The model actually used: the active agent's override, else the global one. */
  private effectiveModel(): ModelChoice | undefined {
    return this.resolveModelRef(this.agentModelMap()[this.activeAgent]) ?? this.model;
  }

  private syncControllerModel(): void {
    const model = this.effectiveModel();
    if (model) this.options.controller.setModel({ providerID: model.providerID, modelID: model.modelID });
  }

  private cycleThinking(): void {
    const index = THINKING_LEVELS.indexOf(this.thinkingLevel);
    const next = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length]!;
    this.setThinkingLevel(next);
  }

  /**
   * Model used by the title/status helper. Prefers an explicit `titleModel`
   * setting, otherwise falls back to the active model so titles and statuses
   * work without extra configuration.
   */
  private titleModelSetting(): string {
    // The title agent is just another agent: an override in /agents wins.
    const override = this.agentModelMap()["title"];
    const value = override ?? this.options.settings.titleModel;
    if (typeof value === "string" && value.includes("/")) {
      const [providerID, ...rest] = value.split("/");
      const modelID = rest.join("/");
      if (
        this.models.length === 0 ||
        this.models.some((m) => m.providerID === providerID && m.modelID === modelID)
      ) {
        return value;
      }
    }
    return this.model ? `${this.model.providerID}/${this.model.modelID}` : "";
  }

  private titleMaxWords(): number {
    const value = this.options.settings.titleMaxWords;
    return typeof value === "number" && value > 0 ? Math.floor(value) : 5;
  }

  private titleModelChoice(): { providerID: string; modelID: string } | undefined {
    const raw = this.titleModelSetting();
    const slash = raw.indexOf("/");
    if (slash < 0) return undefined;
    return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
  }

  /** The generated overview title, defaulting to "New Session" before anything is sent. */
  private currentTitle(): string {
    return this.title || "New Session";
  }

  /** Live status of what the agent is doing right now. */
  private computeStatus(): string {
    const transcript = this.options.controller.transcript;
    const last = this.lastPart();
    if (last?.kind === "bash" && last.status === "running") {
      return this.statusText || `Running: ${last.command.replace(/\s+/g, " ").slice(0, 60)}`;
    }
    if (transcript.phase === "idle") return "Idle";
    if (transcript.permissions.length > 0) return this.statusText || "Waiting for approval";
    if (transcript.phase === "retry") return this.workingStatus()?.label || this.statusText || "Retrying";
    return this.statusText || this.mechanicalStatus(last);
  }

  private mechanicalStatus(last: PartView | undefined): string {
    if (last?.kind === "tool" && (last.status === "running" || last.status === "pending")) return this.toolStatusLabel(last);
    if (last?.kind === "reasoning") return "Thinking";
    if (last?.kind === "text") return "Writing";
    return "Working";
  }

  /**
   * The single live action line: it reports the action currently in progress
   * ("Writing command", "Running …", "Reading …", "Thinking for Xs") and falls
   * back to a generic "Working" between actions. Completed results never appear
   * here — they live in the transcript's tool chain.
   */
  private workingStatus(
    width = 100,
  ): { id: string; label: string; tone?: "thinking" | "running"; detail?: string } | undefined {
    const transcript = this.options.controller.transcript;
    const now = Date.now();
    if (transcript.phase === "idle") {
      this.workingSince = undefined;
      this.retryStartedAt = undefined;
      return undefined;
    }
    if (transcript.phase === "retry") {
      this.retryStartedAt ??= now;
      return { id: "retry", label: `Retrying for ${formatSeconds(now - this.retryStartedAt)}`, tone: "thinking" };
    }
    this.retryStartedAt = undefined;
    if (transcript.permissions.length > 0) {
      return { id: "permission", label: "Waiting for approval", tone: "thinking" };
    }
    // Scan newest-first for an in-flight action. Trailing placeholder parts
    // (snapshots, step markers, empty text) must not mask a running tool, and a
    // running read/edit should win over a generic "Working".
    let fallback: PartView | undefined;
    for (let i = transcript.messages.length - 1; i >= 0; i--) {
      const message = transcript.messages[i]!;
      if (message.role !== "assistant" || message.notice) continue;
      for (let j = message.parts.length - 1; j >= 0; j--) {
        const part = message.parts[j]!;
        if (part.kind === "tool" && (part.status === "running" || part.status === "pending")) {
          this.workingSince = undefined;
          return { id: part.id, label: toolLiveText(part, this.options.cwd, width), tone: "running" };
        }
        if (part.kind === "bash" && part.status === "running") {
          this.workingSince = undefined;
          return {
            id: part.id,
            label: `Running \`${part.command.replace(/\s+/g, " ").slice(0, 60)}\``,
            tone: "running",
          };
        }
        if (part.kind === "reasoning" && !part.ended) {
          this.workingSince = undefined;
          const since = part.startedAt ?? now;
          return {
            id: part.id,
            label: `Thinking for ${formatSeconds(now - since)}`,
            tone: "thinking",
            detail: part.text,
          };
        }
        if (fallback) continue;
        if (part.kind === "text") {
          if (part.text.trim().length > 0) fallback = part;
        } else if (part.kind === "tool" || part.kind === "bash" || (part.kind === "reasoning" && part.ended)) {
          fallback = part;
        }
      }
      if (fallback) break;
    }
    if (fallback?.kind === "text") {
      this.workingSince = undefined;
      const lines = this.writtenLines(fallback.text, width);
      return {
        id: fallback.id,
        label: `Writing ${lines} line${lines === 1 ? "" : "s"}`,
        tone: "thinking",
      };
    }
    // Finished work carries no result here; the line only reports what is active.
    const id = fallback?.id ?? "working";
    if (!this.workingSince || this.workingSince.id !== id) {
      this.workingSince = { id, at: fallback?.kind === "tool" ? (fallback.end ?? now) : now };
    }
    return { id, label: `Working for ${formatSeconds(now - this.workingSince.at)}`, tone: "thinking" };
  }

  /** Visible line count of streaming prose at the given terminal width. */
  private writtenLines(text: string, width: number): number {
    const available = Math.max(8, width - 4);
    let lines = 0;
    for (const paragraph of text.replace(/\r\n/g, "\n").split("\n")) {
      if (paragraph.trim().length === 0) continue;
      lines += Math.max(1, Math.ceil(visibleWidth(paragraph) / available));
    }
    return lines;
  }

  /** Ask the title agent for a short status phrase, throttled. */
  private maybeGenerateStatus(): void {
    const transcript = this.options.controller.transcript;
    if (transcript.phase !== "busy") return;
    if (this.statusGenerating) return;
    const now = Date.now();
    if (now - this.lastStatusAt < 6000) return;
    const model = this.titleModelChoice();
    if (!model || this.models.length === 0) return;
    if (!this.models.some((m) => m.providerID === model.providerID && m.modelID === model.modelID)) return;
    const context = this.progressContext();
    if (!context.trim()) return;
    this.statusGenerating = true;
    this.lastStatusAt = now;
    void this.options.controller
      .generateStatus(context, model, 6)
      .then((status) => {
        // Never let the status duplicate the title; that reads as a stuck line.
        if (status && status.trim().toLowerCase() !== this.title.trim().toLowerCase()) {
          this.statusText = status;
          this.tui.requestRender();
        }
      })
      .catch(() => {
        // Status is best-effort.
      })
      .finally(() => {
        this.statusGenerating = false;
      });
  }

  /**
   * Overarching-goal context for the title: the original and latest user
   * requests, with no tool, assistant, or agent detail.
   */
  private goalContext(): string {
    const messages = this.options.controller.transcript.messages.filter((message) => !message.notice && !message.hidden);
    const requests = messages
      .filter((message) => message.role === "user")
      .map((message) => this.messageText(message))
      .filter(Boolean);
    const lines: string[] = [];
    const first = requests[0];
    if (first) lines.push(`Original request: ${first.slice(0, 400)}`);
    const last = requests[requests.length - 1];
    if (last && last !== first) lines.push(`Latest request: ${last.slice(0, 400)}`);
    return lines.join("\n");
  }

  /**
   * Progress context for the live status: the goal plus what has been achieved.
   * Tool names, commands and agent labels are deliberately excluded so the
   * status reads as progress toward the goal, not a log of activity.
   */
  private progressContext(): string {
    const messages = this.options.controller.transcript.messages.filter((message) => !message.notice && !message.hidden);
    const lines: string[] = [];
    if (this.title) lines.push(`Goal: ${this.title}`);
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (lastUser) lines.push(`User request: ${this.messageText(lastUser).slice(0, 400)}`);
    const assistantText = messages
      .filter((message) => message.role === "assistant")
      .map((message) => this.messageText(message))
      .filter(Boolean)
      .slice(-2)
      .join(" ");
    if (assistantText) lines.push(`Progress so far: ${assistantText.slice(0, 600)}`);
    return lines.join("\n");
  }

  private lastPart(): PartView | undefined {
    const messages = this.options.controller.transcript.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const parts = messages[i]!.parts;
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]!;
        if (part.kind === "text" || part.kind === "reasoning" || part.kind === "tool" || part.kind === "bash") return part;
      }
    }
    return undefined;
  }

  private toolStatusLabel(tool: Extract<PartView, { kind: "tool" }>): string {
    const input = tool.input;
    const target = String(
      input.filePath ?? input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.query ?? "",
    )
      .replace(/\s+/g, " ")
      .slice(0, 50);
    const verbs: Record<string, string> = {
      read: "Reading",
      bash: "Running",
      shell: "Running",
      edit: "Editing",
      write: "Writing",
      grep: "Searching",
      glob: "Finding",
      list: "Listing",
      ls: "Listing",
      webfetch: "Fetching",
    };
    const verb = verbs[tool.tool] ?? `Running ${tool.tool}`;
    if (!target) return verb;
    if (tool.tool === "bash" || tool.tool === "shell") return `${verb} \`${target}\``;
    return `${verb} ${target}`;
  }

  private maybeGenerateTitle(force = false, sourceOverride?: string): void {
    if (this.titleGenerating) return;
    if (!force && Date.now() - this.lastTitleAt < 20_000) return;
    const model = this.titleModelChoice();
    if (!model) return;
    if (this.models.length === 0) {
      if (sourceOverride) this.pendingTitleSource = sourceOverride;
      return;
    }
    if (!this.models.some((m) => m.providerID === model.providerID && m.modelID === model.modelID)) {
      this.pendingTitleSource = undefined;
      return;
    }
    const goal = this.goalContext();
    const request = sourceOverride ?? this.pendingTitleSource;
    const context = request
      ? goal
        ? `${goal}\nNew request: ${request.slice(0, 400)}`
        : `Original request: ${request.slice(0, 400)}`
      : goal;
    if (!context.trim()) return;
    this.pendingTitleSource = undefined;
    this.lastTitleAt = Date.now();
    this.titleGenerating = true;
    const maxWords = this.titleMaxWords();
    void this.options.controller
      .generateTitle(context, model, maxWords)
      .then((title) => {
        if (title) {
          this.title = title;
          this.applyTerminalTitle(title);
          // Persist so the title survives exit and shows in the session picker.
          void this.options.controller.setTitle(title).catch(() => {
            // Persisting is best-effort; the in-memory title still applies.
          });
          this.recordMidasSession();
          this.tui.requestRender();
        }
      })
      .catch(() => {
        // Title generation is best-effort; the placeholder stays.
      })
      .finally(() => {
        this.titleGenerating = false;
      });
  }

  private resetTitle(): void {
    this.title = "";
    this.titleGenerating = false;
    this.pendingTitleSource = undefined;
    this.lastTitleAt = 0;
    this.statusText = "";
    this.lastStatusAt = 0;
    this.applyTerminalTitle("");
  }

  /** Terminal titles are opt-out and always limited to two words. */
  private terminalTitleEnabled(): boolean {
    return this.options.settings.terminalTitle !== false;
  }

  private applyTerminalTitle(text: string): void {
    if (!this.terminalTitleEnabled()) return;
    const title = text.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
    try {
      this.tui.terminal.setTitle(title);
    } catch {
      // Terminal may not support titles.
    }
  }

  private toggleMultitask(args: string): void {
    if (args && args !== "on" && args !== "off") { this.fail("Usage: /multitask [on|off]"); return; }
    const next = args === "on" ? ORCHESTRATOR_AGENT : args === "off" ? DEFAULT_AGENT : this.activeAgent === ORCHESTRATOR_AGENT ? DEFAULT_AGENT : ORCHESTRATOR_AGENT;
    if (!this.agentChoices.includes(next)) { this.fail(`Agent '${next}' is unavailable. Check agent configuration and restart Midas.`); return; }
    this.setActiveAgent(next);
  }

  /**
   * Border color precedence: voice dictation (blue) wins while listening, then
   * a real shell command, then the active thinking level.
   */
  private applyEditorBorderColor(text: string = this.editor.getText()): void {
    // Only a bang at the very start is shell mode; a leading space keeps it a
    // normal prompt (and the thinking border), matching `parseShellCommand`.
    const bash = text.startsWith("! ") || text.startsWith("!! ");
    this.editor.borderColor = this.voiceActive
      ? (value: string) => theme().fg("accent", value)
      : bash
        ? (value: string) => theme().fg("bashMode", value)
        : theme().getThinkingBorderColor(this.currentThinking());
  }

  private toggleVoice(args: string): void {
    const next = voiceToggle(args, this.voiceActive);
    if (next === undefined) { this.fail("Usage: /voice [on|off]"); return; }
    this.setVoiceActive(next);
  }

  /**
   * Enter or leave `/voice` dictation. Rebuilds the input frame (title + blue
   * border) and starts/stops the optional speech controller; the existing input
   * text is left untouched.
   */
  private setVoiceActive(active: boolean): void {
    this.voiceActive = active;
    if (active) this.voiceController?.start();
    else this.voiceController?.stop();
    this.applyEditorBorderColor();
    this.mountEditor();
    this.options.controller.transcript.addNotice(
      active ? "Voice listening — speak to dictate. Esc to exit." : "Voice dictation off.",
    );
    this.tui.requestRender();
  }

  /**
   * Seam for a streaming speech-to-text controller: `committed` is finalized
   * text, `partial` is the in-progress tail. Voice is text-only, so replacing
   * the input drops any image chips.
   */
  private applyVoiceTranscript(committed: string, partial: string): void {
    this.editor.setText(`${committed}${partial}`);
    this.tui.requestRender();
  }

  private setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
    const model = this.effectiveModel();
    if (model) updateModelThinkingLevel(model.providerID, model.modelID, level);
    this.options.controller.transcript.addRecord(`Thinking: ${level}`);
    this.editor.borderColor = theme().getThinkingBorderColor(level);
    this.transcriptView.invalidate();
    this.tui.requestRender();
  }

  private handleModelUpdate(): void {
    const info = this.lastModelInfo();
    if (info) {
      const known = this.models.find((m) => m.providerID === info.providerID && m.modelID === info.modelID);
      if (known) {
        this.model = known;
      } else if (!this.model) {
        this.model = { providerID: info.providerID, modelID: info.modelID, name: info.modelID, providerName: info.providerID };
      }
    }
    if (this.model) {
      this.thinkingLevel = thinkingLevelFor(loadPiSettings(this.options.cwd), this.model.providerID, this.model.modelID);
    }
    this.editor.borderColor = theme().getThinkingBorderColor(this.currentThinking());
  }

  /** Restore the reasoning level last used with a model without persisting it. */
  private restoreThinkingForModel(providerID: string, modelID: string): void {
    this.thinkingLevel = thinkingLevelFor(loadPiSettings(this.options.cwd), providerID, modelID);
    this.editor.borderColor = theme().getThinkingBorderColor(this.currentThinking());
    this.transcriptView.invalidate();
    this.tui.requestRender();
  }

  private lastModelInfo(): { providerID: string; modelID: string } | undefined {
    const messages = this.options.controller.transcript.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "assistant" && message.providerID && message.modelID) {
        return { providerID: message.providerID, modelID: message.modelID };
      }
    }
    return this.model ? { providerID: this.model.providerID, modelID: this.model.modelID } : undefined;
  }

  /** Snapshot of the unsent input, including image chips, for persistence. */
  private currentDraft(): StoredDraft {
    const text = this.editor.getText();
    const attachments =
      typeof this.editor.getImageAttachments === "function" ? this.editor.getImageAttachments() : [];
    return { text, ...(attachments.length > 0 ? { attachments } : {}) };
  }

  /**
   * Persist the current input draft for the active session. Non-empty drafts are
   * debounced while typing; emptying the input removes the draft immediately.
   */
  private scheduleDraftSave(): void {
    const sessionId = this.options.controller.id;
    if (!sessionId) return;
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = undefined;
    }
    const draft = this.currentDraft();
    if (draft.text.length === 0 && (draft.attachments?.length ?? 0) === 0) {
      this.draftTimerSession = undefined;
      writeDraft(sessionId, draft);
      return;
    }
    this.draftTimerSession = sessionId;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined;
      const target = this.draftTimerSession;
      this.draftTimerSession = undefined;
      // A session switch already flushed this draft; don't write it to the new one.
      if (target && target === this.options.controller.id) writeDraft(target, this.currentDraft());
    }, 400);
    this.draftTimer.unref?.();
  }

  /** Flush a pending draft save and persist the input right now. */
  private saveDraftNow(): void {
    const sessionId = this.draftTimerSession ?? this.options.controller.id;
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = undefined;
    }
    this.draftTimerSession = undefined;
    if (sessionId) writeDraft(sessionId, this.currentDraft());
  }

  /** Replace the input with a session's saved draft (empty when it has none). */
  private restoreDraft(sessionId: string | undefined): void {
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = undefined;
    }
    this.draftTimerSession = undefined;
    const draft = readDraft(sessionId);
    const text = draft?.text ?? "";
    this.editor.setText(text);
    this.editor.setImageAttachments(draft?.attachments ?? []);
    this.tui.requestRender();
  }

  /** Persist the active session's working directory and `!` history. */
  private persistSessionState(): void {
    writeSessionState(this.options.controller.id, { cwd: this.options.cwd, bash: this.sessionBash });
    this.recordMidasSession();
  }

  /** Index the active session in Midas's own registry (not opencode's list). */
  private recordMidasSession(): void {
    const id = this.options.controller.id;
    if (!id) return;
    upsertMidasSession({ id, cwd: this.options.cwd, title: this.title });
  }

  /** Append a finished `!` run to the session history and persist it. */
  private recordBash(entry: StoredBash): void {
    this.sessionBash.push(entry);
    this.persistSessionState();
  }

  /**
   * Restore a session's persisted shell state: re-root at the directory it was
   * left in and replay its `!` blocks into the transcript.
   */
  private async restoreSessionShellState(sessionId: string | undefined, fallbackCwd?: string): Promise<void> {
    const state = readSessionState(sessionId);
    this.sessionBash = state?.bash ?? [];
    const target = directoryExists(state?.cwd) ? state.cwd : fallbackCwd;
    if (target && target !== this.options.cwd && directoryExists(target)) {
      await this.changeDirectory(target);
    }
    for (const entry of this.sessionBash) this.options.controller.transcript.restoreBash(entry);
    this.persistSessionState();
  }

  private async handleSubmit(
    text: string,
    imageAttachments?: Array<{ marker: string; path: string }>,
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.toLowerCase() === "exit") return this.quit();
    // A follow-up pulled from the queue for editing returns to its old slot.
    const editing = this.editingQueue;
    this.editingQueue = undefined;
    this.editor.addToHistory(trimmed);
    this.editor.setText("");
    const multitask = this.activeAgent === ORCHESTRATOR_AGENT;
    const action = submitAction({
      multitask,
      runActive: this.isRunActive(),
      isCommand: trimmed.startsWith("/"),
      editing: editing !== undefined,
    });
    if (trimmed === "/tasks") return this.openTasks();
    if (action === "command") {
      const match = trimmed.match(/^\/([^\s]+)([\s\S]*)$/);
      const typedName = match?.[1] ?? "";
      const rest = match?.[2] ?? "";
      // A partial name (e.g. "/sta") resolves to its top matching command.
      const name = this.resolveSlashName(typedName);
      const commandText = name === typedName ? trimmed : `/${name}${rest}`;
      if (this.isRunActive()) {
        // Only /compact and /reload wait for the run; they rework the session
        // the run is using. Interrupting commands are refused with a warning.
        // Every other command is local and safe to run immediately.
        if (QUEUED_COMMANDS.has(name)) {
          this.enqueue({ text: commandText, attachments: [] });
          return;
        }
        if (this.commandWouldInterrupt(name)) {
          this.flash(`/${name} can't run while the agent is working. Wait for it to finish, or press Esc to abort.`);
          return;
        }
      }
      await this.runSlashCommand(commandText);
      return;
    }
    const shell = this.shellCommand(text);
    if (shell) {
      if (!shell.command) return;
      // Shell commands queue like normal messages: while a run is active, Enter
      // holds them until it settles. cmd+enter steers them (runs them now).
      if (this.isRunActive()) {
        const queued: QueuedPrompt = { text, attachments: [] };
        if (editing) this.enqueueAt(editing.index, queued);
        else this.enqueue(queued);
        return;
      }
      await this.runShellCommand(shell.command, shell.exclude);
      return;
    }
    if (!this.title) {
      const firstLine = trimmed.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
      const heuristic = capitalize(truncateWords(firstLine.replace(/[`*_#>]/g, ""), this.titleMaxWords()));
      if (heuristic) {
        this.title = heuristic;
        this.tui.requestRender();
      }
    }
    this.maybeGenerateTitle(true, trimmed);
    // Multitask keeps the board runner alive from submissions: retry the
    // idempotent sync so a session that lost the dispatch lease takes over
    // without ever starting a second loop.
    ensureDispatcherOnSubmit(multitask, () => this.syncDispatcher());
    const prompt =
      editing && editing.prompt.text === trimmed ? editing.prompt : this.preparePrompt(trimmed, imageAttachments);
    if (action === "queue") {
      this.enqueue(prompt);
      return;
    }
    if (action === "requeue") {
      if (editing) this.enqueueAt(editing.index, prompt);
      else this.enqueue(prompt);
      return;
    }
    await this.sendPrompt(prompt.text, prompt.attachments);
  }

  /** Append to the follow-up queue and repaint its preview above the input. */
  private enqueue(prompt: QueuedPrompt): void {
    this.queue.push(prompt);
    this.tui.requestRender();
  }

  /** Insert at a specific queue slot, used when re-queuing an edited follow-up. */
  private enqueueAt(index: number, prompt: QueuedPrompt): void {
    const at = Math.max(0, Math.min(index, this.queue.length));
    this.queue.splice(at, 0, prompt);
    this.tui.requestRender();
  }

  /** Pull a queued follow-up into the editor; Enter puts it back at that slot. */
  private editQueued(index: number): void {
    if (this.activeOverlay) return;
    const item = this.queue[index];
    if (!item) return;
    this.queue.splice(index, 1);
    this.editingQueue = { index, prompt: item };
    this.editor.setText(item.text);
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  private async sendPrompt(text: string, attachments: PromptAttachment[] = []): Promise<void> {
    this.sending = true;
    // A new turn starts collapsed; the status line can reveal its process again.
    this.liveExpandedFor = undefined;
    try {
      await this.options.controller.prompt(text, attachments);
    } catch (error) {
      this.options.controller.transcript.setPhase("idle");
      // A failed dispatch must not strand the rest of the queue.
      this.queueDispatchedAt = -1;
      this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.sending = false;
    }
  }

  /**
   * Turn image chips (`[Image: name]` from the editor) and any raw image paths
   * in the prompt into real file parts (base64 data URLs), so the model receives
   * the image itself instead of a path it cannot read. Unreadable files are
   * dropped with a toast. Chips are kept in the text as a label.
   */
  private preparePrompt(
    text: string,
    imageAttachments?: Array<{ marker: string; path: string }>,
  ): QueuedPrompt {
    let body = text;
    const attachments: PromptAttachment[] = [];
    const missing: string[] = [];
    // Submit paths that clear the editor first pass the chips they resolved
    // before clearing; other callers read them straight from the editor.
    const chips =
      imageAttachments ??
      (typeof this.editor.getImageAttachments === "function" ? this.editor.getImageAttachments() : []);
    for (const chip of chips) {
      if (!body.includes(chip.marker)) continue;
      const attachment = readImageAttachment(chip.path);
      if (attachment) attachments.push(attachment);
      else missing.push(basename(chip.path));
    }
    const matches = findImagePaths(body);
    for (const match of matches) {
      const attachment = readImageAttachment(match.path);
      if (attachment) {
        attachments.push(attachment);
        body = body.replace(match.raw, `[Image: ${attachment.filename}]`);
      } else {
        body = body.replace(match.raw, "");
        missing.push(basename(match.path));
      }
    }
    if (missing.length > 0) this.fail(`Couldn't read image: ${missing.join(", ")}`);
    return { text: body.replace(/[ \t]{2,}/g, " ").trim(), attachments };
  }

  /** Run a `!` shell command locally with a persistent working directory. */
  /** Parse a leading `!`/`!!` shell command, or undefined for a normal prompt. */
  private shellCommand(text: string): ShellCommand | undefined {
    return parseShellCommand(text);
  }

  private async runShellCommand(command: string, exclude: boolean): Promise<void> {
    const transcript = this.options.controller.transcript;
    const at = Date.now();
    const id = transcript.addBash(command, exclude, at);
    let recorded = false;
    const record = (output: string, status: StoredBash["status"], exitCode?: number): void => {
      if (recorded) return;
      recorded = true;
      this.recordBash({ command, output, exclude, status, exitCode, at });
    };
    // A plain `cd` re-roots midas itself. Running the same relative `cd` again
    // inside the new directory would fail, so treat it as a successful no-op.
    const cd = this.resolveCd(command);
    if (cd) {
      transcript.finishBash(id, 0);
      await this.changeDirectory(cd);
      record("", "complete", 0);
      this.tui.requestRender();
      return;
    }
    this.tui.requestRender();

    await new Promise<void>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("bash", ["-lc", command], { cwd: this.shellCwd, env: process.env });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        transcript.appendBashOutput(id, `${message}\n`);
        transcript.finishBash(id, 1);
        record(`${message}\n`, "error", 1);
        this.tui.requestRender();
        resolve();
        return;
      }
      this.shellProcess = child;
      let output = "";
      const onData = (chunk: Buffer): void => {
        output += chunk.toString();
        transcript.appendBashOutput(id, chunk.toString());
        this.tui.requestRender();
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", (error) => {
        transcript.appendBashOutput(id, `${error.message}\n`);
        transcript.finishBash(id, 1);
        record(`${error.message}\n`, "error", 1);
        this.tui.requestRender();
      });
      child.on("close", (code) => {
        if (this.shellProcess === child) this.shellProcess = undefined;
        transcript.finishBash(id, code ?? undefined, child.killed);
        if (!exclude) transcript.addRecord(`$ ${command}\n${output.trimEnd()}`);
        const status: StoredBash["status"] = child.killed ? "cancelled" : code === 0 || code === undefined ? "complete" : "error";
        record(output, status, code ?? undefined);
        this.tui.requestRender();
        resolve();
      });
    });
  }

  private killShell(): boolean {
    if (!this.shellProcess) return false;
    this.shellProcess.kill("SIGTERM");
    return true;
  }

  /** Re-root midas at `dir`: footer path, agent working directory and resources. */
  private async changeDirectory(dir: string): Promise<void> {
    this.options.cwd = dir;
    this.shellCwd = dir;
    this.options.controller.setCwd(dir);
    this.options.controller.transcript.addRecord(`Directory: ${dir}`);
    // The board is repo-scoped; re-elect for the new directory.
    this.dispatcher?.stop();
    this.dispatcher = undefined;
    await this.reloadForDirectory();
    this.syncDispatcher();
    void this.refreshBranch();
  }

  /** Refresh the header branch; a cheap no-op until the checkout's branch changes. */
  private async refreshBranch(): Promise<void> {
    let branch: string | undefined;
    try {
      branch = (await gitAsync(this.options.cwd, "symbolic-ref", "-q", "--short", "HEAD")) || undefined;
    } catch {
      branch = undefined;
    }
    if (branch === this.currentBranch) return;
    this.currentBranch = branch;
    this.tui.requestRender();
  }

  /** Reload directory-scoped resources (skills, commands, MCPs, agents). */
  private async reloadForDirectory(): Promise<void> {
    this.refreshSkills();
    this.customCommands = loadCustomCommands(this.options.cwd);
    try {
      this.applyAgents(await this.withTimeout(this.options.controller.listAgents()));
    } catch {
      // Keep previous agent list on failure.
    }
    try {
      this.commands = (await this.withTimeout(this.options.controller.listCommands())).filter(
        (command) => !HIDDEN_COMMANDS.has(command.name),
      );
    } catch {
      // Keep previous commands on failure.
    }
    try {
      this.setMcpNames(await this.withTimeout(this.options.controller.mcpServerNames()));
    } catch {
      this.setMcpNames([]);
    }
    this.installAutocomplete();
    this.tui.requestRender();
  }

  /** If the command is a plain `cd`, return the resolved directory. */
  private resolveCd(command: string): string | undefined {
    return resolveCdTarget(command, this.shellCwd, (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
  }

  /** When the run finishes, run the next queued command, then the next prompt. */
  /** Debounce the queue flush so a transient idle between steps can't dispatch. */
  private scheduleQueueFlush(): void {
    if (this.queueFlushTimer) return;
    const timer = setTimeout(() => {
      this.queueFlushTimer = undefined;
      this.maybeFlushQueue();
    }, 400);
    timer.unref?.();
    this.queueFlushTimer = timer;
  }

  private cancelQueueFlush(): void {
    if (!this.queueFlushTimer) return;
    clearTimeout(this.queueFlushTimer);
    this.queueFlushTimer = undefined;
  }

  /** A run is active while busy, or during the settle window before a flush. */
  private isRunActive(): boolean {
    return this.options.controller.transcript.phase !== "idle" || this.queueFlushTimer !== undefined;
  }

  private maybeFlushQueue(): void {
    if (this.sending || this.queueBusy) return;
    if (this.options.controller.transcript.phase !== "idle") return;
    // Only one follow-up per completed run: wait until the previously dispatched
    // prompt has actually landed as a user message, so a transient idle (before
    // the server reports "busy") can't drain the whole queue at once.
    if (this.queueDispatchedAt >= 0 && this.userMessageCount() <= this.queueDispatchedAt) return;
    const next = this.queue.shift();
    if (next === undefined) {
      this.queueDispatchedAt = -1;
      return;
    }
    this.queueDispatchedAt = this.userMessageCount();
    this.tui.requestRender();
    const shell = this.shellCommand(next.text);
    if (shell) {
      // A queued `!` command runs when the turn settles, then the queue resumes.
      this.queueBusy = true;
      this.queueDispatchedAt = -1;
      void this.runShellCommand(shell.command, shell.exclude)
        .catch(() => undefined)
        .finally(() => {
          this.queueBusy = false;
          this.maybeFlushQueue();
        });
      return;
    }
    if (next.text.startsWith("/")) {
      // A queued command runs to completion before anything after it, then the
      // queue resumes. The guard keeps a notice emitted mid-command from
      // dispatching the next item early.
      this.queueBusy = true;
      this.queueDispatchedAt = -1;
      void this.runSlashCommand(next.text)
        .catch(() => undefined)
        .finally(() => {
          this.queueBusy = false;
          this.maybeFlushQueue();
        });
      return;
    }
    void this.sendPrompt(next.text, next.attachments);
  }

  /** Real user messages in the transcript (notice/hidden rows excluded). */
  private userMessageCount(): number {
    return this.options.controller.transcript.messages.filter(
      (message) => message.role === "user" && !message.notice && !message.hidden,
    ).length;
  }

  /** Steer every queued message into the running turn at once (cmd+enter). */
  private steerQueued(): void {
    if (this.queue.length === 0) return;
    // Slash commands can't steer, so they stay queued. `!` shell commands steer
    // by running now; everything else steers as a normal message.
    const steering: QueuedPrompt[] = [];
    const carried: QueuedPrompt[] = [];
    const shells: QueuedPrompt[] = [];
    for (const item of this.queue) {
      if (item.text.startsWith("/")) carried.push(item);
      else if (this.shellCommand(item.text)) shells.push(item);
      else steering.push(item);
    }
    if (steering.length === 0 && shells.length === 0) {
      this.flash("Command queued until the run settles");
      return;
    }
    this.queue = carried;
    this.tui.requestRender();
    if (shells.length > 0) {
      // Sequential so the single `shellProcess` (cancel target) stays valid.
      void (async () => {
        for (const item of shells) {
          const shell = this.shellCommand(item.text);
          if (shell) await this.runShellCommand(shell.command, shell.exclude);
        }
      })();
    }
    if (steering.length === 0) {
      this.flash(`Running ${shells.length} queued shell command${shells.length === 1 ? "" : "s"}`);
      return;
    }
    const text = steering.map((item) => item.text).join("\n\n");
    const attachments = steering.flatMap((item) => item.attachments);
    this.pendingSteers.push({ text, at: Date.now() });
    const preview = steering.map((item) => item.text.replace(/\s+/g, " ").trim()).join(" | ").slice(0, 60);
    this.flash(`Steering: ${preview}`);
    void this.sendPrompt(text, attachments);
  }

  /**
   * Steer freshly typed input into the running turn (cmd+enter with text in the
   * input box). Unlike Enter this never queues: the text is delivered to the
   * active run. Commands cannot steer, so they keep their normal Enter routing.
   */
  private steerTyped(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // `!` shell commands steer by running immediately, clearing the input. The
    // bang must be at the very start, so a leading space is a normal prompt.
    const shell = this.shellCommand(text);
    if (shell) {
      this.editor.addToHistory(trimmed);
      this.editor.setText("");
      this.tui.requestRender();
      if (shell.command) void this.runShellCommand(shell.command, shell.exclude);
      return;
    }
    // With no active run there is nothing to steer into, and commands cannot
    // steer at all; both keep their normal Enter routing.
    if (!this.isRunActive() || trimmed.startsWith("/")) {
      void this.handleSubmit(text);
      return;
    }
    // Resolve image chips before clearing the editor.
    const prompt = this.preparePrompt(trimmed);
    this.editor.addToHistory(trimmed);
    this.editor.setText("");
    this.steerPrompt(prompt, trimmed);
  }

  /**
   * Deliver an already-prepared prompt into the running turn. Appends to
   * `pendingSteers` so consecutive steers are all tracked and folded into the
   * live run once their transcript messages land.
   */
  private steerPrompt(prompt: QueuedPrompt, preview: string): void {
    this.pendingSteers.push({ text: prompt.text, at: Date.now() });
    this.flash(`Steering: ${preview.replace(/\s+/g, " ").trim().slice(0, 60)}`);
    void this.sendPrompt(prompt.text, prompt.attachments);
  }

  /**
   * Tag a freshly-landed user message as the steer we just sent, so it folds
   * into the current run instead of starting a new one.
   */
  private tagSteers(): void {
    if (this.pendingSteers.length === 0) return;
    const now = Date.now();
    const messages = this.options.controller.transcript.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== "user" || message.notice || message.hidden || message.steer) continue;
      const text = message.parts
        .filter((part): part is Extract<PartView, { kind: "text" }> => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text) continue;
      for (let index = 0; index < this.pendingSteers.length; index++) {
        const steer = this.pendingSteers[index]!;
        if (now - steer.at > 20_000) continue;
        const needle = steer.text.trim();
        if (needle && (text === needle || text.includes(needle))) {
          message.steer = true;
          this.pendingSteers.splice(index, 1);
          break;
        }
      }
    }
    this.pendingSteers = this.pendingSteers.filter((steer) => now - steer.at <= 20_000);
  }

  /** True for commands that would replace the session or start competing work. */
  private commandWouldInterrupt(name: string): boolean {    if (INTERRUPTING_COMMANDS.has(name)) return true;
    // Custom and opencode commands inject a prompt/command into the session.
    return (
      this.customCommands.some((command) => command.name === name) ||
      this.commands.some((command) => command.name === name)
    );
  }

  private slashNames(): string[] {
    return [
      ...new Set([
        "model",
        "agents",
        "thinking",
        "settings",
        "copy",
        "new",
        "compact",
        "sessions",
        "undo",
        "stats",
        "tasks",
        "multitask",
        "voice",
        "reload",
        "mcps",
        "skills",
        "login",
        "logout",
        "goal",
        "exit",
        ...this.customCommands.map((command) => command.name),
        ...this.commands.map((command) => command.name),
      ]),
    ];
  }

  /** First command whose name starts with `name`, i.e. the top autocomplete match. */
  private resolveSlashName(name: string): string {
    const names = this.slashNames();
    if (names.includes(name)) return name;
    const lower = name.toLowerCase();
    return names.find((candidate) => candidate.toLowerCase().startsWith(lower)) ?? name;
  }

  private installAutocomplete(): void {
    const custom: SlashCommand[] = this.customCommands.map((command) => ({
      name: command.name,
      description: command.description,
    }));
    const local: SlashCommand[] = [
      { name: "model", description: "Select the active model" },
      { name: "agents", description: "Set the model for each agent" },
      { name: "thinking", description: "Set the thinking level" },
      { name: "settings", description: "Edit midas/pi settings" },
      { name: "copy", description: "Copy the last message or whole session" },
      { name: "new", description: "Start a new session" },
      { name: "compact", description: "Compact the current session" },
      { name: "sessions", description: "Resume or manage sessions" },
      { name: "undo", description: "Stop the run and put the last prompt back in the input" },
      { name: "stats", description: "Token usage and spend by agent" },
      { name: "tasks", description: "Task board grouped by feature or worktree" },
      { name: "multitask", description: "Toggle orchestration mode (on/off)" },
      { name: "voice", description: "Dictate into the input with the microphone (on/off)" },
      { name: "reload", description: "Reload settings, models and resources" },
      { name: "mcps", description: "Manage MCP servers" },
      { name: "skills", description: "Manage skills" },
      { name: "login", description: "Log in to a provider" },
      { name: "logout", description: "Log out of a provider" },
      { name: "goal", description: "Resume, pause or edit the goal" },
      { name: "exit", description: "Quit midas" },
    ];
    const names = new Set([...local, ...custom].map((command) => command.name));
    const remote: SlashCommand[] = this.commands
      .filter((command) => !names.has(command.name))
      .map((command) => ({ name: command.name, description: command.description }));
    // Defensive dedupe: never show the same command name twice.
    const seen = new Set<string>();
    const commands: SlashCommand[] = [];
    for (const command of [...local, ...custom, ...remote]) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      commands.push(command);
    }
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, this.options.cwd, null));
  }

  private async runSlashCommand(input: string): Promise<void> {
    const match = input.match(/^\/([^\s]+)\s*([\s\S]*)$/);
    if (!match) return;
    const name = match[1]!;
    const args = match[2]!.trim();
    if (name === "exit" || name === "quit") return this.quit();
    if (name === "model") return this.openModelPicker();
    if (name === "agents") return this.openAgents();
    if (name === "thinking") return this.openThinkingPicker();
    if (name === "settings") return this.openSettings();
    if (name === "copy") return this.openCopyPicker();
    if (name === "new") return this.doNewSession();
    if (name === "compact") return this.doCompact();
    if (name === "sessions") return this.openSessions();
    if (name === "undo") return void this.doUndo();
    if (name === "stats") return this.openStats();
    if (name === "tasks") return this.openTasks();
    if (name === "multitask") return this.toggleMultitask(args);
    if (name === "voice") return this.toggleVoice(args);
    if (name === "reload") return this.doReload();
    if (name === "mcps") return this.openMcps();
    if (name === "skills") return this.openSkills();
    if (name === "login") return this.openLogin();
    if (name === "logout") return this.openLogout();
    if (name === "goal") return this.openGoal();
    const custom = this.customCommands.find((command) => command.name === name);
    if (custom) {
      // User-defined command: send its template as a normal prompt.
      try {
        await this.options.controller.prompt(renderCommandTemplate(custom, args));
      } catch (error) {
        this.options.controller.transcript.setPhase("idle");
        this.fail(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (!this.commands.some((command) => command.name === name)) {
      this.fail(`Unknown command: /${name}`);
      return;
    }
    try {
      await this.options.controller.runCommand(name, args);
    } catch (error) {
      this.options.controller.transcript.setPhase("idle");
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** Skills visible to midas across pi and opencode skill directories. */
  private refreshSkills(): void {
    this.skillEntries = listSkills(this.options.cwd);
    this.skillNames = this.skillEntries.map((skill) => skill.name);
  }

  /**
   * Skills for the header column: global/user skills first, then project-local
   * ones, separated by a blank row.
   */
  private headerSkills(): string[] {
    const sort = (entries: SkillEntry[]): string[] =>
      entries.map((skill) => skill.name).sort((a, b) => a.localeCompare(b));
    const global = sort(this.skillEntries.filter((skill) => skill.scope === "global"));
    const local = sort(this.skillEntries.filter((skill) => skill.scope === "local"));
    if (global.length > 0 && local.length > 0) return [...global, "", ...local];
    return [...global, ...local];
  }

  /** Remember a sent prompt for Up/Down history recall. */
  /** Seed Up/Down history from a resumed session's prompts (oldest -> newest). */
  private seedHistoryFromTranscript(): void {
    for (const message of this.options.controller.transcript.messages) {
      if (message.role !== "user" || message.notice || message.hidden) continue;
      const text = message.parts
        .filter((part): part is Extract<PartView, { kind: "text" }> => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text && !text.startsWith("/")) this.editor.addToHistory(text);
    }
  }

  /** Read the editor's history-browsing position so the frame can label it. */
  private syncHistoryView(): void {
    const editor = this.editor as unknown as { historyIndex?: number; history?: unknown[]; cursorVisible?: boolean };
    const index = typeof editor.historyIndex === "number" ? editor.historyIndex : -1;
    const length = Array.isArray(editor.history) ? editor.history.length : 0;
    // No block cursor while browsing past messages.
    editor.cursorVisible = index < 0;
    if (index === this.historyView.index && length === this.historyView.length) return;
    this.historyView = { index, length };
    this.tui.requestRender();
  }

  /**
   * Drive the editor's history ourselves for Up/Down while an input is empty or
   * already browsing, so the key always moves between messages instead of the
   * block cursor. Returns true when handled.
   */
  private navigateEditorHistory(direction: -1 | 1): boolean {
    const editor = this.editor as unknown as { historyIndex?: number; navigateHistory?: (direction: number) => void };
    const browsing = typeof editor.historyIndex === "number" && editor.historyIndex >= 0;
    if (direction === 1) {
      if (!browsing) return false;
    } else if (!browsing && this.editor.getText().length > 0) {
      return false; // Let the editor move the cursor within the message.
    }
    editor.navigateHistory?.(direction);
    this.syncHistoryView();
    return true;
  }

  /** Cancel editor history browsing, restoring the pre-browse draft (empty). */
  private cancelHistoryBrowsing(): void {
    const editor = this.editor as unknown as { historyIndex?: number; navigateHistory?: (direction: number) => void };
    if (typeof editor.historyIndex !== "number" || editor.historyIndex < 0) return;
    for (let guard = 0; guard < 200 && typeof editor.historyIndex === "number" && editor.historyIndex >= 0; guard++) {
      editor.navigateHistory?.(1);
    }
    this.syncHistoryView();
  }

  /** Centered border label showing how many older/newer messages remain. */
  private historyLabel(edge: "up" | "down"): string {
    const { index, length } = this.historyView;
    if (index < 0) return "";
    // History is newest-first: index 0 is the newest entry, so entries ABOVE it
    // (reachable with Up) are the remaining older ones.
    const older = length - 1 - index;
    const newer = index;
    if (edge === "up") return older > 0 ? `↑ ${older} Message${older === 1 ? "" : "s"}` : "";
    return newer > 0 ? `↓ ${newer} Message${newer === 1 ? "" : "s"}` : "↓ Current";
  }

  private handleGlobalKey(data: string): { consume?: boolean } | undefined {
    if (this.activeOverlay) return undefined;
    // Esc leaves voice dictation without also aborting the running agent.
    if (
      exitVoiceOnEscape({
        voiceActive: this.voiceActive,
        escape: matchesKey(data, "escape"),
        autocomplete: this.editor.isShowingAutocomplete(),
      })
    ) {
      this.setVoiceActive(false);
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.navigateEditorHistory(-1)) return { consume: true };
    } else if (matchesKey(data, "down")) {
      if (this.navigateEditorHistory(1)) return { consume: true };
    } else if (this.historyView.index >= 0) {
      if (matchesKey(data, "escape")) {
        // Esc cancels history browsing and returns to the empty input.
        this.cancelHistoryBrowsing();
        return { consume: true };
      }
      if (matchesKey(data, "enter")) {
        // Enter picks the message: leave browsing with it left in the input and
        // the cursor at the end, instead of submitting it.
        const editor = this.editor as unknown as {
          exitHistoryBrowsing?: () => void;
          setTextInternal?: (text: string, placement?: string) => void;
        };
        editor.exitHistoryBrowsing?.();
        editor.setTextInternal?.(this.editor.getText(), "end");
        this.syncHistoryView();
        return { consume: true };
      }
      // Any other key leaves history mode in the editor; re-sync afterwards.
      queueMicrotask(() => this.syncHistoryView());
    }
    // Typing "!" as the first character starts a shell command; add the space
    // for it. Deleting that space afterwards turns it back into a normal prompt.
    if (data === "!" && this.editor.getExpandedText() === "") {
      this.editor.setText("! ");
      this.tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "super+enter")) {
      // cmd+enter steers: typed text first, otherwise the earliest queued
      // follow-up. With neither, let the key fall through unchanged.
      const raw = this.editor.getExpandedText();
      if (raw.trim()) {
        this.steerTyped(raw);
        return { consume: true };
      }
      if (this.isRunActive() && this.queue.length > 0) {
        this.steerQueued();
        return { consume: true };
      }
      return undefined;
    }
    if (matchesKey(data, "enter")) {
      // Expand paste markers so a pasted payload is submitted, not its placeholder.
      const text = this.editor.getExpandedText().trim();
      if (text.startsWith("/")) {
        const body = text.slice(1);
        const name = body.split(/\s+/)[0] ?? "";
        const names = this.slashNames();
        const isPartial = !body.includes(" ") && names.some((candidate) => candidate !== name && candidate.startsWith(name));
        if (!isPartial) {
          void this.handleSubmit(text);
          return { consume: true };
        }
      }
    }
    if (matchesKey(data, "ctrl+c")) {
      if (this.killShell()) return { consume: true };
      // Clear a non-empty draft first; only an empty input aborts or exits.
      if (this.editor.getText().length > 0) {
        // An edited follow-up goes back to the queue rather than being lost.
        if (this.editingQueue) {
          this.enqueueAt(this.editingQueue.index, this.editingQueue.prompt);
          this.editingQueue = undefined;
        }
        this.editor.setText("");
        this.tui.requestRender();
        return { consume: true };
      }
      if (this.options.controller.transcript.phase !== "idle") void this.options.controller.abort();
      else this.quit();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d")) {
      this.quit();
      return { consume: true };
    }
    if (matchesKey(data, "super+m")) {
      this.openModelPicker();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+t")) {
      this.cycleThinking();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      this.expandedTools = !this.expandedTools;
      this.transcriptOptions.expandedTools = this.expandedTools;
      this.transcriptView.invalidate();
      this.tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (this.killShell()) return { consume: true };
      if (this.options.controller.transcript.phase !== "idle") {
        void this.options.controller.abort();
        return { consume: true };
      }
    }
    return undefined;
  }

  private syncOverlays(): void {
    const permission = this.options.controller.transcript.permissions[0];
    if (permission && permission.id !== this.currentPermissionId) {
      this.currentPermissionId = permission.id;
      this.showOverlay(
        new PermissionDialog(permission, (response) => void this.respondPermission(permission.id, response)),
        { width: "60%", maxHeight: "50%" },
      );
      return;
    }
    const question = this.options.controller.transcript.questions[0];
    if (!permission && question && question.id !== this.currentQuestionId) {
      this.currentQuestionId = question.id;
      this.showOverlay(
        new QuestionDialog(
          question,
          (answers) => void this.answerQuestion(question.id, answers),
          () => void this.rejectQuestion(question.id),
        ),
        { width: "64%", maxHeight: "60%" },
      );
      return;
    }
    if (!permission && !question && (this.currentPermissionId || this.currentQuestionId)) {
      this.currentPermissionId = undefined;
      this.currentQuestionId = undefined;
      this.closeOverlay();
    }
  }

  private async answerQuestion(requestID: string, answers: string[][]): Promise<void> {
    this.currentQuestionId = undefined;
    this.closeOverlay();
    try {
      await this.options.controller.answerQuestion(requestID, answers);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async rejectQuestion(requestID: string): Promise<void> {
    this.currentQuestionId = undefined;
    this.closeOverlay();
    try {
      await this.options.controller.rejectQuestion(requestID);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async respondPermission(permissionID: string, response: PermissionResponse): Promise<void> {
    this.currentPermissionId = undefined;
    this.closeOverlay();
    await this.options.controller.respondPermission(permissionID, response);
  }

  private openThinkingPicker(): void {
    const current = this.currentThinking();
    const defaultLevel =
      typeof this.options.settings.defaultThinkingLevel === "string" ? this.options.settings.defaultThinkingLevel : "medium";
    const picker = new ThinkingPicker(
      THINKING_LEVELS,
      current,
      defaultLevel,
      (level: string) => {
        this.setThinkingLevel(level);
        this.closeOverlay();
      },
      (level: string) => {
        updateGlobalSetting("defaultThinkingLevel", level);
        this.flash(`Default thinking: ${level}`);
      },
      () => this.closeOverlay(),
    );
    this.showOverlay(picker, { width: "64%", maxHeight: "70%" });
  }

  /** Per-agent model configuration, e.g. give the title agent a fast model. */
  private openAgents(): void {
    if (this.agentCatalog.length === 0) {
      this.flash("No agents available");
      return;
    }
    const overrides = this.agentModelMap();
    const byName = new Map(this.agentCatalog.map((agent) => [agent.name, agent]));
    const agents = agentSettingsRows(this.agentCatalog).flatMap(({ name, label, group }) => {
      const agent = byName.get(name);
      return agent ? [{ agent, label, group }] : [];
    });
    const items = agents.map(({ agent, label, group }) => {
      const configured = agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : undefined;
      const selected = this.resolveModelRef(overrides[agent.name] ?? configured);
      const callerLabel = agentCallerLabel(this.agentCatalog, agent.name);
      const global = this.model;
      const defaultLabel =
        callerLabel
          ? `Default (${callerLabel})`
          : global
            ? `Default (${modelDisplayLabel(global)})`
            : "Default (global model)";
      return {
        id: `agent:${agent.name}`,
        label,
        currentValue: selected ? modelDisplayLabel(selected) : defaultLabel,
        group,
        submenu: (_current: string, done: (value?: string) => void) => {
          // "Default" means no per-agent override. For a subagent, name the
          // agent(s) it can be invoked by (where its model is inherited from);
          // fall back to the global model for agents nothing can call.
          const choices: ModelChoice[] = [
            { providerID: "", modelID: "", name: defaultLabel, providerName: "" },
            ...this.models,
          ];
          // Show the choice as a breadcrumb in the panel border instead of
          // nesting a second "Models" panel inside this one.
          this.agentBreadcrumb = capitalize(agent.name);
          const finish = (value?: string): void => {
            this.agentBreadcrumb = undefined;
            done(value);
          };
          return new ModelPicker(
            choices,
            (choice) => {
              if (!choice.providerID) {
                this.setAgentModel(agent.name, undefined);
                finish(defaultLabel);
              } else {
                this.setAgentModel(agent.name, `${choice.providerID}/${choice.modelID}`);
                finish(modelDisplayLabel(choice));
              }
            },
            () => finish(),
            true,
          );
        },
      };
    });
    const list = new SettingsList(
      items,
      14,
      getSettingsListTheme(),
      () => this.tui.requestRender(),
      () => this.closeOverlay(),
      { enableSearch: true },
    );
    this.agentBreadcrumb = undefined;
    this.showOverlay(
      new PanelOverlay(() => (this.agentBreadcrumb ? `Agents > ${this.agentBreadcrumb}` : "agents"), new CompactSearchList(list, true)),
      { width: "70%", maxHeight: "70%" },
    );
  }

  private openSettings(): void {
    const items = [
      {
        id: "title-words",
        label: "Title max words",
        description: "Maximum words in the generated title",
        currentValue: String(this.titleMaxWords()),
        submenu: (current: string, done: (value?: string) => void) =>
          new PromptDialog(
            "Title max words: ",
            current,
            (value) => {
              const parsed = Number.parseInt(value.trim(), 10);
              done(String(Number.isFinite(parsed) && parsed > 0 ? Math.min(20, parsed) : this.titleMaxWords()));
            },
            () => done(),
          ),
      },
      {
        id: "currency",
        label: "Currency",
        description: "Cost display currency for the footer and stats",
        currentValue: currencyLabel(normalizeCurrencyKey(this.options.settings.currency)),
        submenu: () => {
          queueMicrotask(() => this.openCurrencyPicker());
          return new Container();
        },
      },
      {
        id: "terminal-title",
        label: "Terminal title",
        description: "Set the window title; when off, hide the header too",
        currentValue: this.terminalTitleEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "skill-commands",
        label: "Skill commands",
        description: "Enable skill commands in the slash menu",
        currentValue: this.options.settings.enableSkillCommands === true ? "on" : "off",
        values: ["on", "off"],
      },
    ];
    const list = new SettingsList(
      items,
      12,
      getSettingsListTheme(),
      (id, value) => {
        switch (id) {
          case "title-words":
            (this.options.settings as Record<string, unknown>).titleMaxWords = Number(value);
            updateGlobalSetting("titleMaxWords", Number(value));
            break;
          case "terminal-title": {
            const enabled = value === "on";
            (this.options.settings as Record<string, unknown>).terminalTitle = enabled;
            updateGlobalSetting("terminalTitle", enabled);
            this.applyTerminalTitle(enabled ? this.title : "");
            break;
          }
          case "skill-commands": {
            const enabled = value === "on";
            (this.options.settings as Record<string, unknown>).enableSkillCommands = enabled;
            updateGlobalSetting("enableSkillCommands", enabled);
            break;
          }
        }
        this.tui.requestRender();
      },
      () => this.closeOverlay(),
      { enableSearch: false },
    );
    this.showOverlay(new PanelOverlay("settings", new NoHintList(list)), { width: "70%", maxHeight: "70%" });
  }

  private openCurrencyPicker(): void {
    const picker = new SearchPicker(
      CURRENCY_CHOICES.map((choice) => ({ id: choice.key, label: choice.label })),
      (key) => {
        (this.options.settings as Record<string, unknown>).currency = key;
        updateGlobalSetting("currency", key);
        void applyCurrencySetting(key).then(() => this.tui.requestRender());
        this.openSettings();
      },
      () => this.openSettings(),
      normalizeCurrencyKey(this.options.settings.currency),
    );
    this.showOverlay(new PanelOverlay("Settings > Currency", picker), { width: "60%", maxHeight: "60%" });
  }

  private openCopyPicker(): void {
    const picker = new OptionPicker(
      [
        { label: "Last message", description: "most recent assistant or user text", value: "last" },
        { label: "Whole session", description: "entire transcript", value: "session" },
      ],
      (value) => {
        const text = value === "last" ? this.lastMessageText() : this.sessionText();
        this.closeOverlay();
        if (!text.trim()) {
          this.flash("Nothing to copy");
          return;
        }
        copyToClipboard(text).then(
          () => this.success("Copied"),
          (error) => this.fail(`Copy failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      },
      () => this.closeOverlay(),
    );
    this.showOverlay(new PanelOverlay("copy", picker), { width: "60%", maxHeight: "40%" });
  }

  private messageText(view: MessageView): string {
    return view.parts
      .filter((part): part is Extract<PartView, { kind: "text" }> => part.kind === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }

  private lastMessageText(): string {
    const messages = this.options.controller.transcript.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.notice || message.hidden) continue;
      const text = this.messageText(message);
      if (text) return text;
    }
    return "";
  }

  private sessionText(): string {
    const out: string[] = [];
    for (const message of this.options.controller.transcript.messages) {
      if (message.notice) continue;
      const text = this.messageText(message);
      if (!text) continue;
      out.push(`## ${message.role === "user" ? "User" : "Assistant"}\n\n${text}`);
    }
    return out.join("\n\n");
  }

  /** Transient top-right toast; neutral (inverse) unless an error/success style. */
  private flash(message: string, durationMs = 1500): void {
    this.toast(message, "\x1b[7m", durationMs);
  }

  /** Errors are transient red toasts, not transcript output. */
  private fail(message: string): void {
    this.toast(message, "\x1b[41m\x1b[97m", 4000);
  }

  /** Success confirmation, e.g. "Reloaded!": green background, black text. */
  private success(message: string): void {
    this.toast(message, "\x1b[42m\x1b[30m", 2500);
  }

  /** Show a transient toast in the terminal's top-right corner. */
  private toast(message: string, style: string, durationMs: number): void {
    const text = message.replace(/\s+/g, " ").trim();
    if (!text) return;
    this.toastHandle?.hide();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    const columns = this.tui.terminal.columns || 80;
    const width = Math.max(4, Math.min(text.length + 4, columns - 2));
    try {
      this.toastHandle = this.tui.showOverlay(new Toast(text, style), {
        anchor: "top-right",
        margin: 1,
        width,
        nonCapturing: true,
      });
    } catch {
      // Regular mode may not support overlays; fall back to a transcript notice.
      this.options.controller.transcript.addNotice(text);
      return;
    }
    this.toastTimer = setTimeout(() => {
      this.toastHandle?.hide();
      this.toastHandle = undefined;
      this.tui.requestRender();
    }, durationMs);
    this.toastTimer.unref?.();
    this.tui.requestRender();
  }

  private async doNewSession(): Promise<void> {
    try {
      // Keep the outgoing session's draft and shell state before switching.
      this.saveDraftNow();
      this.persistSessionState();
      await this.options.controller.newSession();
      // Multitask is session-local. Every new conversation starts in the normal
      // interactive agent; the user explicitly enables the orchestrator again.
      this.setActiveAgent(DEFAULT_AGENT);
      this.sessionBash = [];
      this.restoreDraft(this.options.controller.id);
      this.transcriptView.reset();
      this.resetTitle();
      this.resetStats();
      this.showContext = false;
      this.recordMidasSession();
      this.flash("New session");
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async doCompact(): Promise<void> {
    const model = this.effectiveModel();
    if (!model) return this.fail("Select a model before compacting");
    try {
      const done = await this.options.controller.compact(model.providerID, model.modelID);
      this.liveContext.clear();
      this.contextDisplay.clear();
      this.flash(done ? "Session compacted" : "Nothing to compact");
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private openSessions(): void {
    // Viewing sessions is read-only, but switching session would interrupt the
    // active run, so only that action is refused while busy.
    const busy = (): boolean => this.options.controller.transcript.phase !== "idle";
    const view = new SessionsView({
      cwd: this.options.cwd,
      onNew: (directory) => {
        if (busy()) {
          this.flash("Can't start a new session while the agent is working");
          return;
        }
        this.closeOverlay();
        void this.newSessionIn(directory);
      },
      onResume: (session) => {
        if (busy()) {
          this.flash("Can't resume a session while the agent is working");
          return;
        }
        this.closeOverlay();
        void this.resumeAgentSession(session);
      },
      onCancel: () => this.closeOverlay(),
    });
    view.setLoading();
    this.showOverlay(new PanelOverlay(() => view.currentTitle(), view), { width: "72%", maxHeight: "70%" });
    // Scan the agent stores in the background; Midas's own registry loads first.
    void loadAgentSessions()
      .then(async (sessions) => {
        await this.recoverMidasTitles(sessions);
        view.setSessions(sessions);
        this.tui.requestRender();
      })
      .catch(() => {
        view.setSessions([]);
        this.tui.requestRender();
      });
  }

  /**
   * Fill in titles for Midas sessions whose registry entry has none, using the
   * title opencode recorded (e.g. generated before the registry existed).
   */
  private async recoverMidasTitles(sessions: AgentSession[]): Promise<void> {
    const untitled = sessions.filter((session) => session.agent === "midas" && session.title === "New session");
    if (untitled.length === 0) return;
    try {
      const known = await this.options.controller.listSessions(null);
      const byId = new Map(
        known
          .map((session) => [session.id, usableSessionTitle(session.title)] as const)
          .filter(([, title]) => Boolean(title)),
      );
      for (const session of untitled) {
        const title = byId.get(session.id);
        if (!title) continue;
        session.title = title;
        upsertMidasSession({ id: session.id, cwd: session.projectDir, title });
      }
    } catch {
      // Title recovery is best-effort; the placeholder stays.
    }
  }

  /**
   * /undo: stop the current run, revert the session to just before the last
   * prompt (removing it and whatever followed) and put that prompt back in the
   * input box.
   */
  private async doUndo(): Promise<void> {
    if (this.isRunActive()) {
      try {
        await this.options.controller.abort();
      } catch {
        // Aborting is best-effort; the revert below still applies.
      }
    }
    const messages = this.options.controller.transcript.messages;
    let last: MessageView | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "user" && !message.notice && !message.hidden) {
        last = message;
        break;
      }
    }
    if (!last) {
      this.flash("Nothing to undo");
      return;
    }
    const text = last.parts
      .filter((part): part is Extract<PartView, { kind: "text" }> => part.kind === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    try {
      await this.options.controller.revertTo(last.id);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.historyView = { index: -1, length: 0 };
    const editorState = this.editor as unknown as { cursorVisible?: boolean; exitHistoryBrowsing?: () => void };
    editorState.exitHistoryBrowsing?.();
    editorState.cursorVisible = true;
    if (text) this.editor.setText(text);
    this.tui.requestRender();
    this.flash("Undid last prompt");
  }

  private openStats(): void {
    const view = new StatsView({ cwd: this.options.cwd, onCancel: () => this.closeOverlay() });
    this.statsView = view;
    // Paint the cached snapshot immediately; refresh in the background if stale.
    const cached = loadCachedAgentStats();
    if (cached) view.setData(cached);
    this.showOverlay(new PanelOverlay("Stats", view), { width: "72%", maxHeight: "70%" });
    void this.loadStats(view);
  }

  private async loadStats(view: StatsView): Promise<void> {
    try {
      // Global totals per agent/tool, parsed internally from each tool's session
      // files. Returns instantly when the cache is fresh; otherwise re-scans.
      const stats = await readAgentStats((partial) => {
        view.setData(partial);
        this.tui.requestRender();
      });
      view.setData(stats);
    } catch (error) {
      view.setError(error instanceof Error ? error.message : String(error));
    }
    this.tui.requestRender();
  }

  /** Background stats refresh; updates the open overlay if there is one. */
  private async refreshStatsInBackground(): Promise<void> {
    try {
      const stats = await refreshAgentStats();
      if (this.statsView) {
        this.statsView.setData(stats);
        this.tui.requestRender();
      }
    } catch {
      // Best effort; keep serving the cached snapshot.
    }
  }

  /** Start a fresh Midas session, re-rooting to the chosen project first. */
  private async newSessionIn(directory: string): Promise<void> {
    if (directory && directory !== this.options.cwd && directoryExists(directory)) {
      await this.changeDirectory(directory);
    }
    await this.doNewSession();
  }

  /** Resume a discovered session: Midas sessions open in place, others import. */
  private async resumeAgentSession(session: AgentSession): Promise<void> {
    if (session.agent === "midas") {
      await this.resumeSession({
        id: session.id,
        directory: session.projectDir,
        title: session.title,
      } as unknown as Session);
      return;
    }
    await this.continueAgentSession(session);
  }

  /**
   * Continue a session that started in another agent inside Midas: start a new
   * Midas session in the same project and seed it with the imported transcript,
   * so the conversation carries on here instead of handing off to that CLI.
   */
  private async continueAgentSession(session: AgentSession): Promise<void> {
    const label = AGENT_LABELS[session.agent];
    // A grouped session (e.g. Codex "Other") may point at a per-run directory
    // that is gone; fall back to the shared group directory when it exists.
    const directory = directoryExists(session.projectDir)
      ? session.projectDir
      : session.groupKey && directoryExists(session.groupKey)
        ? session.groupKey
        : undefined;
    if (!directory) return this.fail(`${label} project directory is gone: ${session.projectDir}`);
    try {
      if (directory !== this.options.cwd) await this.changeDirectory(directory);
      await this.doNewSession();
      const transcript = await readAgentTranscript(session);
      await this.options.controller.addContext(this.continuationPrompt(session, transcript));
      const title = usableSessionTitle(session.title);
      if (title) {
        this.title = title;
        this.applyTerminalTitle(title);
        void this.options.controller.setTitle(title).catch(() => {
          // Persisting the imported title is best-effort.
        });
      }
      this.recordMidasSession();
      this.tui.requestRender();
      this.flash(`Continuing ${label} session in Midas`);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** The imported-context message that seeds a continued foreign session. */
  private continuationPrompt(session: AgentSession, transcript: string): string {
    const label = AGENT_LABELS[session.agent];
    const header = `This Midas session continues a ${label} session (id: ${session.id}) started in ${session.projectDir}.`;
    if (!transcript) {
      return `${header}\n\nNo transcript could be imported; continue from the user's next message.`;
    }
    return `${header}\n\n--- Imported transcript (oldest to newest) ---\n\n${transcript}\n\n--- End of imported transcript ---\n\nContinue this conversation from where it left off. Do not repeat the transcript; wait for the user's next message.`;
  }

  private async resumeSession(session: Session): Promise<void> {
    try {
      // Keep the outgoing session's draft and shell state before switching.
      this.saveDraftNow();
      this.persistSessionState();
      // Prefer the directory the session was left in over its origin.
      const saved = readSessionState(session.id);
      const target = directoryExists(saved?.cwd) ? saved.cwd : session.directory;
      if (target && directoryExists(target) && target !== this.options.cwd) {
        await this.changeDirectory(target);
      }
      await this.options.controller.resume(session.id);
      await this.restoreSessionShellState(session.id);
      this.restoreDraft(this.options.controller.id);
      this.seedHistoryFromTranscript();
      this.transcriptView.reset();
      this.resetTitle();
      // Bring back the stored title so the resumed session keeps its identity.
      const restored = usableSessionTitle(this.options.controller.title ?? session.title);
      if (restored) {
        this.title = restored;
        this.applyTerminalTitle(restored);
      }
      this.recordMidasSession();
      this.resetStats();
      this.showContext = this.hasContextUsage();
      this.flash("Resumed session");
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async doReload(): Promise<void> {
    try {
      const settings = loadPiSettings(this.options.cwd);
      this.options.settings = settings;
      this.hideThinking = settings.hideThinkingBlock ?? true;
      const themeName = typeof settings.theme === "string" ? settings.theme : undefined;
      initTheme(themeName);
      try {
        initPiTheme(themeName, false);
      } catch {
        // pi's singleton keeps the previous theme.
      }
      this.editor.setPaddingX(this.editorPadding());
      this.editor.borderColor = theme().getThinkingBorderColor(this.thinkingLevel);
      // The transcript components share this object; update it in place so a
      // changed setting takes effect without rebuilding the view.
      this.transcriptOptions.hideThinking = this.hideThinking;
      this.transcriptOptions.expandedTools = this.expandedTools;
      this.refreshSkills();
      await this.loadAgents();
      await this.loadRest();
      await applyCurrencySetting(this.options.settings.currency);
      this.transcriptView.invalidate();
      this.tui.requestRender();
      this.success("Reloaded!");
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** Track MCP servers for the footer count and MCP tool-row titles. */
  private setMcpNames(names: string[]): void {
    this.mcpNames = names;
    setMcpServerNames(names);
  }

  private async openMcps(): Promise<void> {
    let statuses: Array<{ name: string; status: string }>;
    try {
      statuses = await this.options.controller.mcpStatuses();
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }
    const picker = new OptionPicker(
      statuses.length > 0
        ? statuses.map((status) => ({ label: status.name, description: status.status, value: status.name }))
        : [{ label: "None configured", description: "add MCP servers in your opencode config", value: "" }],
      (name) => {
        this.closeOverlay();
        if (!name) return;
        const status = statuses.find((entry) => entry.name === name)?.status;
        void (async () => {
          try {
            if (status === "connected") {
              await this.options.controller.disconnectMcp(name);
              this.flash(`Disconnected ${name}`);
            } else {
              await this.options.controller.connectMcp(name);
              this.flash(`Connected ${name}`);
            }
            this.setMcpNames(await this.options.controller.mcpServerNames());
          } catch (error) {
            this.fail(error instanceof Error ? error.message : String(error));
          }
        })();
      },
      () => this.closeOverlay(),
    );
    this.showOverlay(new PanelOverlay("MCPs", picker), { width: "64%", maxHeight: "60%" });
  }

  private openSkills(): void {
    const skills = listSkills(this.options.cwd);
    const items = skills.length > 0
      ? skills.map((skill) => ({
          id: `skill:${skill.name}`,
          label: skill.name,
          currentValue: skill.path.replace(homedir(), "~"),
        }))
      : [{ id: "none", label: "None configured", currentValue: "add a SKILL.md under .midas or .agents" }];
    const list = new SettingsList(
      items,
      12,
      getSettingsListTheme(),
      () => this.tui.requestRender(),
      () => this.closeOverlay(),
      { enableSearch: false },
    );
    this.showOverlay(new PanelOverlay("Skills", new NoHintList(list)), { width: "70%", maxHeight: "70%" });
  }

  private async openLogin(): Promise<void> {
    let providers: Awaited<ReturnType<SessionController["providerAuth"]>>;
    try {
      providers = await this.options.controller.providerAuth();
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }
    const authed = new Set(readAuthedProviders());
    const entries: LoginEntry[] = [];
    for (const provider of providers) {
      provider.methods.forEach((method, methodIndex) => {
        entries.push({ providerId: provider.id, providerName: provider.name, methodIndex, method });
      });
    }
    if (entries.length === 0) return this.flash("No login methods available");

    // pi-style first step: pick the authentication method, then the provider.
    const hasOauth = entries.some((entry) => entry.method.type === "oauth");
    const hasApi = entries.some((entry) => entry.method.type === "api");
    if (hasOauth && !hasApi) return this.showLoginProviders("oauth", entries, authed);
    if (hasApi && !hasOauth) return this.showLoginProviders("api", entries, authed);
    const options = [
      ...(hasOauth
        ? [{ label: "Sign in with an account", description: "browser or device login", value: "oauth" }]
        : []),
      ...(hasApi
        ? [{ label: "Sign in with an API key", description: "paste a key, or add a provider", value: "api" }]
        : []),
    ];
    const picker = new OptionPicker(
      options,
      (value) => {
        this.closeOverlay();
        this.showLoginProviders(value as "oauth" | "api", entries, authed);
      },
      () => this.closeOverlay(),
    );
    this.showOverlay(new PanelOverlay("login", picker), { width: "60%", maxHeight: "40%" });
  }

  /** Second step: providers offering the chosen authentication method. */
  private showLoginProviders(authType: "oauth" | "api", entries: LoginEntry[], authed: Set<string>): void {
    const filtered = entries.filter((entry) => entry.method.type === authType);
    const options = filtered.map((entry) => ({
      label: `${entry.providerName}: ${entry.method.label}`,
      description: authed.has(entry.providerId) ? "logged in" : undefined,
      value: `${entry.providerId}#${entry.methodIndex}`,
    }));
    if (authType === "api") {
      options.unshift({
        label: "Add provider manually",
        description: "OpenAI-compatible: name, base URL and API key",
        value: "__manual__",
      });
    }
    if (options.length === 0) {
      return this.flash(authType === "oauth" ? "No account providers available" : "No API key providers available");
    }
    const picker = new OptionPicker(
      options,
      (value) => {
        this.closeOverlay();
        if (value === "__manual__") return this.addProviderManually();
        const [providerId, indexText] = value.split("#");
        const entry = filtered.find(
          (candidate) => candidate.providerId === providerId && String(candidate.methodIndex) === indexText,
        );
        if (entry) this.beginLogin(entry);
      },
      () => this.closeOverlay(),
    );
    this.showOverlay(new PanelOverlay(authType === "oauth" ? "login: account" : "login: API key", picker), {
      width: "70%",
      maxHeight: "70%",
    });
  }

  /** Collect name, base URL and API key, then register an OpenAI-compatible provider. */
  private addProviderManually(): void {
    const prompts: AuthPrompt[] = [
      { type: "text", key: "name", message: "Provider name", placeholder: "e.g. My Provider" },
      { type: "text", key: "baseURL", message: "Base URL", placeholder: "https://api.example.com/v1" },
      { type: "text", key: "apiKey", message: "API key", placeholder: "paste key" },
    ];
    this.collectInputs(prompts, {}, (values) => {
      const name = (values.name ?? "").trim();
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!id) return this.fail("Provider name is required");
      void (async () => {
        try {
          await this.options.controller.addCustomProvider(id, name, (values.baseURL ?? "").trim(), (values.apiKey ?? "").trim());
          await this.loadRest();
          this.flash(`Added ${name}`);
        } catch (error) {
          this.fail(error instanceof Error ? error.message : String(error));
        }
      })();
    });
  }

  /** Collect a method's prompts, then run API-key or OAuth login. */
  private beginLogin(entry: { providerId: string; providerName: string; methodIndex: number; method: AuthMethod }): void {
    this.collectInputs(entry.method.prompts ?? [], {}, (inputs) => {
      if (entry.method.type === "api") this.promptApiKey(entry.providerName, entry.providerId, inputs);
      else void this.startOauth(entry.providerName, entry.providerId, entry.methodIndex, inputs);
    });
  }

  private collectInputs(
    prompts: AuthPrompt[],
    values: Record<string, string>,
    done: (values: Record<string, string>) => void,
  ): void {
    const remaining = prompts.filter((prompt) => !prompt.when || values[prompt.when.key] === prompt.when.value);
    const first = remaining[0];
    if (!first) {
      done(values);
      return;
    }
    const rest = remaining.slice(1);
    const finish = (value: string): void => {
      this.closeOverlay();
      this.collectInputs(rest, { ...values, [first.key]: value }, done);
    };
    if (first.type === "select" && first.options) {
      const picker = new OptionPicker(
        first.options.map((option) => ({ label: option.label, description: option.hint, value: option.value })),
        finish,
        () => this.closeOverlay(),
      );
      this.showOverlay(new PanelOverlay(first.message, picker), { width: "70%", maxHeight: "50%" });
    } else {
      const dialog = new PromptDialog(`${first.message}: `, first.placeholder ?? "", (value) => finish(value.trim()), () => this.closeOverlay());
      this.showOverlay(new PanelOverlay(first.message, dialog), { width: "70%", maxHeight: "30%" });
    }
  }

  private promptApiKey(providerName: string, providerID: string, metadata: Record<string, string>): void {
    const dialog = new PromptDialog(
      `API key for ${providerName}: `,
      "paste key",
      (key) => {
        this.closeOverlay();
        void (async () => {
          try {
            await this.options.controller.setApiKey(providerID, key.trim(), metadata);
            this.flash(`Logged in to ${providerName}`);
          } catch (error) {
            this.fail(error instanceof Error ? error.message : String(error));
          }
        })();
      },
      () => this.closeOverlay(),
    );
    this.showOverlay(new PanelOverlay(`${providerName} API key`, dialog), { width: "70%", maxHeight: "30%" });
  }

  private async startOauth(
    providerName: string,
    providerID: string,
    method: number,
    inputs: Record<string, string>,
  ): Promise<void> {
    try {
      const auth = await this.options.controller.oauthAuthorize(providerID, method, inputs);
      if (auth.url) openExternal(auth.url);
      if (auth.method === "auto") {
        await this.options.controller.oauthCallback(providerID, method, undefined, inputs);
        this.flash(`Logged in to ${providerName}`);
        return;
      }
      this.flash(`${providerName}: ${auth.instructions || "complete login in the browser"}`);
      const dialog = new PromptDialog(
        "Authorization code: ",
        "code",
        (code) => {
          this.closeOverlay();
          void (async () => {
            try {
              await this.options.controller.oauthCallback(providerID, method, code.trim(), inputs);
              this.flash(`Logged in to ${providerName}`);
            } catch (error) {
              this.fail(error instanceof Error ? error.message : String(error));
            }
          })();
        },
        () => this.closeOverlay(),
      );
      this.showOverlay(new PanelOverlay(`${providerName} login`, dialog), { width: "70%", maxHeight: "30%" });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private openLogout(): void {
    const authed = readAuthedProviders();
    if (authed.length === 0) return this.flash("No stored provider credentials");
    const picker = new OptionPicker(
      authed.map((id) => ({ label: id, value: id })),
      (id) => {
        this.closeOverlay();
        try {
          removeAuthedProvider(id);
          this.flash(`Logged out of ${id}`);
        } catch (error) {
          this.fail(error instanceof Error ? error.message : String(error));
        }
      },
      () => this.closeOverlay(),
    );
    this.showOverlay(new PanelOverlay("logout", picker), { width: "60%", maxHeight: "60%" });
  }

  private openGoal(): void {
    const picker = new OptionPicker(
      [
        { label: "Resume", description: "resume the active goal", value: "resume" },
        { label: "Pause", description: "pause the active goal", value: "pause" },
        { label: "Edit objective", description: "change the goal objective", value: "edit" },
        { label: "Status", description: "show the current goal", value: "status" },
        { label: "New goal", description: "set a new objective", value: "new" },
        { label: "Clear", description: "clear the goal", value: "clear" },
      ],
      (value) => {
        this.closeOverlay();
        if (value === "resume") return void this.runController("resume_goal", "");
        if (value === "pause") return void this.runController("pause_goal", "");
        if (value === "status") return void this.runController("goal", "status");
        if (value === "clear") return void this.runController("goal", "clear");
        const isEdit = value === "edit";
        const dialog = new PromptDialog(
          isEdit ? "New objective: " : "Goal objective: ",
          "",
          (text) => {
            this.closeOverlay();
            void this.runController("goal", isEdit ? `edit ${text}` : text);
          },
          () => this.closeOverlay(),
        );
        this.showOverlay(new PanelOverlay(isEdit ? "edit goal" : "new goal", dialog), { width: "80%", maxHeight: "30%" });
      },
      () => this.closeOverlay(),
    );
    this.showOverlay(new PanelOverlay("goal", picker), { width: "60%", maxHeight: "60%" });
  }

  private async runController(command: string, args: string): Promise<void> {
    try {
      await this.options.controller.runCommand(command, args);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private openModelPicker(): void {    if (this.models.length === 0) return;
    const picker = new ModelPicker(
      this.models,
      (choice) => {
        this.model = choice;
        // /model sets the current agent's model too, so each agent remembers its own.
        this.setAgentModel(this.activeAgent, `${choice.providerID}/${choice.modelID}`);
        this.options.controller.setModel({ providerID: choice.providerID, modelID: choice.modelID });
        writeLastSelectedModel({ providerID: choice.providerID, modelID: choice.modelID, name: choice.name });
        this.restoreThinkingForModel(choice.providerID, choice.modelID);
        this.options.controller.transcript.addRecord(
          `Model: ${choice.providerID}/${choice.modelID} • thinking ${this.currentThinking()}`,
        );
        this.resetStats();
        this.closeOverlay();
      },
      () => this.closeOverlay(),
    );
    this.showOverlay(picker, { width: "70%", maxHeight: "70%" });
  }

  /** Mount a dialog in the editor dock (bottom, full width) like pi. */
  private tasksTimer?: ReturnType<typeof setInterval>;
  private dispatcher?: TaskDispatcher;

  /**
   * Multitask mode runs the board autonomously: it picks ready tasks, runs them
   * in isolated worktrees, integrates completed work and cleans up. Disabling
   * multitask stops scheduling; in-flight runs finish and are integrated on the
   * next start. A missing Git repo just leaves the board unavailable.
   */
  private syncDispatcher(): void {
    const shouldRun = this.activeAgent === ORCHESTRATOR_AGENT;
    if (!shouldRun) {
      this.dispatcher?.stop();
      this.dispatcher = undefined;
      return;
    }
    if (this.dispatcher) return;
    let board: TaskBoard;
    try {
      board = new TaskBoard(this.options.cwd);
    } catch {
      return; // Not a Git repository; the /tasks panel already explains this.
    }
    const dispatcher = new TaskDispatcher(board, {
      onEvent: (message) => {
        this.options.controller.transcript.addRecord(message);
        void this.refreshBranch();
        this.tui.requestRender();
      },
    });
    this.dispatcher = dispatcher;
    void dispatcher.start().catch((error) => {
      this.dispatcher = undefined;
      this.options.controller.transcript.addRecord(
        `Dispatcher unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.tui.requestRender();
    });
  }

  private openTasks(): void {
    const view = new TasksView(() => this.closeOverlay(), this.activeAgent === ORCHESTRATOR_AGENT);
    let board: TaskBoard | undefined;
    try { board = new TaskBoard(this.options.cwd); }
    catch { view.error = "Tasks require an existing Git repository. No repository was created."; }
    const refresh = (): void => {
      if (board) {
        try { view.tasks = board.read().tasks; view.error = undefined; }
        catch (error) { view.error = String(error); }
      }
      this.tui.requestRender();
    };
    this.showOverlay(new PanelOverlay("tasks", view));
    refresh();
    this.tasksTimer = setInterval(refresh, 100);
  }

  private showOverlay(component: Component, _options?: OverlayOptions): void {
    if (this.tasksTimer) { clearInterval(this.tasksTimer); this.tasksTimer = undefined; }
    // Preserve whatever was typed before the overlay takes over the input dock.
    if (!this.overlayDraft) this.overlayDraft = this.editor.getText();
    this.historyView = { index: -1, length: 0 };
    this.activeOverlay = component;
    this.editorDock.clear();
    this.editorDock.addChild(component);
    this.tui.setFocus(component);
    this.tui.requestRender();
  }

  private closeOverlay(): void {
    if (this.tasksTimer) { clearInterval(this.tasksTimer); this.tasksTimer = undefined; }
    this.statsView = undefined;
    this.historyView = { index: -1, length: 0 };
    this.activeOverlay = undefined;
    this.mountEditor();
    // Restore the draft if anything cleared it while the overlay was up.
    if (this.overlayDraft !== undefined) {
      if (this.editor.getText() !== this.overlayDraft) this.editor.setText(this.overlayDraft);
      this.overlayDraft = undefined;
    }
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  /**
   * The editor's total inset equals the Padding setting: the frame contributes
   * one column (when padding > 0) and the editor's own padding is padding - 1.
   */
  private mountEditor(): void {
    const frame = new RoundedDialogFrame(
      () => Math.min(1, rowPad(this.options.cwd)),
      undefined,
      voiceFrameTitle({ voice: this.voiceActive, orchestrator: this.activeAgent === ORCHESTRATOR_AGENT }),
      { top: () => this.historyLabel("up"), bottom: () => this.historyLabel("down") },
    );
    frame.addChild(this.editor);
    this.editorDock.clear();
    this.editorDock.addChild(frame);
  }

  private footerData(): FooterData {
    const transcript = this.options.controller.transcript;
    const model = this.effectiveModel();
    const usage = this.contextDisplay.read(this.showContext ? this.liveContext.read(this.contextUsage()) : undefined);
    return {
      cwd: this.options.cwd,
      modelName: model?.name,
      modelID: model?.modelID ?? "no-model",
      thinking: this.currentThinking(),
      rate: this.rateDisplay.value,
      contextTokens: usage?.tokens ?? null,
      contextPercent: usage?.percent ?? null,
      cost: this.totalCost(),
      skillCount: this.skillNames.length,
      mcpCount: this.mcpNames.length,
    };
  }

  /**
   * Session cost. opencode's reported per-message cost is preferred; when a
   * provider does not report one (it stays 0), fall back to the catalog price
   * of each message's model applied to its token usage.
   */
  private totalCost(): number {
    const transcript = this.options.controller.transcript;
    let cost = 0;
    for (const message of transcript.messages) {
      if (message.role !== "assistant" || message.notice || message.hidden) continue;
      // Prefer opencode's reported cost for this message when it has one.
      if (message.cost > 0) {
        cost += message.cost;
        continue;
      }
      const pricing = this.models.find(
        (m) => m.providerID === message.providerID && m.modelID === message.modelID,
      )?.cost;
      if (!pricing) continue;
      cost +=
        (message.tokens.input * pricing.input +
          message.tokens.output * pricing.output +
          message.tokens.cacheRead * (pricing.cacheRead ?? pricing.input) +
          message.tokens.cacheWrite * (pricing.cacheWrite ?? pricing.output)) /
        1_000_000;
    }
    return cost;
  }

  /** Since live context is display-only, `null` tokens means "unknown yet". */
  private contextUsage(): ContextUsage | undefined {
    const contextWindow = this.effectiveModel()?.contextLimit ?? 0;
    if (contextWindow <= 0) return undefined;
    const tokens = this.contextTokens();
    return { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 };
  }

  /**
   * The context before the current turn: the last completed assistant message's
   * full token total (its output is part of the next prompt). While a turn is
   * streaming, live context adds that turn's output on top of this baseline.
   */
  private contextTokens(): number | null {
    const messages = this.options.controller.transcript.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== "assistant" || message.notice || message.hidden || !message.completed) continue;
      const t = message.tokens;
      return t.input + t.output + t.cacheRead + t.cacheWrite;
    }
    return null;
  }

  quit(): void {
    // Flush the unsent input and shell state so reopening restores both.
    this.saveDraftNow();
    this.persistSessionState();
    this.dispatcher?.stop();
    if (this.tasksTimer) clearInterval(this.tasksTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.timer) clearInterval(this.timer);
    if (this.branchTimer) clearInterval(this.branchTimer);
    if (this.rateTimer) clearInterval(this.rateTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastHandle?.hide();
    // Always clear the title we may have set, even if the setting was toggled off.
    try {
      this.tui.terminal.setTitle("");
    } catch {
      // Terminal may already be gone.
    }
    for (const path of this.watchedSettings) unwatchFile(path);
    this.watchedSettings = [];
    this.options.controller.dispose();
    try {
      this.tui.stop({ preserveScreen: this.tui.mode === "fullscreen" });
    } catch {
      // Terminal may already be stopped.
    }
    this.resolveDone?.();
  }

  waitForExit(): Promise<void> {
    return this.done;
  }
}

/**
 * Characters streamed into one assistant message so far. opencode sends full
 * part snapshots, so rate/context deltas are derived by diffing this total.
 */
function streamedCharsOf(message: MessageView): number {
  let chars = 0;
  for (const part of message.parts) {
    if (part.kind === "text" || part.kind === "reasoning") chars += part.text.length;
    else if (part.kind === "tool") chars += JSON.stringify(part.input ?? {}).length;
  }
  return chars;
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function openExternal(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Ignore: the URL is also shown in the transcript notice.
  }
}

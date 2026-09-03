/**
 * goal-service — goal / review loop / scoping wizard, extracted from agent-service.ts.
 *
 * Owns:
 *  - setGoal/clearGoal/setGoalPrefs: goal state machine + preference "global memory" (client-state.json)
 *  - runGoalReview: after agent_end, an ISOLATED review session (its own ModelRuntime)
 *    decides pass/fail; on fail, inject the feedback as a normal user message into
 *    the main session so it revises
 *  - startGoalWizard: AI refine — an isolated scoping session asks questions one by
 *    one via the goal_ask tool (dialog bridged to the browser); after it converges
 *    on a GOAL: it auto-sets the goal and kicks off generation
 *
 * Decoupled from ClientSession via GoalHost (same pattern as settings-service):
 * conversation records are passed as the structured subset GoalConversation
 * (the real Conversation satisfies it); session creation / dialog cancel / git
 * diff go through host callbacks so the service is independently testable.
 * Server notices are English.
 */
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSessionFromServices, createAgentSessionServices, defineTool, ModelRuntime, SessionManager, } from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "./attachments.js";
/** System prompt for the goal-wizard session. The wizard asks the user a few
 *  questions (via its goal_ask tool) to scope a raw requirement into a precise,
 *  reviewable goal, then emits ONLY the final goal text as its last message. */
function wizardPrompt(draft) {
    return [
        `You are a goal-clarification wizard. The user has stated a raw requirement. Your job is to turn it into ONE precise, actionable goal that a coding agent can fully satisfy and that can be strictly reviewed.`, // eslint-disable-line max-len
        ``,
        `# User's raw requirement`, // eslint-disable-line no-regex-spaces
        draft,
        ``,
        `Use your goal_ask tool to ask the user focused questions to pin down the essential, ambiguous details. Keep it concise — usually 2 to 4 questions: what exactly to build/do, scope boundaries (what NOT to do), acceptance criteria / done-definition, and any constraints (style, performance, environment).`, // eslint-disable-line max-len
        `Prefer multiple-choice (goal_ask with options) when you can offer clear choices; use open questions only for things that genuinely need free text.`, // eslint-disable-line max-len
        `Once you have enough to write an unambiguous, reviewable goal, STOP asking and reply with EXACTLY this format and nothing else (no preamble, no bullets):`, // eslint-disable-line max-len
        `GOAL: <one concrete, verifiable sentence describing the deliverable and its acceptance criteria>`, // eslint-disable-line max-len
        `If the user cancels or stops answering (the tool reports a cancellation), still produce a sensible best-effort goal from what you already know.`, // eslint-disable-line max-len
    ].join("\n");
}
export class GoalService {
    host;
    /** Defaults remembered for newly-created conversations. Each conversation
     * receives its own GoalStatus, so reviews can run concurrently. */
    prefs = {
        reviewModel: null,
        maxRounds: 0,
        locked: true,
    };
    /** Aborts the currently-running goal wizard (user clicked ✗ / timed out). Drives
     *  the in-flight goal_ask dialog to resolve as cancelled and (via the run
     *  signal) stops the wizard session's agent run. Recreated per wizard. */
    wizardAbort = null;
    /** The wizard's AgentSession while it runs — lets clearGoal truly terminate it
     *  (abort the run), not just flip a flag. */
    wizardSession = null;
    /** Conversation that owns the one browser wizard currently in flight. */
    wizardOwnerId = null;
    /** True when the wizard was cancelled externally (✗ / clear_goal / timeout) —
     *  startGoalWizard reads this after the run to avoid setting a goal. */
    wizardCancelled = false;
    /** Idle-timeout for the wizard: if no answer arrives within this window (a
     *  dialog is up but the user doesn't respond), the wizard is auto-cancelled. */
    static WIZARD_IDLE_TIMEOUT_MS = 5 * 60_000;
    /** Absolute deadline for the whole wizard session (model latency guard). */
    static WIZARD_MAX_TOTAL_MS = 20 * 60_000;
    constructor(host) {
        this.host = host;
        // Restore last-used goal/review preferences so model & rounds survive reload.
        const gPrefs = host.stateStore.getGoalPrefs(host.clientId);
        if (gPrefs) {
            this.prefs = {
                reviewModel: gPrefs.reviewModel,
                maxRounds: gPrefs.maxRounds,
                locked: gPrefs.locked,
            };
        }
    }
    /** Remembered defaults (model choice / rounds cap / lock). */
    get reviewPrefs() {
        return this.prefs;
    }
    /** Create independent goal state for one conversation. Preferences are
     * client-wide defaults, while goal text/review progress is not shared. */
    makeGoalStatus() {
        return {
            conversationId: null,
            goal: null,
            reviewModel: this.prefs.reviewModel,
            maxRounds: this.prefs.maxRounds,
            locked: this.prefs.locked,
            reviewing: false,
            round: 0,
            status: "",
            verdict: "pending",
            wizard: {
                active: false,
                draft: "",
                model: null,
                step: 0,
                maxSteps: 6,
                status: "",
            },
        };
    }
    /** Push the active conversation's goal status to the client (the goal bar
     * restores remembered prefs when nothing is active). */
    emitGoalStatus() {
        const goal = this.host.activeConv().goal;
        if (!goal.goal && !goal.reviewing && !goal.wizard.active) {
            goal.reviewModel = this.prefs.reviewModel;
            goal.maxRounds = this.prefs.maxRounds;
            goal.locked = this.prefs.locked;
        }
        this.host.emit({ type: "goal_status", status: { ...goal } });
    }
    /**
     * Set (or clear) the active goal. `goal === ""` clears it. The goal is
     * applied to the CURRENT active conversation of this project; reviews check
     * whatever run finishes next (agent_end).
     */
    async setGoal(goalText, opts) {
        const text = (goalText ?? "").trim();
        if (!text) {
            await this.clearGoal();
            return;
        }
        // A goal is scoped to the conversation that is active when it is set.
        // This prevents an agent_end from a newly-created/switched conversation
        // from consuming the previous conversation's goal.
        const conv = this.host.activeConv();
        const goalConversationId = this.host.activeConvId();
        conv.goalGeneration += 1;
        const goal = conv.goal;
        goal.reviewing = false;
        goal.conversationId = goalConversationId;
        goal.goal = text;
        // Model & rounds preference semantics ("global memory"):
        //  - reviewModel undefined → keep the remembered choice; empty → main model.
        //  - maxRounds 0 = unlimited (default); >0 = finite cap (clamped to 50).
        if (opts?.reviewModel !== undefined)
            goal.reviewModel = opts.reviewModel || null;
        if (typeof opts?.maxRounds === "number") {
            const mr = Math.round(opts.maxRounds);
            goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
        }
        if (opts?.locked !== undefined)
            goal.locked = opts.locked;
        this.prefs = {
            reviewModel: goal.reviewModel,
            maxRounds: goal.maxRounds,
            locked: goal.locked,
        };
        // Persist the chosen preferences so they survive reload.
        this.host.stateStore.saveGoalPrefs(this.host.clientId, {
            reviewModel: goal.reviewModel,
            maxRounds: goal.maxRounds,
            locked: goal.locked,
        });
        // Reset the loop for a freshly-set goal (single-shot goals start at 0).
        goal.round = 0;
        goal.reviewing = false;
        goal.verdict = "pending";
        goal.feedback = undefined;
        goal.wizard.active = false;
        goal.wizard.status = "";
        goal.status = "Goal set, waiting for generation…";
        this.emitGoalStatus();
        this.host.emit({
            type: "notice",
            level: "info",
            text: `Goal set: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
        });
        // Auto-start generation right after setting the goal (unless this setGoal is
        // the wizard's internal one, which kicks off itself). This makes the direct
        // goal-bar path behave like the AI-refine path: set a target → agent begins.
        if (opts?.autoStart !== false) {
            try {
                const s = conv.session;
                await s.sendUserMessage(`[Goal set]\n\n${text}\n\nPlease start implementing this goal now.`, { deliverAs: s.isStreaming ? "steer" : "followUp" });
            }
            catch {
                // Best-effort; the user can still prompt manually.
            }
            this.host.flushSnapshot();
        }
    }
    /**
     * Collaborative target wizard. Turns a raw user requirement into a refined
     * goal by spinning up an ISOLATED wizard session (own fresh ModelRuntime +
     * in-memory session, so its model choice is its own) that questions the user
     * via `goal_ask` (multiple-choice + free-text, bridged to the browser through
     * the existing select/input dialog), converging on a goal, then auto-sets it.
     * Mutually exclusive with the review loop of the same conversation.
     */
    async startGoalWizard(text, opts) {
        if (this.host.quiesceBlocked())
            return;
        const draft = (text ?? "").trim();
        if (!draft)
            return;
        // The wizard and its progress cards belong to the conversation that
        // launched it. If the user switches away, do not later set a goal on the
        // new active conversation while the wizard is still finishing.
        const wizardConversationId = this.host.activeConvId();
        const wizardConversation = this.host.activeConv();
        if (wizardConversation.wizardRunning || this.wizardOwnerId !== null) {
            this.host.emit({
                type: "notice",
                level: "warning",
                text: "A goal wizard is already running, wait for it to finish…",
            });
            return;
        }
        if (wizardConversation.goal.reviewing) {
            this.host.emit({
                type: "notice",
                level: "warning",
                text: "A review is running; cannot start the goal wizard yet…",
            });
            return;
        }
        // Questions are NOT capped (the wizard is uncapped) — it converges on its own;
        // the idle- and total-timeouts are the only guards. maxSteps is purely a
        // soft UI indicator, not a hard stop.
        const maxSteps = 20;
        wizardConversation.wizardRunning = true;
        this.wizardOwnerId = wizardConversationId;
        this.wizardCancelled = false;
        this.wizardAbort = new AbortController();
        this.wizardSession = null;
        const wgoal = wizardConversation.goal;
        wgoal.wizard.active = true;
        wgoal.wizard.draft = draft;
        wgoal.wizard.model = opts?.wizardModel ?? null;
        // Remember the model choice (and persist rounds/lock) — global memory.
        if (opts?.wizardModel !== undefined && opts.wizardModel !== null)
            wgoal.reviewModel = opts.wizardModel || null;
        if (typeof opts?.maxRounds === "number") {
            const mr = Math.round(opts.maxRounds);
            wgoal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
        }
        if (opts?.locked !== undefined)
            wgoal.locked = opts.locked;
        this.prefs = {
            reviewModel: wgoal.reviewModel,
            maxRounds: wgoal.maxRounds,
            locked: wgoal.locked,
        };
        this.host.stateStore.saveGoalPrefs(this.host.clientId, {
            reviewModel: wgoal.reviewModel,
            maxRounds: wgoal.maxRounds,
            locked: wgoal.locked,
        });
        wgoal.wizard.step = 0;
        wgoal.wizard.maxSteps = maxSteps;
        wgoal.wizard.status = "Researching…";
        wgoal.status = "Goal wizard running…";
        this.emitGoalStatus();
        // Idle-timeout: cancel the wizard if no question is answered within the
        // window (a stale dialog with no user response must not run forever). A
        // fresh timer is armed for each question; cleared once the run ends.
        const ac = this.wizardAbort;
        let idleTimer = null;
        const armIdle = () => {
            if (idleTimer)
                clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (!ac.signal.aborted) {
                    this.wizardCancelled = true;
                    ac.abort(new Error("Goal wizard timed out (idle too long)"));
                }
            }, GoalService.WIZARD_IDLE_TIMEOUT_MS);
            idleTimer.unref?.();
        };
        const clearIdle = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        armIdle();
        // Total-duration guard: hard cap on the whole wizard session (model
        // latency / unexpected loops must not run forever).
        const totalTimer = setTimeout(() => {
            if (!ac.signal.aborted) {
                this.wizardCancelled = true;
                ac.abort(new Error("Goal wizard exceeded the total time limit"));
            }
        }, GoalService.WIZARD_MAX_TOTAL_MS);
        totalTimer.unref?.();
        this.host.emit({
            type: "notice",
            level: "info",
            text: `Researching the goal: ${draft.slice(0, 60)}${draft.length > 60 ? "…" : ""}`,
        });
        // The main conversation to show wizard progress cards in.
        const mainSession = wizardConversation.session;
        let refinedGoal = "";
        try {
            const wmSpec = opts?.wizardModel
                ? this.resolveReviewModel(opts.wizardModel)
                : null; // reuse the honest "provider/id" parser
            const services = await createAgentSessionServices({
                cwd: wizardConversation.cwd,
                agentDir: this.host.agentDir,
                modelRuntime: await ModelRuntime.create({
                    authPath: join(this.host.agentDir, "auth.json"),
                    modelsPath: join(this.host.agentDir, "models.json"),
                }),
            });
            let model;
            if (wmSpec)
                model = services.modelRuntime.getModel(wmSpec.provider, wmSpec.id);
            if (!model) {
                const mainModel = mainSession.model;
                if (mainModel?.provider && mainModel.id)
                    model = services.modelRuntime.getModel(mainModel.provider, mainModel.id);
            }
            // The wizard asks the user questions via this tool; each call bridges one
            // select/input dialog to the browser and returns the user's answer.
            let qStep = 0;
            const goalAsk = defineTool({
                name: "goal_ask",
                label: "Ask the user",
                description: "Ask the user ONE question at a time to scope down the goal. Provide a clear question and 2-4 concise options; or ask an open question. Returns the user's chosen answer.",
                parameters: Type.Object({
                    question: Type.String({ description: "The question to ask" }),
                    options: Type.Optional(Type.Array(Type.String())),
                }),
                // ONE question at a time. Sequential execution prevents the agent from
                // firing parallel goal_ask calls whose dialogs would overwrite each other
                // in the single browser modal (leaving earlier ones deadlocked — the
                // reported "wizard stuck").
                executionMode: "sequential",
                execute: async (_id, params, _sig, _onUpdate, ctx) => {
                    qStep += 1;
                    if (qStep > maxSteps) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "(Reached the question cap; output the refined goal text as your final answer)",
                                },
                            ],
                            details: {},
                        };
                    }
                    // Show the question in the main flow BEFORE blocking on the dialog, so
                    // the user sees the wizard working even before answering.
                    wgoal.wizard.step = qStep;
                    wgoal.wizard.status = `Researching: please answer question ${qStep}`;
                    this.emitGoalStatus();
                    try {
                        armIdle();
                        const isChoice = !!(params.options && params.options.length > 0);
                        await this.pushWizardCard(mainSession, `Q${qStep}: ${params.question}${isChoice ? ` [${params.options.join(" / ")}]` : ""}`, { question: params.question });
                        // Resolve the pending dialog as cancelled if the wizard is aborted.
                        let aborted = false;
                        const onAbort = () => {
                            aborted = true;
                        };
                        ac.signal.addEventListener("abort", onAbort, { once: true });
                        const choose = isChoice
                            ? ctx.ui.select(`Q${qStep}: ${params.question}`, params.options)
                            : ctx.ui.input(`Q${qStep}: ${params.question}`);
                        const ans = (await choose);
                        ac.signal.removeEventListener("abort", onAbort);
                        if (aborted || ac.signal.aborted) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: "(Wizard cancelled; do not ask more questions, end the conversation)",
                                    },
                                ],
                                details: {},
                            };
                        }
                        if (ans === undefined || ans === null || ans === false || ans === "") {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: "(The user cancelled the wizard; output your current refined goal as the final answer)",
                                    },
                                ],
                                details: {},
                            };
                        }
                        // Record the answer in the flow too (instant append, main session idle).
                        await this.pushWizardCard(mainSession, `↳ Your answer: ${ans}`, { question: params.question, answer: String(ans) });
                        return {
                            content: [{ type: "text", text: `User answer: ${ans}` }],
                            details: {},
                        };
                    }
                    catch (err) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: ac.signal.aborted
                                        ? "(Wizard cancelled; do not ask more questions, end the conversation)"
                                        : `Question failed: ${err.message}`,
                                },
                            ],
                            details: {},
                        };
                    }
                },
            });
            const srv = await createAgentSessionFromServices({
                services,
                sessionManager: SessionManager.inMemory(this.host.cwd()),
                customTools: [goalAsk],
                ...(model ? { model } : {}),
            });
            const wizard = srv.session;
            this.wizardSession = wizard;
            await wizard.bindExtensions({ mode: "rpc", uiContext: this.host.webUi });
            // Cancel watcher: when the user ✗s / idle-timeout fires, truly stop the
            // wizard's agent run (not just mark it).
            if (!ac.signal.aborted) {
                ac.signal.addEventListener("abort", () => {
                    void wizard.abort().catch(() => { });
                    // Close the unanswered browser dialog(s) the wizard may have up.
                    this.host.webUi.cancelPendingDialogs();
                }, { once: true });
            }
            await wizard.prompt(wizardPrompt(draft));
            refinedGoal = wizard.getLastAssistantText()?.trim() ?? "";
            // The wizard is prompted to emit "GOAL: <text>". Parse past the marker;
            // if it didn't follow, strip a leading preamble line and keep the rest.
            const goalMatch = refinedGoal.match(/GOAL\s*[:：]\s*([\s\S]*)/i);
            if (goalMatch) {
                refinedGoal = goalMatch[1].trim();
            }
            else {
                const lines = refinedGoal.split("\n").filter((l) => l.trim());
                if (lines.length > 1 && !/[。.!?？]\s*$/.test(lines[0])) {
                    // First line looks like preamble (no sentence-ending punctuation).
                    refinedGoal = lines.slice(1).join(" ").trim();
                }
            }
            await srv.session.dispose();
        }
        catch (err) {
            this.host.emit({
                type: "notice",
                level: "error",
                text: `Goal wizard failed: ${err.message}`,
            });
        }
        finally {
            clearIdle();
            clearTimeout(totalTimer);
            wizardConversation.wizardRunning = false;
            if (this.wizardOwnerId === wizardConversationId)
                this.wizardOwnerId = null;
            wgoal.wizard.active = false;
            wgoal.wizard.step = 0;
            wgoal.wizard.status = "";
            this.wizardSession = null;
            this.emitGoalStatus();
        }
        // Aborted externally (✗ / clear_goal / idle-timeout): do NOT set a goal.
        if (ac.signal.aborted || this.wizardCancelled) {
            this.host.emit({
                type: "notice",
                level: "info",
                text: `Goal wizard cancelled${ac.signal.reason ? `：${String(ac.signal.reason?.message ?? ac.signal.reason)}` : ""}`,
            });
            this.wizardAbort = null;
            return;
        }
        if (!refinedGoal.trim()) {
            this.host.emit({
                type: "notice",
                level: "warning",
                text: "Wizard produced no valid goal, try again",
            });
            return;
        }
        if (this.host.activeConvId() !== wizardConversationId) {
            this.host.emit({
                type: "notice",
                level: "info",
                text: "Switched conversation; wizard result discarded",
            });
            return;
        }
        // Auto-set the refined goal. The wizard workflow implies "set a goal and
        // work until it passes", so default LOCKED=true unless the user explicitly
        // turned the lock off (a lock lets the review loop keep revising to pass;
        // without it the review is single-shot).
        const wantLocked = opts?.locked === undefined ? true : opts.locked;
        await this.setGoal(refinedGoal, {
            reviewModel: wgoal.reviewModel ?? undefined,
            maxRounds: opts?.maxRounds,
            locked: wantLocked,
            // The wizard kicks off generation itself below — avoid a double kick.
            autoStart: false,
        });
        this.wizardCancelled = false;
        this.wizardAbort = null;
        this.host.emit({
            type: "notice",
            level: "info",
            text: `Wizard done, goal set to: ${refinedGoal.slice(0, 80)}${refinedGoal.length > 80 ? "…" : ""}`,
        });
        // Kick the main agent into generating right away (no manual "go ahead").
        // The kick-off is a user message so it appears in the flow and triggers a
        // normal turn; the finishing agent_end then runs the review loop.
        try {
            await mainSession.sendUserMessage(`[Goal set]\n\n${wgoal.goal}\n\nPlease start implementing this goal now.`, { deliverAs: mainSession.isStreaming ? "steer" : "followUp" });
        }
        catch {
            // Generation kick-off is best-effort; the user can still prompt manually.
        }
    }
    /** Persist goal/review preference defaults (model, rounds cap, locked) without
     *  touching the active goal — so changes in the goal bar are remembered across
     *  reloads. maxRounds 0 = unlimited. Emits goal_status so the UI stays synced. */
    async setGoalPrefs(opts) {
        const goal = this.host.activeConv().goal;
        if (opts?.reviewModel !== undefined)
            goal.reviewModel = opts.reviewModel || null;
        if (typeof opts?.maxRounds === "number") {
            const mr = Math.round(opts.maxRounds);
            goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
        }
        if (opts?.locked !== undefined)
            goal.locked = opts.locked;
        this.prefs = {
            reviewModel: goal.reviewModel,
            maxRounds: goal.maxRounds,
            locked: goal.locked,
        };
        this.host.stateStore.saveGoalPrefs(this.host.clientId, {
            reviewModel: goal.reviewModel,
            maxRounds: goal.maxRounds,
            locked: goal.locked,
        });
        this.emitGoalStatus();
    }
    /** Clear the active goal (cancels the review loop AND aborts a running
     *  goal wizard — truly terminating its in-flight dialog + agent run). */
    async clearGoal() {
        const conv = this.host.activeConv();
        conv.goalGeneration += 1;
        const goal = conv.goal;
        goal.reviewing = false;
        goal.conversationId = null;
        goal.goal = null;
        goal.reviewing = false;
        goal.verdict = "pending";
        goal.feedback = undefined;
        goal.wizard.active = false;
        goal.wizard.status = "";
        goal.status = "";
        this.emitGoalStatus();
        // Abort a running wizard for real (✗ in the goal bar while scoping).
        if (this.wizardOwnerId === this.host.activeConvId()) {
            this.wizardCancelled = true;
            this.host.webUi.cancelPendingDialogs();
            this.wizardAbort?.abort();
            const ws2 = this.wizardSession;
            this.wizardSession = null;
            if (ws2) {
                await ws2.abort().catch(() => { });
                ws2.dispose();
            }
            this.wizardAbort = null;
        }
    }
    /**
     * agent_end hook. `aborted` = the finished run ended by manual stop; in that
     * case any active goal of THIS conversation is cleared so the review loop
     * stops too (a half-finished run must not be reviewed — endless loop).
     * Otherwise, spawn the isolated reviewer if a goal is pending. Returns a
     * notice text for the host to emit (manual-stop case), or null.
     */
    onAgentEnd(conv, aborted) {
        const g = conv.goal;
        if (aborted) {
            if (g.goal && g.conversationId === conv.id) {
                conv.goalGeneration += 1;
                g.conversationId = null;
                g.goal = null;
                g.reviewing = false;
                g.verdict = "pending";
                g.feedback = undefined;
                g.status = "Stopped manually; goal review aborted";
                this.emitGoalStatus();
                return "Stopped manually; goal review aborted (set a new goal to continue)";
            }
            return null;
        }
        // Goal review hook: after the run finished normally, if a goal is
        // active (and it belonged to the ACTIVE conversation) and we're not
        // already mid-review, spawn the isolated reviewer.
        if (g.goal &&
            g.conversationId === conv.id &&
            !g.reviewing &&
            !conv.wizardRunning &&
            !this.host.isDisposed()) {
            void this.runGoalReview(conv);
        }
        return null;
    }
    /** Build a "provider/id" or null for the reviewer model, validating it exists. */
    resolveReviewModel(spec) {
        return parseModelSpec(spec);
    }
    /**
     * The whitelisted reviewer plan — tell the reviewer what to decide and how
     * to report, regardless of which model it runs on.
     */
    reviewerPrompt(goal, round, maxRounds, output, gitDiff, customPrompt = "") {
        return [
            `You are a strict, independent goal-reviewer. Your ONLY job is to judge whether the agent's work fully satisfies the stated goal, by checking the agent's final output and, when present, its git diff.`, // eslint-disable-line max-len
            ``,
            `# Goal`, // eslint-disable-line no-regex-spaces
            goal,
            ``,
            `# Agent's final output`, // eslint-disable-line no-regex-spaces
            output.length > 0 ? output : "(the agent produced no text — inspect the diff)", // eslint-disable-line max-len
            ``,
            `# Git diff (if any)`, // eslint-disable-line no-regex-spaces
            gitDiff.length > 0 ? gitDiff : "(no staged/committed changes detected)", // eslint-disable-line max-len
            ``,
            `This is review round ${round}${maxRounds > 0 ? ` of up to ${maxRounds}` : " (no round cap — keep revising until it passes)"}.`, // eslint-disable-line max-len
            ...(customPrompt.trim()
                ? [``, `# Additional reviewer instructions`, customPrompt.trim()]
                : []),
            ``,
            `Decide: does the work satisfy the goal? If yes, respond with ONLY a JSON object with this exact shape (no markdown fences, no extra text):`, // eslint-disable-line max-len
            `{"verdict":"pass","feedback":"<one short sentence: what was satisfied>"}`, // eslint-disable-line max-len
            `If NO, respond with ONLY: {"verdict":"fail","feedback":"<concise, actionable list of what the agent must fix to satisfy the goal>"}`, // eslint-disable-line max-len
            `The feedback for a fail must be specific enough that the agent can act on it directly.`, // eslint-disable-line max-len
        ].join("\n");
    }
    /** Insert a wizard progress card into the MAIN conversation flow and render it
     *  IMMEDIATELY (the main session is idle while the wizard runs in its own
     *  session, so — unlike nextTurn, which queues until the next user prompt —
     *  sending without a delivery option appends + persists + emits at once). */
    async pushWizardCard(sess, text, details) {
        try {
            await sess.sendCustomMessage({
                customType: "goal-wizard",
                content: [{ type: "text", text }],
                display: true,
                details: { type: "goal-wizard", ...details },
            });
        }
        catch {
            // Card insertion is cosmetic — never block the question flow on it.
        }
    }
    isCurrentGoalReview(conv, goalGeneration, reviewGeneration) {
        return (!this.host.isDisposed() &&
            this.host.getConv(conv.id) === conv &&
            conv.goal.conversationId === conv.id &&
            conv.goalGeneration === goalGeneration &&
            conv.goalReviewGeneration === reviewGeneration &&
            !!conv.goal.goal);
    }
    /** Drop the result of a review that became stale while it was awaiting the
     * reviewer model (most commonly because the user switched conversations). */
    discardStaleGoalReview(conv, goalGeneration, reviewGeneration) {
        if (conv.goalReviewGeneration !== reviewGeneration)
            return;
        if (conv.goalGeneration === goalGeneration &&
            conv.goal.conversationId === conv.id) {
            conv.goal.reviewing = false;
            conv.goal.status = "Review aborted; goal was updated or cleared";
            this.emitGoalStatus();
        }
    }
    async runGoalReview(conv) {
        // The review is bound to the conversation that just ran. Capture both the
        // owner and a generation so a later switch/set/clear cannot let an old,
        // asynchronous reviewer mutate the new conversation's goal state.
        const mainConv = this.host.getConv(conv.id) ?? conv;
        const mainSession = mainConv.session;
        const g = conv.goal;
        if (!g.goal ||
            g.conversationId !== conv.id ||
            g.reviewing ||
            conv.wizardRunning ||
            this.host.isDisposed())
            return;
        const goalGeneration = conv.goalGeneration;
        const reviewGeneration = ++conv.goalReviewGeneration;
        // Narrowed copy — TS control-flow can't narrow `g.goal` (a mutable shared
        // object field) through the entire async body, so capture it here.
        const goalText = g.goal;
        // Capture review-only settings for this run. Changing settings while a
        // review is in flight affects the next review, never this one.
        const reviewPrefs = this.host.reviewSettings();
        const reviewPrompt = reviewPrefs.reviewPrompt;
        const reviewDisabledSkills = new Set(reviewPrefs.reviewDisabledSkills);
        // Cap rounds: single-shot (locked=false) always exactly one review.
        // For locked goals, maxRounds 0 = unlimited (keep revising until pass).
        const budget = g.locked ? (g.maxRounds > 0 ? g.maxRounds : Infinity) : 1;
        if (g.locked && g.maxRounds > 0 && g.round >= budget) {
            g.status = `Reached max rounds (${budget}); stopping review`;
            g.reviewing = false;
            this.emitGoalStatus();
            return;
        }
        g.reviewing = true;
        g.round += 1;
        g.verdict = "pending";
        g.feedback = undefined;
        g.status = `Reviewing (round ${g.round})…`;
        this.emitGoalStatus();
        // Collect the review inputs.
        let finalText = "";
        try {
            finalText = mainSession.getLastAssistantText() ?? "";
        }
        catch {
            finalText = "";
        }
        const diff = await this.host.gitDiff(mainConv.cwd);
        if (!this.isCurrentGoalReview(conv, goalGeneration, reviewGeneration)) {
            this.discardStaleGoalReview(conv, goalGeneration, reviewGeneration);
            return;
        }
        let reviewerVerdict = "fail";
        let reviewerFeedback = "(review could not finish)";
        try {
            const rmSpec = this.resolveReviewModel(g.reviewModel);
            const services = await createAgentSessionServices({
                cwd: mainConv.cwd,
                agentDir: this.host.agentDir,
                // The reviewer has its own skill allow/deny list. It deliberately does
                // not reuse the main session's disabledSkills setting.
                resourceLoaderOptions: {
                    skillsOverride: (res) => ({
                        ...res,
                        skills: res.skills.filter((s) => !reviewDisabledSkills.has(s.name)),
                    }),
                },
                // A FRESH ModelRuntime for the reviewer — isolated from the shared
                // one used by the main conversations, so its model choice is its own.
                modelRuntime: await ModelRuntime.create({
                    authPath: join(this.host.agentDir, "auth.json"),
                    modelsPath: join(this.host.agentDir, "models.json"),
                }),
            });
            // Model resolution: explicit reviewer model, else the main session's
            // current model (so a goal works even when no reviewer model is given).
            let model;
            if (rmSpec) {
                model = services.modelRuntime.getModel(rmSpec.provider, rmSpec.id);
            }
            if (!model) {
                const mainModel = mainSession.model;
                if (mainModel?.provider && mainModel.id) {
                    model = services.modelRuntime.getModel(mainModel.provider, mainModel.id);
                }
            }
            const srv = await createAgentSessionFromServices({
                services,
                sessionManager: SessionManager.inMemory(mainConv.cwd),
                ...(model ? { model } : {}),
            });
            const reviewCap = g.locked && g.maxRounds > 0 ? g.maxRounds : 0; // 0 = no cap
            const reviewer = srv.session;
            await reviewer.prompt(this.reviewerPrompt(goalText, g.round, reviewCap, finalText, diff, reviewPrompt));
            // Parse the reviewer's final output (expected to be a JSON object).
            const raw = reviewer.getLastAssistantText() ?? "";
            const m = raw.match(/\{\s*"verdict"\s*:\s*"(pass|fail)"[^}]*\}/);
            if (m) {
                reviewerVerdict = m[1];
                const fm = raw.match(/"feedback"\s*:\s*"([^"]*)"/);
                reviewerFeedback = fm?.[1] ?? "";
            }
            else {
                // No JSON — assume fail with the raw output as feedback.
                reviewerVerdict = "fail";
                reviewerFeedback = raw.slice(0, 2000);
            }
            await srv.session.dispose();
        }
        catch (err) {
            reviewerVerdict = "fail";
            reviewerFeedback = `Review error: ${err.message}`;
        }
        // The user may have switched chats or replaced/cleared the goal while the
        // isolated reviewer was running. Never apply a stale verdict or inject it
        // into the old session after that point.
        if (!this.isCurrentGoalReview(conv, goalGeneration, reviewGeneration)) {
            this.discardStaleGoalReview(conv, goalGeneration, reviewGeneration);
            return;
        }
        g.reviewing = false;
        g.verdict = reviewerVerdict;
        g.feedback = reviewerFeedback;
        const round = g.round;
        // Display cap: 0 means "unlimited" (keep revising until pass).
        const budgetForCard = g.locked ? (Number.isFinite(budget) ? budget : 0) : 1;
        const verdict = reviewerVerdict;
        const feedback = reviewerFeedback;
        /** Format "round/cap" for user-facing strings; cap 0 → unlimited. */
        const capFmt = (cap) => cap > 0 ? `round ${round}/${cap}` : `round ${round} (unlimited)`;
        if (verdict === "pass") {
            g.status = "Goal review passed";
            this.host.emit({ type: "notice", level: "info", text: "Goal review passed" });
            g.conversationId = null;
            g.goal = null; // a passed goal is done and cleared
            this.emitGoalStatus();
            // Pass = the review result goes straight into the conversation as an
            // ordinary user message (NO separate goal-review card). It both tells the
            // USER the outcome and hands the main agent back out of "goal mode", so a
            // follow-up instruction like "publish" is a normal request — not a confirm echo.
            try {
                await mainSession.sendUserMessage(`Goal reached and review passed (round ${round}).\n\nGoal: ${goalText}\n\n${feedback}\n\n(Goal mode is off; follow ordinary instructions from here.)`, { deliverAs: mainSession.isStreaming ? "steer" : "followUp" });
            }
            catch {
                // Best-effort.
            }
            this.host.flushSnapshot();
            return;
        }
        // Failure: if rounds remain, steer a revision; else report the loop done.
        // For unlimited (budget=0) isLastRound is always false → keeps revising.
        const isLastRound = !g.locked ? true : g.maxRounds > 0 && g.round >= g.maxRounds;
        if (!isLastRound) {
            g.status = `This round failed; sending notes to the agent (${capFmt(budgetForCard)})…`;
            this.host.emit({
                type: "notice",
                level: "warning",
                text: `Goal review round ${g.round}/${budgetForCard > 0 ? budgetForCard : "unlimited"} failed; sending feedback to the agent…`,
            });
            // Inject the reviewer's feedback into the main session to revise (this IS
            // the fail review result, as an ordinary user message — no separate card).
            try {
                const steerText = `[Goal review: round ${g.round}/${budgetForCard > 0 ? budgetForCard : "unlimited"} failed]\n\nGoal: ${goalText}\n\n` +
                    `Reviewer notes: ${feedback}\n\nChange the work so it fully meets the goal.`;
                await mainSession.sendUserMessage(steerText, {
                    deliverAs: mainSession.isStreaming ? "steer" : "followUp",
                });
            }
            catch (err) {
                g.status = `Failed to inject notes: ${err.message}`;
            }
            this.emitGoalStatus();
            this.host.flushSnapshot();
            return;
        }
        // Rounds exhausted (finite cap reached / single-shot failed). Deliver the
        // fail result as an ordinary user message (no separate card), like the pass
        // and revise paths — the review result always lands in the conversation.
        g.status =
            g.locked && g.maxRounds > 0
                ? `Reached max rounds (${g.maxRounds}); goal still failed`
                : `Goal failed (${capFmt(budgetForCard)})`;
        try {
            await mainSession.sendUserMessage(`Goal review failed (round ${round}/${budgetForCard > 0 ? budgetForCard : "unlimited"}).\n\nGoal: ${goalText}\n\nReviewer notes: ${feedback}`, { deliverAs: mainSession.isStreaming ? "steer" : "followUp" });
        }
        catch {
            // Best-effort.
        }
        this.host.emit({ type: "notice", level: "warning", text: "Goal review failed (max rounds reached)" });
        g.conversationId = null;
        g.goal = null; // loop exhausted — clear the active goal
        this.emitGoalStatus();
        this.host.flushSnapshot();
    }
}

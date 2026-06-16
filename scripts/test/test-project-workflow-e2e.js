#!/usr/bin/env node
/**
 * Project workflow E2E: multi-turn conversational tests through the real app path.
 *
 * Self-contained: every test creates an isolated temp state dir, seeds whatever
 * fixtures it needs, runs real --test turns, and deletes the dir on exit.
 * No dependency on the caller's ~/.pasture projects, missions, or agents.
 *
 * Rules (see E2E.md):
 * - NO mocking of internal functions after the first user message is sent.
 * - Setup allowed: createProject() seeds a project catalog entry only — no mission,
 *   no tasks, no pre-filled steps. Equivalent to agent fixtures in test-agent-team-e2e.js.
 * - All user messages must read like a real user (no tool names, no function names).
 * - Each turn calls `runE2E` with the same stateDir. History is persisted to disk
 *   between turns, exactly as in real usage.
 * - AI judge evaluates each reply — a "sorry" chain or empty acknowledgment fails.
 * - Every temp state dir is deleted in a finally block — no leftover test state.
 *
 * Requirements to run on any machine:
 * - A valid LLM config in ~/.pasture/config.json or PASTURE_STATE_DIR/config.json.
 * - API keys in ~/.pasture/.env (or the env dir).
 * - If neither is present the suite skips gracefully (exit 0).
 *
 * Usage:
 *   node scripts/test/test-project-workflow-e2e.js
 *   pnpm run test:project-workflow-e2e
 */

import { runSkillTests } from './skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from './e2e-judge.js';
import { createTempStateDir, runE2E, isNoLlmError } from './e2e-run.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temp state dir, run the test body, then always delete the dir.
 * Ensures no leftover projects, missions, or chat history after each test.
 *
 * @param {(stateDir: string) => Promise<any>} fn
 */
async function withTempStateDir(fn) {
  const stateDir = createTempStateDir();
  try {
    return await fn(stateDir);
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Write a minimal agents/main/config.json to the temp stateDir BEFORE the first
 * runE2E call.
 *
 * Why: ensureMainAgentInitialized() inside the child process sees an empty
 * agents/main/config.json and, if it IS empty, migrates the global config.json
 * (which was copied from the user's real ~/.pasture). That real config may have
 * 'agent-send' in skills.enabled plus 'alex'/'marketer' in agentMessaging.allow.
 * The LLM then calls agent-send, which fails with "Known agents: none."
 *
 * A non-empty stub stops the migration. The agent uses DEFAULT_ENABLED skills
 * (no agent-send), which is the correct baseline for single-agent project work.
 */
function initMainAgentStub(stateDir) {
  mkdirSync(join(stateDir, 'agents', 'main'), { recursive: true });
  writeFileSync(
    join(stateDir, 'agents', 'main', 'config.json'),
    JSON.stringify({ title: 'Main' }, null, 2),
    'utf8',
  );
}

/**
 * Seed a project catalog entry (name, description, url) in stateDir.
 * No mission, no tasks, no plan — the agent must figure those out.
 * All writes go into stateDir; deleted by withTempStateDir on cleanup.
 */
async function seedProjectOnly(stateDir, { name, description, url }) {
  const prev = process.env.PASTURE_STATE_DIR;
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const { createProject } = await import('../../lib/context/projects-db.js');
    createProject({ name, description, url });
  } finally {
    if (prev !== undefined) process.env.PASTURE_STATE_DIR = prev;
    else delete process.env.PASTURE_STATE_DIR;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Ask the AI judge whether the user got what they wanted.
 * `criteria` replaces the generic hint with scenario-specific pass/fail rules.
 */
async function judge(input, reply, stateDir, criteria) {
  return judgeUserGotWhatTheyWanted(input, reply, stateDir, {
    prompt: `You are a test judge for an AI assistant that helps users with project planning.

User said:
"${input}"

Bot replied:
---
${reply}
---

${criteria}

Answer with exactly one line: YES or NO. Then add one short sentence explaining why.`,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Project workflow E2E (multi-turn conversational, self-contained, cleanup on exit)\n');

  const tests = [
    // ── 1. Known project ──────────────────────────────────────────────────────
    {
      name: 'known project — agent acknowledges it and offers concrete next steps',
      input: "What's the status of NextPostAI and what should we focus on next?",
      expectMode: 'behavior',
      run: () => withTempStateDir(async (stateDir) => {
        initMainAgentStub(stateDir);
        await seedProjectOnly(stateDir, {
          name: 'NextPostAI',
          description: 'AI-powered marketing platform that helps creators schedule and optimize social posts',
          url: 'https://nextpostai.com',
        });
        const { reply, skillsCalled } = await runE2E(
          "What's the status of NextPostAI and what should we focus on next?",
          { stateDir },
        );
        assert(reply && reply.trim().length > 0, 'Expected non-empty reply');
        assert(
          !/^\s*(sorry|i can'?t|i'm unable)/i.test(reply),
          `Expected substantive reply, not a refusal: ${reply.slice(0, 200)}`,
        );
        const { pass, reason } = await judge(
          "What's the status of NextPostAI and what should we focus on next?",
          reply,
          stateDir,
          'The user asked about an existing project (NextPostAI — an AI marketing SaaS) and what to focus on next. ' +
          'Pass if the bot is substantive: it acknowledges the project by name, gives any status, ' +
          'proposes a specific area to focus on (growth, users, features, analytics, etc.), ' +
          'asks a clarifying question about goals, OR suggests setting up a plan. ' +
          'A flat "I can help with that, what would you like to do?" with no concrete angle is NO. ' +
          'A "sorry" or complete off-topic reply is NO.',
        );
        assert(pass, `Judge: ${reason}`);
        return { reply, skillsCalled };
      }),
    },

    // ── 2. Brand-new project, no catalog entry ────────────────────────────────
    {
      name: 'new project introduced cold — agent engages, does not deflect',
      input: "I've been building a SaaS called TideApp that helps small teams track their weekly sprints. I want to start growing it.",
      expectMode: 'behavior',
      run: () => withTempStateDir(async (stateDir) => {
        initMainAgentStub(stateDir);
        const { reply, skillsCalled } = await runE2E(
          "I've been building a SaaS called TideApp that helps small teams track their weekly sprints. I want to start growing it.",
          { stateDir },
        );
        assert(reply && reply.trim().length > 0, 'Expected non-empty reply');
        assert(
          !/^\s*(sorry|i can'?t|i'm unable)/i.test(reply),
          `Expected engaged reply, not a refusal: ${reply.slice(0, 200)}`,
        );
        const { pass, reason } = await judge(
          "I've been building a SaaS called TideApp that helps small teams track their weekly sprints. I want to start growing it.",
          reply,
          stateDir,
          'The user introduced a new product (TideApp — sprint tracking SaaS) and said they want to grow it. ' +
          'No project exists in the system yet. ' +
          'Pass if the bot responds with substance: asks for more context (URL, current users, goals), ' +
          'proposes a setup step, suggests a growth angle, or begins discussing strategy. ' +
          'A reply that just says "sounds great, tell me more" with no specific question or direction is borderline — ' +
          'pass ONLY if at least one concrete aspect is raised (e.g. "what is your current user count?", ' +
          '"do you have analytics set up?", "what channels are you using?"). ' +
          'A refusal or generic filler with no engagement is NO.',
        );
        assert(pass, `Judge: ${reason}`);
        return { reply, skillsCalled };
      }),
    },

    // ── 3. Two-turn: introduce then confirm setup ─────────────────────────────
    {
      name: 'new project two-turn: introduce → approve setup',
      input: 'Turn 1: introduce TideApp → Turn 2: yes, set it up',
      expectMode: 'behavior',
      run: () => withTempStateDir(async (stateDir) => {
        initMainAgentStub(stateDir);
        // Turn 1 — give the agent enough context
        await runE2E(
          "I want to grow a product called TideApp — it's a sprint tracking tool for small engineering teams. The URL is tideapp.io.",
          { stateDir },
        );
        // Turn 2 — approve
        const { reply, skillsCalled } = await runE2E(
          "Yes, go ahead and set it up. Let's create a plan.",
          { stateDir },
        );
        assert(reply && reply.trim().length > 0, 'Expected non-empty reply on turn 2');
        const { pass, reason } = await judge(
          "Yes, go ahead and set it up. Let's create a plan.",
          reply,
          stateDir,
          'The user confirmed they want to set up and plan a project (TideApp) after introducing it in the previous turn. ' +
          'Pass if the bot is concrete: it presents a plan preview with at least one specific task or area, ' +
          'confirms the project was registered, asks for one more piece of confirmation before creating tasks, ' +
          'OR creates the mission and describes the first step. ' +
          'A reply that only says "okay, I\'ll keep that in mind" or "let me know what to do" is NO. ' +
          'The reply must include at least one specific action, task name, or work area.',
        );
        assert(pass, `Judge: ${reason}`);
        return { reply, skillsCalled };
      }),
    },

    // ── 4. Plan proposal — must NOT claim all work is done immediately ─────────
    {
      name: 'plan proposal — proposes tasks without falsely claiming all work is done',
      input: 'Can you put together a growth plan for NextPostAI and start working on it?',
      expectMode: 'behavior',
      run: () => withTempStateDir(async (stateDir) => {
        initMainAgentStub(stateDir);
        await seedProjectOnly(stateDir, {
          name: 'NextPostAI',
          description: 'AI-powered marketing platform for creators',
          url: 'https://nextpostai.com',
        });
        const { reply, skillsCalled } = await runE2E(
          'Can you put together a growth plan for NextPostAI and start working on it?',
          { stateDir },
        );
        assert(reply && reply.trim().length > 0, 'Expected non-empty reply');
        // Hard check: agent must not claim all tasks are done in the same response that created them
        const falselyAllDone =
          /all.*(?:tasks?|steps?|work).*(?:done|complete|finished)|(?:completed|finished) all|everything.*done/i.test(reply);
        assert(
          !falselyAllDone,
          `Agent falsely claimed all work is done in a single response: ${reply.slice(0, 300)}`,
        );
        const { pass, reason } = await judge(
          'Can you put together a growth plan for NextPostAI and start working on it?',
          reply,
          stateDir,
          'The user asked to create a growth plan for NextPostAI (an AI marketing SaaS) and start executing it. ' +
          'Pass if the bot proposes a plan with at least one specific task or area ' +
          '(e.g. user research, analytics, SEO, content, landing page, onboarding), ' +
          'OR creates a mission and describes what it will tackle first. ' +
          'CRITICAL: A reply that marks all proposed tasks as "completed" in the very same response ' +
          'before any real work has been done is NO — the bot cannot complete weeks of work in one turn. ' +
          'If tasks are proposed (not marked done), or the bot describes what it will start on, that is YES.',
        );
        assert(pass, `Judge: ${reason}`);
        return { reply, skillsCalled };
      }),
    },

    // ── 5. Three-turn: introduce → approve → status check ─────────────────────
    {
      name: 'three-turn workflow: introduce project → approve plan → ask for current status',
      input: 'Turn 1: introduce PastureDemo → Turn 2: approve → Turn 3: what are we working on?',
      expectMode: 'behavior',
      run: () => withTempStateDir(async (stateDir) => {
        initMainAgentStub(stateDir);
        // Turn 1 — introduce a brand-new project
        await runE2E(
          "We have a product called PastureDemo — it helps cattle farmers track herd health on their phones. I want to create a plan to get our first 50 paying customers.",
          { stateDir },
        );
        // Turn 2 — approve
        await runE2E(
          "Yes, go ahead and create the mission and the tasks.",
          { stateDir },
        );
        // Turn 3 — status; agent must reference what was just created
        const finalMessage = "What are we working on for PastureDemo right now?";
        const { reply, skillsCalled } = await runE2E(finalMessage, { stateDir });
        assert(reply && reply.trim().length > 0, 'Expected non-empty status reply on turn 3');
        assert(
          !/^\s*(sorry|i can'?t|i'm unable)/i.test(reply),
          `Expected a status reply, not a refusal: ${reply.slice(0, 200)}`,
        );
        const { pass, reason } = await judge(
          finalMessage,
          reply,
          stateDir,
          'The user asked for the current work status on PastureDemo after a plan was just created in prior turns. ' +
          'Pass if the bot refers to actual tasks or mission state: mentions a specific area being worked on, ' +
          'names a first task or milestone, describes what the plan covers, ' +
          'or says the plan was just created and outlines what comes next. ' +
          'A completely generic reply that ignores the previous conversation is NO. ' +
          'A reply that says "we\'re working on X" or "the first step is Y" referencing this product is YES.',
        );
        assert(pass, `Judge: ${reason}`);
        return { reply, skillsCalled };
      }),
    },

    // ── 6. Project in catalog, no mission — agent proposes without being told how
    {
      name: 'project exists, no mission — agent proposes where to start without being handed steps',
      input: "Let's start working on NextPostAI. Where should we begin?",
      expectMode: 'behavior',
      run: () => withTempStateDir(async (stateDir) => {
        initMainAgentStub(stateDir);
        await seedProjectOnly(stateDir, {
          name: 'NextPostAI',
          description: 'AI marketing platform that helps creators schedule and optimize social media posts',
          url: 'https://nextpostai.com',
        });
        const { reply, skillsCalled } = await runE2E(
          "Let's start working on NextPostAI. Where should we begin?",
          { stateDir },
        );
        assert(reply && reply.trim().length > 0, 'Expected non-empty reply');
        const { pass, reason } = await judge(
          "Let's start working on NextPostAI. Where should we begin?",
          reply,
          stateDir,
          'The user wants to start working on NextPostAI (an AI marketing SaaS) and is asking where to begin. ' +
          'No mission exists yet — the agent must decide where to start on its own. ' +
          'Pass if the bot gives a concrete starting point: proposes a discovery step, ' +
          'asks a focused question about goals or current metrics, ' +
          'suggests a specific area (growth, analytics, user research, content, SEO), ' +
          'OR proposes a mission/plan setup. ' +
          'A vague "I\'m ready to help, what would you like to do?" with no direction is NO. ' +
          'If the bot mentions content strategy, user acquisition, analytics, or any concrete growth area for a marketing SaaS, that is YES.',
        );
        assert(pass, `Judge: ${reason}`);
        return { reply, skillsCalled };
      }),
    },

    // ── 7. Completely clean state — agent must ask, not hallucinate ────────────
    {
      name: 'no context — agent asks clarifying questions instead of fabricating a generic plan',
      input: "I want to get more customers. What's the plan?",
      expectMode: 'behavior',
      run: () => withTempStateDir(async (stateDir) => {
        initMainAgentStub(stateDir);
        const { reply, skillsCalled } = await runE2E(
          "I want to get more customers. What's the plan?",
          { stateDir },
        );
        assert(reply && reply.trim().length > 0, 'Expected non-empty reply');
        assert(
          !/^\s*(sorry|i can'?t|i'm unable)/i.test(reply),
          `Expected engagement, not refusal: ${reply.slice(0, 200)}`,
        );
        const { pass, reason } = await judge(
          "I want to get more customers. What's the plan?",
          reply,
          stateDir,
          'The user asked a vague growth question with zero business context in a clean session. ' +
          'Pass if the bot asks at least one specific clarifying question to understand the business ' +
          '(e.g. what product, what industry, current user count, current channels) ' +
          'OR gives a useful general framework while noting it needs more context. ' +
          'A completely made-up detailed plan with no clarification for a business the bot knows nothing about ' +
          'is worse than asking — but still passes if the plan is explicitly framed as a starting template. ' +
          'A flat "sorry, I can\'t help" or a one-liner with no substance is NO.',
        );
        assert(pass, `Judge: ${reason}`);
        return { reply, skillsCalled };
      }),
    },
  ];

  try {
    const { failed } = await runSkillTests('project-workflow-e2e', tests);
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    if (isNoLlmError(err)) {
      console.log('\nSKIP project-workflow E2E: LLM not configured.');
      process.exit(0);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

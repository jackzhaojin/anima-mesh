import { describe, it, expect } from "vitest";
import { makeTree, cleanup, concept } from "./helpers.js";
import { runAgent } from "../src/harness/run.js";
import { createMoonshotApiProvider } from "../src/providers/moonshot-api.js";

/**
 * AI-driven eval — env-gated (LIVE_EVAL=1), skipped in `pnpm verify`.
 * The deterministic golden day (golden-day.test.ts) proves the machinery;
 * this proves the COGNITION: a real model writes a brief over a scripted
 * mesh day, and a second model call judges it against a rubric. Two Kimi
 * calls per run. This is the regression net for prompt/context changes —
 * run it whenever buildPrompt or an agent's job description changes.
 *
 *   set -a; source /path/to/your-instance/.env.local; set +a
 *   LIVE_EVAL=1 pnpm test:live
 */

const env = process.env as Record<string, string | undefined>;
const MODEL = () => env.KIMI_MODEL ?? "kimi-for-coding";

interface Verdict {
  mentionsDiscrepancy: boolean;
  mentionsNag: boolean;
  flagsApproval: boolean;
  honestAboutQuietRadar: boolean;
  score: number;
  reasons: string;
}

/** Judge a brief against the golden-day rubric via one model call. */
async function judge(brief: string): Promise<Verdict> {
  const provider = createMoonshotApiProvider({ env });
  const result = await provider.run({
    cwd: process.cwd(),
    model: MODEL(),
    prompt: [
      "You are a strict evaluator of an AI chief-of-staff's daily brief.",
      "The ground truth for the day:",
      "- The bookkeeper found ONE $120 discrepancy that needs the principal.",
      "- Research radar was quiet (no action required).",
      "- There is a standing nag: the bank export is still pending (day 5).",
      "- There is one pending approval: file the annual return.",
      "",
      "Judge the brief below. Return ONLY strict JSON (no code fences, no prose):",
      '{"mentionsDiscrepancy": bool, "mentionsNag": bool, "flagsApproval": bool,',
      ' "honestAboutQuietRadar": bool, "score": 0-10, "reasons": "one sentence"}',
      "",
      "score: overall quality as a principal's daily brief (concise, honest,",
      "action-oriented, nothing invented).",
      "",
      "--- BRIEF UNDER EVALUATION ---",
      brief,
    ].join("\n"),
  });
  const raw = result.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(raw) as Verdict;
}

describe.skipIf(env.LIVE_EVAL !== "1")("live eval: a real brief over the golden day, model-judged", () => {
  it("the chief-of-staff's real brief passes the rubric", async () => {
    const yts = "2026-07-10T12:00:00.000Z";
    const root = await makeTree({
      "animamesh.config.json": JSON.stringify({ bundle: "bundle" }),
      "bundle/index.md": concept("index", { title: "Eval Mesh" }, "# Index\n"),
      "bundle/log.md": concept("log", {}, "# Log\n"),
      "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
      "bundle/ops/nags.md": concept("nags", {}, "# Nags\n\n1. Bank export still pending — day 5 of asking.\n"),
      "bundle/agents/chief-of-staff.md": concept(
        "agent",
        { name: "chief-of-staff", title: "Chief of Staff", level: "L1", model: MODEL(), harness: "moonshot-api" },
        "Write the principal's daily brief from today's mesh reports: what happened, what needs them, honest about quiet areas.",
      ),
      // Today's spoke reports, already on disk — the hub reads the day.
      "reports/2026-07-11-bookkeeper-aaaa0000.md":
        "---\ntype: report\n---\n\n## Books\n\nCapital events reconciled; one $120 discrepancy needs the principal.\n",
      "reports/2026-07-11-research-watch-bbbb0000.md":
        "---\ntype: report\n---\n\n## Radar\n\nQuiet. Two minor competitor notes, no action required.\n",
      "approvals/appr-eval.json": JSON.stringify({
        id: "appr-eval",
        actionType: "government-filing",
        summary: "file the annual return",
        requestedBy: "bookkeeper",
        requestedAt: `${yts}`,
        status: "pending",
      }),
      "ledger/actions.jsonl": "",
    });
    try {
      const report = await runAgent({
        instanceRoot: root,
        agentName: "chief-of-staff",
        providerCtx: { env },
        now: new Date("2026-07-11T16:00:00Z"),
        timeZone: "America/New_York",
      });
      expect(report.ok).toBe(true);

      const verdict = await judge(report.text);
      // The rubric: the brief must surface what needs the principal and be
      // honest about what doesn't. Judged by a model, asserted in code.
      expect(verdict.mentionsDiscrepancy, verdict.reasons).toBe(true);
      expect(verdict.mentionsNag, verdict.reasons).toBe(true);
      expect(verdict.score, verdict.reasons).toBeGreaterThanOrEqual(6);
    } finally {
      await cleanup(root);
    }
  }, 300_000);
});

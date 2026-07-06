import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { scaffoldBrain } from "../src/init/scaffold.js";
import { normalizeAnswers, loadAnswersFile, agenticEnrich } from "../src/init/interview.js";
import { listAgentTemplates, fillTemplate } from "../src/init/templates.js";
import { loadBundle } from "../src/okf/bundle.js";
import { checkConformance } from "../src/okf/conformance.js";
import { loadInstance } from "../src/instance/config.js";
import { runAgent } from "../src/harness/run.js";
import { FakeProvider } from "../src/providers/fake.js";

const roots: string[] = [];
async function freshDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "animamesh-init-"));
  roots.push(root);
  return path.join(root, "brain"); // scaffold into a not-yet-existing subdir
}
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

const BASE = {
  orgName: "Acme Research Co",
  principalName: "Ada Founder",
  principalEmail: "ada@acme.example",
  personaName: "Juniper Vale",
  description: "A one-person research company testing agentic operations.",
  agents: ["compliance-ops", "research-watch", "chief-of-staff"],
  now: "2026-07-05T12:00:00Z",
};

describe("agentic init — the acceptance test from the PRD", () => {
  it("empty directory → brain repo that passes animamesh conformance", async () => {
    const target = await freshDir();
    const result = await scaffoldBrain(target, normalizeAnswers(BASE));

    expect(result.conformance.ok).toBe(true);

    // Independent re-check — not trusting the scaffolder's own report.
    const bundle = await loadBundle(path.join(target, "bundle"));
    const report = checkConformance(bundle, "animamesh");
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.level === "error")).toHaveLength(0);

    // Reserved files + constitution marked immutable (the PRD's exact wording).
    expect(existsSync(path.join(target, "bundle/index.md"))).toBe(true);
    expect(existsSync(path.join(target, "bundle/log.md"))).toBe(true);
    const constitution = readFileSync(path.join(target, "bundle/constitution.md"), "utf8");
    expect(constitution).toContain("immutable: true");
    expect(constitution).toContain("money-movement");
  });

  it("substitutes identity into templates and config — identity-plural by design", async () => {
    const target = await freshDir();
    await scaffoldBrain(target, normalizeAnswers(BASE));

    const cos = readFileSync(path.join(target, "bundle/agents/chief-of-staff.md"), "utf8");
    expect(cos).toContain("Juniper Vale");
    expect(cos).toContain("Acme Research Co");
    expect(cos).not.toContain("{{");

    const instance = loadInstance(target);
    expect(instance.config.identity!.principal.name).toBe("Ada Founder");
    expect(instance.config.identity!.persona!.name).toBe("Juniper Vale");
    expect(instance.config.activation).toEqual({ boundaryMapVerified: false, optionTrigger: null, founderWaiver: false });
  });

  it("refuses a non-empty target", async () => {
    const target = await freshDir();
    await scaffoldBrain(target, normalizeAnswers(BASE));
    await expect(scaffoldBrain(target, normalizeAnswers(BASE))).rejects.toThrow(/not empty/);
  });

  it("a scaffolded brain is immediately runnable end-to-end", async () => {
    const target = await freshDir();
    await scaffoldBrain(target, normalizeAnswers(BASE));
    const fake = new FakeProvider(() => ({ text: "## Brief\n\nNothing needs you today." }));
    const run = await runAgent({ instanceRoot: target, agentName: "compliance-ops", provider: fake });
    expect(run.ok).toBe(true);
    // The scaffolded calendar made it into the prompt — bundle-grounded, not recalled.
    expect(fake.calls[0]!.prompt).toContain("Compliance calendar");
  });

  it("scaffolded commercial agents stay dual-gated out of the box", async () => {
    const target = await freshDir();
    await scaffoldBrain(target, normalizeAnswers({ ...BASE, agents: ["compliance-ops", "inbound-triage"] }));
    await expect(
      runAgent({ instanceRoot: target, agentName: "inbound-triage", provider: new FakeProvider() }),
    ).rejects.toThrow(/dual-gated/);
  });
});

describe("answers plumbing", () => {
  it("normalize requires org and principal, validates templates", () => {
    expect(() => normalizeAnswers({ principalName: "x", agents: [] })).toThrow(/orgName/);
    expect(() => normalizeAnswers({ orgName: "x", agents: [] })).toThrow(/principalName/);
    expect(() => normalizeAnswers({ orgName: "x", principalName: "y", agents: ["nope"] })).toThrow(/unknown agent template/);
  });

  it("loads an answers file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "animamesh-answers-"));
    roots.push(dir);
    const file = path.join(dir, "answers.json");
    await writeFile(file, JSON.stringify({ orgName: "Z Corp", principalName: "Zed", agents: ["bookkeeper"] }));
    const answers = loadAnswersFile(file);
    expect(answers.orgName).toBe("Z Corp");
    expect(answers.agents).toEqual(["bookkeeper"]);
  });

  it("every shipped template renders cleanly", () => {
    const templates = listAgentTemplates();
    expect(templates).toContain("compliance-ops");
    expect(templates).toContain("chief-of-staff");
    expect(templates).toContain("sales-qualification");
    expect(templates.length).toBeGreaterThanOrEqual(9);
    for (const name of templates) {
      const rendered = fillTemplate(
        readFileSync(path.join(HERE, "..", "templates", "agents", `${name}.md`), "utf8"),
        { ORG_NAME: "O", PRINCIPAL_NAME: "P", PERSONA_NAME: "A", DEFAULT_MODEL: "m", DEFAULT_HARNESS: "fake" },
      );
      expect(rendered).not.toContain("{{");
    }
  });
});

describe("agentic enrichment — model proposes, code disposes", () => {
  const base = normalizeAnswers({ orgName: "Solo Studio", principalName: "Sam", agents: ["compliance-ops"] });

  it("adopts a valid suggestion", async () => {
    const provider = new FakeProvider(() => ({
      text: JSON.stringify({ description: "A studio.", agents: ["compliance-ops", "research-watch"], personaName: "Quill" }),
    }));
    const enriched = await agenticEnrich(base, provider);
    expect(enriched.agents).toEqual(["compliance-ops", "research-watch"]);
    expect(enriched.personaName).toBe("Quill");
    expect(enriched.description).toBe("A studio.");
  });

  it("strips unknown agents from suggestions", async () => {
    const provider = new FakeProvider(() => ({
      text: JSON.stringify({ agents: ["research-watch", "world-domination"] }),
    }));
    const enriched = await agenticEnrich(base, provider);
    expect(enriched.agents).toEqual(["research-watch"]);
  });

  it("survives fenced and prose-wrapped JSON", async () => {
    const provider = new FakeProvider(() => ({
      text: 'Sure! Here you go:\n```json\n{"agents": ["bookkeeper"]}\n```\nHope that helps!',
    }));
    const enriched = await agenticEnrich(base, provider);
    expect(enriched.agents).toEqual(["bookkeeper"]);
  });

  it("falls back to human answers on garbage output — advisory only", async () => {
    const provider = new FakeProvider(() => ({ text: "I am not JSON at all" }));
    const enriched = await agenticEnrich(base, provider);
    expect(enriched).toEqual(base);
  });

  it("never lets a suggestion override an explicit human persona choice", async () => {
    const withPersona = { ...base, personaName: "Iris" };
    const provider = new FakeProvider(() => ({ text: JSON.stringify({ personaName: "Rival" }) }));
    const enriched = await agenticEnrich(withPersona, provider);
    expect(enriched.personaName).toBe("Iris");
  });
});

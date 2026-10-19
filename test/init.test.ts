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
import { runDirectionCore } from "../src/harness/direction-core.js";
import { FsInstanceStore } from "../src/instance/store-fs.js";

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
    // OKF v0.2 (v2.2.0): init output is spec-clean, not merely error-free.
    expect(report.issues.filter((i) => i.rule.startsWith("okf/"))).toEqual([]);
    expect(readFileSync(path.join(target, "bundle/index.md"), "utf8")).toMatch(/^---\nokf_version: "0\.2"\n---/);
    expect(readFileSync(path.join(target, "bundle/log.md"), "utf8")).toMatch(/^# Bundle log[\s\S]*\n## 2026-07-05\n/);
    const facts = bundle.concepts.find((c) => c.frontmatter.type === "fact")!;
    expect(facts.frontmatter.status).toBeUndefined();
    expect(facts.frontmatter.verified).toBeUndefined();
    expect(facts.frontmatter.generated).toMatchObject({ by: expect.stringMatching(/^anima-mesh\//), at: "2026-07-05T12:00:00.000Z" });

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

  it.each(["org", "person", "team", "group"] as const)(
    "%s brains know the core feedback path and file only after the narrow grant",
    async (brainKind) => {
      const target = await freshDir();
      await scaffoldBrain(target, {
        ...normalizeAnswers(BASE), brainKind, agents: ["chief-of-staff"],
        engineRepo: "github.com/example/engine", defaultHarness: "fake", defaultModel: "fake",
      });
      const store = new FsInstanceStore(target);
      const title = "Source listing drops its continuation cursor";
      const fake = new FakeProvider(() => ({
        text: `Engine feedback.\n\n\`\`\`defect-report\ntitle: ${title}\n---\nRepro: return two listing pages; only the first page is shown.\n\`\`\``,
      }));
      const requests: { url: string; method: string; body?: unknown }[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        return method === "POST"
          ? new Response(JSON.stringify({ html_url: "https://github.com/example/engine/issues/9", number: 9 }), { status: 201 })
          : new Response("[]");
      };
      const options = {
        store, provider: fake, providerCtx: { env: { GITHUB_DEFECTS_TOKEN: "test-issue-token" }, fetchImpl },
        message: { channel: "test", sender: "operator", text: "Report this engine listing defect.", receivedAt: BASE.now },
      };

      // New hubs know how filing works, but a credential cannot bypass L1.
      expect((await runDirectionCore(options)).ok).toBe(true);
      expect(fake.calls[0]!.prompt).toContain("# Engine feedback");
      expect(fake.calls[0]!.prompt).toContain("The automatic filing path never falls back");
      expect(fake.calls[0]!.prompt).not.toMatch(/ops\/engine-feedback\.md[^\n]*NOT AVAILABLE/);
      expect(requests).toEqual([]);
      expect((await store.readLedger()).some((e) => e.action === "defect-report-denied")).toBe(true);

      // The operator's narrow promotion activates the same scaffolded path.
      const hubFile = path.join(target, "bundle/agents/chief-of-staff.md");
      await writeFile(hubFile, readFileSync(hubFile, "utf8")
        .replace("level: L1", "level: L3").replace("whitelist: []", "whitelist: [defect-report]"));
      const filed = await runDirectionCore(options);
      expect(filed.ok).toBe(true);
      expect(requests.filter((r) => r.method === "POST")).toEqual([{
        url: "https://api.github.com/repos/example/engine/issues", method: "POST",
        body: { title, body: "Repro: return two listing pages; only the first page is shown.", labels: ["defect"] },
      }]);
      expect((await store.readLedger()).find((e) => e.action === "defect-filed")?.detail)
        .toMatchObject({ url: "https://github.com/example/engine/issues/9" });
      expect(readFileSync(filed.reportPath, "utf8")).toContain("https://github.com/example/engine/issues/9");
    },
  );
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

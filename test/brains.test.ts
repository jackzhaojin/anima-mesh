import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import { runAgent } from "../src/harness/run.js";
import { FakeProvider } from "../src/providers/fake.js";
import { FsInstanceStore } from "../src/instance/store-fs.js";
import { loadBundle } from "../src/okf/bundle.js";
import { loadGatedTypes, assertActionAllowed, GateViolation } from "../src/gates/gatekeeper.js";
import {
  brainConfigProblems,
  brainIssues,
  computeExport,
  readOnlyStore,
  shareAdmits,
  effectiveMembers,
  assertMayDecide,
  INVERSE_RELATION,
} from "../src/brains/core.js";
import { brainsSection, readBrainPath, linkTokenEnv } from "../src/sources/brains.js";
import { localBrainOpener } from "../src/brains/local.js";
import type { InstanceConfig, MemberConfig } from "../src/instance/config-core.js";

/**
 * The mesh of brains (v2.0.0). What must hold forever:
 *  - deny by default: an unmarked concept never crosses a link;
 *  - the EXPORTER's config and markings decide what crosses, never the reader's;
 *  - a link is live only when both sides declare it with inverse relations;
 *  - a linked brain is opened read-only (writes throw, in code);
 *  - a child brain answers to its ancestors' gates (union, never relief);
 *  - with members declared, only owner/approver members decide approvals.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

const base = (bundleFiles: Record<string, string>, config: Record<string, unknown>, prefix: string) => ({
  [`${prefix}/animamesh.config.json`]: JSON.stringify({ bundle: "bundle", ...config }, null, 2),
  [`${prefix}/bundle/index.md`]: concept("index", {}, "# Index\n"),
  [`${prefix}/bundle/log.md`]: concept("log", {}, "# Log\n"),
  [`${prefix}/bundle/constitution.md`]: concept("constitution", { immutable: true, "gated-actions": ["org-custom-gate"] }, "# Org constitution\n\nNo client work.\n"),
  ...Object.fromEntries(Object.entries(bundleFiles).map(([k, v]) => [`${prefix}/bundle/${k}`, v])),
});

/** Two sibling brains: a person (`me`) who is a member of an org (`acme`). */
async function makePair(opts: {
  personLinks?: unknown[];
  orgLinks?: unknown[];
  orgFiles?: Record<string, string>;
  personFiles?: Record<string, string>;
  extra?: Record<string, string>;
} = {}) {
  const files = {
    ...base(
      {
        "agents/hub.md": concept(
          "agent",
          { name: "chief-of-staff", title: "Personal chief of staff", level: "L1", model: "m", harness: "fake", sources: ["brains"] },
          "Brief the person.",
        ),
        ...(opts.personFiles ?? {}),
      },
      {
        brain: { id: "me", kind: "person", name: "A. Person" },
        links: opts.personLinks ?? [{ id: "acme", relation: "member-of", role: "owner", localPath: "../brain-acme" }],
      },
      "brain-me",
    ),
    ...base(
      {
        "ops/nags.md": concept("nags", { share: ["me"] }, "# Nags\n\n- SIGN-THE-RESOLUTION (founder only)\n"),
        "ops/calendar.md": concept("calendar", { share: ["members"] }, "# Calendar\n\n- 2027-03-01 franchise tax\n"),
        "facts/bank.md": concept("fact", {}, "# Bank\n\nPRIVATE-ACCOUNT-DETAIL\n"),
        "facts/partner-note.md": concept("fact", { share: ["peers"] }, "# Partner note\n\nPEERS-ONLY\n"),
        ...(opts.orgFiles ?? {}),
      },
      {
        brain: { id: "acme", kind: "org", name: "Acme Co" },
        links: opts.orgLinks ?? [{ id: "me", relation: "has-member", role: "owner", localPath: "../brain-me", grants: { brief: true } }],
        delivery: { deliverAgent: "chief-of-staff" },
      },
      "brain-acme",
    ),
    "brain-acme/reports/2026-10-09-chief-of-staff-aaaa1111.md": "---\ntype: report\n---\n\nORG-BRIEF-OLD\n",
    "brain-acme/reports/2026-10-10-chief-of-staff-bbbb2222.md": "---\ntype: report\n---\n\nORG-BRIEF-NEW\n",
    ...(opts.extra ?? {}),
  };
  const root = await makeTree(files);
  roots.push(root);
  return { root, me: path.join(root, "brain-me"), acme: path.join(root, "brain-acme") };
}

async function promptFor(instanceRoot: string): Promise<string> {
  const provider = new FakeProvider();
  await runAgent({ instanceRoot, agentName: "chief-of-staff", provider, runId: "run-brains" });
  return provider.calls[0]!.prompt;
}

describe("brain config validation", () => {
  const ok: InstanceConfig = {
    bundle: "bundle",
    ledger: "l",
    approvals: "a",
    reports: "r",
    drafts: "d",
    brain: { id: "me", kind: "person" },
    links: [{ id: "acme", relation: "member-of", localPath: "../brain-acme" }],
  };

  it("accepts a well-formed identity + link map", () => {
    expect(brainConfigProblems(ok)).toEqual([]);
  });

  it("rejects bad ids, reserved words, self-links, duplicates, unknown relations", () => {
    const problems = brainConfigProblems({
      ...ok,
      brain: { id: "Members", kind: "person" },
      links: [
        { id: "members", relation: "member-of" },
        { id: "acme", relation: "member-of" },
        { id: "acme", relation: "peer-of" },
        { id: "x", relation: "boss-of" as never },
      ],
    });
    expect(problems.join("\n")).toMatch(/brain.id "Members" must be a lowercase slug/);
    expect(problems.join("\n")).toMatch(/'members' is a reserved word/);
    expect(problems.join("\n")).toMatch(/duplicate link to 'acme'/);
    expect(problems.join("\n")).toMatch(/relation must be one of/);
    expect(brainConfigProblems({ ...ok, links: [{ id: "me", relation: "peer-of" }] }).join()).toMatch(/cannot link to itself/);
  });

  it("allows at most one containment parent and requires an identity before linking", () => {
    expect(
      brainConfigProblems({ ...ok, links: [{ id: "a", relation: "child-of" }, { id: "b", relation: "child-of" }] }).join(),
    ).toMatch(/at most one child-of/);
    expect(brainConfigProblems({ ...ok, brain: undefined }).join()).toMatch(/links require a brain identity/);
  });

  it("validates members: unique ids, known roles, at least one owner", () => {
    const problems = brainConfigProblems({
      ...ok,
      identity: {
        principal: { name: "P" },
        members: [
          { id: "pat", name: "Pat", role: "approver" },
          { id: "pat", name: "Pat 2", role: "god" as never },
        ],
      },
    });
    expect(problems.join("\n")).toMatch(/duplicate member id 'pat'/);
    expect(problems.join("\n")).toMatch(/role must be one of/);
    expect(problems.join("\n")).toMatch(/at least one owner/);
  });

  it("inverse relations pair up", () => {
    expect(INVERSE_RELATION["member-of"]).toBe("has-member");
    expect(INVERSE_RELATION["child-of"]).toBe("parent-of");
    expect(INVERSE_RELATION["peer-of"]).toBe("peer-of");
  });
});

describe("share markings", () => {
  it("deny by default; admit by id, by the exporter's audience word, or `linked`", () => {
    const member = { id: "me", relation: "has-member" as const };
    expect(shareAdmits([], member)).toBe(false);
    expect(shareAdmits(["someone-else"], member)).toBe(false);
    expect(shareAdmits(["me"], member)).toBe(true);
    expect(shareAdmits(["members"], member)).toBe(true);
    expect(shareAdmits(["peers"], member)).toBe(false);
    expect(shareAdmits(["linked"], member)).toBe(true);
    expect(shareAdmits(["children"], { id: "t", relation: "parent-of" })).toBe(true);
    expect(shareAdmits(["parent"], { id: "org", relation: "child-of" })).toBe(true);
    expect(shareAdmits(["groups"], { id: "org", relation: "member-of" })).toBe(true);
  });

  it("warns on markings that admit nobody, and on markings in a brain with no identity", async () => {
    const { acme } = await makePair({ orgFiles: { "facts/typo.md": concept("fact", { share: ["memebrs"] }, "# Typo\n") } });
    const store = new FsInstanceStore(acme);
    const issues = brainIssues(await store.loadBundle(), await store.loadConfig());
    expect(issues.some((i) => i.rule === "brains/share-unknown" && i.path === "facts/typo.md")).toBe(true);
    const noIdentity = brainIssues(await store.loadBundle(), { ...(await store.loadConfig()), brain: undefined, links: [] });
    expect(noIdentity.some((i) => i.rule === "brains/share-no-identity")).toBe(true);
  });
});

describe("the export view (exporter decides)", () => {
  it("exports only concepts whose marking admits the reader - never unmarked ones", async () => {
    const { acme } = await makePair();
    const result = await computeExport(new FsInstanceStore(acme), "me");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.view.concepts.map((c) => c.relPath);
    expect(paths).toEqual(["ops/calendar.md", "ops/nags.md"]);
    expect(paths).not.toContain("facts/bank.md");
    expect(paths).not.toContain("facts/partner-note.md"); // peers-only: the reader is a member
    expect(result.view.relation).toBe("has-member");
    expect(result.view.totalConcepts).toBeGreaterThan(paths.length);
  });

  it("refuses a reader the exporter does not link back to", async () => {
    const { acme } = await makePair({ orgLinks: [] });
    const result = await computeExport(new FsInstanceStore(acme), "me");
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/declares no link to 'me'/) });
  });

  it("includes the hub's newest brief only when the link grants it", async () => {
    const granted = await makePair();
    const g = await computeExport(new FsInstanceStore(granted.acme), "me");
    expect(g.ok && g.view.brief?.content).toContain("ORG-BRIEF-NEW");

    const notGranted = await makePair({ orgLinks: [{ id: "me", relation: "has-member", localPath: "../brain-me" }] });
    const n = await computeExport(new FsInstanceStore(notGranted.acme), "me");
    expect(n.ok && n.view.brief).toBeUndefined();
  });

  it("hands constitutions down only to a child", async () => {
    const asMember = await makePair();
    const m = await computeExport(new FsInstanceStore(asMember.acme), "me");
    expect(m.ok && m.view.constitutions).toBeUndefined();

    const asChild = await makePair({
      orgLinks: [{ id: "me", relation: "parent-of", localPath: "../brain-me" }],
      personLinks: [{ id: "acme", relation: "child-of", localPath: "../brain-acme" }],
    });
    const c = await computeExport(new FsInstanceStore(asChild.acme), "me");
    expect(c.ok && c.view.constitutions?.[0]).toMatchObject({ from: "acme", gatedActions: ["org-custom-gate"] });
  });
});

describe("mandatory markings win over shares", () => {
  it("a marked concept crosses only a link that clears every marking", async () => {
    const marked = {
      "finance/retirement.md": concept("fact", { share: ["me"], markings: ["finance"] }, "# Retirement\n\nMARKED-FINANCE\n"),
      "family/kids.md": concept("fact", { share: ["me"], markings: ["finance", "family"] }, "# Both\n\nDOUBLE-MARKED\n"),
    };
    const blocked = await makePair({ orgFiles: marked });
    const b = await computeExport(new FsInstanceStore(blocked.acme), "me");
    expect(b.ok && b.view.concepts.map((c) => c.relPath)).toEqual(["ops/calendar.md", "ops/nags.md"]);

    const cleared = await makePair({
      orgFiles: marked,
      orgLinks: [{ id: "me", relation: "has-member", localPath: "../brain-me", grants: { markings: ["finance"] } }],
    });
    const c = await computeExport(new FsInstanceStore(cleared.acme), "me");
    const paths = c.ok ? c.view.concepts.map((x) => x.relPath) : [];
    expect(paths).toContain("finance/retirement.md");
    expect(paths).not.toContain("family/kids.md"); // conjunctive: family is not cleared

    const store = new FsInstanceStore(blocked.acme);
    const issues = brainIssues(await store.loadBundle(), await store.loadConfig());
    expect(issues.some((i) => i.rule === "brains/marking-blocks-share" && i.path === "finance/retirement.md")).toBe(true);
  });

  it("a person brain may list its own principal as a member of itself", () => {
    const issues = brainIssues(
      { root: "", concepts: [] },
      {
        bundle: "bundle",
        ledger: "l",
        approvals: "a",
        reports: "r",
        drafts: "d",
        brain: { id: "me", kind: "person" },
        identity: { principal: { name: "Me" }, members: [{ id: "me-human", name: "Me", role: "owner", brain: "me" }] },
      },
    );
    expect(issues.map((i) => i.rule)).not.toContain("brains/member-unlinked");
  });

  it("warns when a person brain grants its brief across a link", () => {
    const issues = brainIssues(
      { root: "", concepts: [] },
      {
        bundle: "bundle",
        ledger: "l",
        approvals: "a",
        reports: "r",
        drafts: "d",
        brain: { id: "me", kind: "person" },
        links: [{ id: "acme", relation: "member-of", grants: { brief: true } }],
      },
    );
    expect(issues.map((i) => i.rule)).toContain("brains/person-brief-granted");
  });
});

describe("linked brains are read-only", () => {
  it("every write path on the facade throws", async () => {
    const { acme } = await makePair();
    const ro = readOnlyStore(new FsInstanceStore(acme));
    await expect(ro.writeReport("x.md", "x")).rejects.toThrow(/read-only/);
    await expect(ro.appendLedger({ ts: "t", runId: "r", agent: "a", action: "x", type: "report" })).rejects.toThrow(/read-only/);
    await expect(ro.writeFile("bundle/x.md", "x")).rejects.toThrow(/read-only/);
    await expect(ro.flush("m")).rejects.toThrow(/read-only/);
    expect((await ro.loadConfig()).brain?.id).toBe("acme");
  });
});

describe("the 'brains' source in a real run", () => {
  it("inlines what the linked brain shares - and nothing it keeps private", async () => {
    const { me } = await makePair();
    const prompt = await promptFor(me);
    expect(prompt).toContain("an AnimaMesh personal brain (`me` - A. Person)");
    expect(prompt).toContain("## Linked brains");
    expect(prompt).toContain("### `acme` - Acme Co (org) · this brain is member-of it (role: owner) · via local checkout ../brain-acme");
    expect(prompt).toContain("brain://acme/ops/nags.md");
    expect(prompt).toContain("SIGN-THE-RESOLUTION");
    expect(prompt).toContain("ORG-BRIEF-NEW");
    expect(prompt).not.toContain("ORG-BRIEF-OLD");
    expect(prompt).not.toContain("PRIVATE-ACCOUNT-DETAIL");
    expect(prompt).not.toContain("PEERS-ONLY");
  });

  it("reads nothing when the relationship is not mutual", async () => {
    const { me } = await makePair({ orgLinks: [] });
    const prompt = await promptFor(me);
    expect(prompt).toMatch(/### `acme` - NOT READ[\s\S]*declares no link to 'me'/);
    expect(prompt).not.toContain("SIGN-THE-RESOLUTION");
  });

  it("reads nothing when the two sides disagree on the relationship", async () => {
    const { me } = await makePair({ orgLinks: [{ id: "me", relation: "peer-of", localPath: "../brain-me" }] });
    const prompt = await promptFor(me);
    expect(prompt).toMatch(/relationship mismatch/);
    expect(prompt).not.toContain("SIGN-THE-RESOLUTION");
    expect(prompt).not.toContain("PEERS-ONLY");
  });

  it("refuses to read anything when this brain's own link map is invalid", async () => {
    const { me } = await makePair({ personLinks: [{ id: "acme", relation: "boss-of", localPath: "../brain-acme" }] });
    const prompt = await promptFor(me);
    expect(prompt).toMatch(/link config is invalid, so no linked brain was read/);
    expect(prompt).not.toContain("SIGN-THE-RESOLUTION");
  });

  it("over GitHub, a link reads only with its OWN token - never the brain's GITHUB_TOKEN", async () => {
    const fetchImpl = vi.fn(async () => new Response("should not be called", { status: 500 }));
    const section = await brainsSection({
      env: { GITHUB_TOKEN: "brain-wide-token" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      config: {
        bundle: "bundle",
        ledger: "l",
        approvals: "a",
        reports: "r",
        drafts: "d",
        brain: { id: "me", kind: "person" },
        links: [{ id: "acme", relation: "member-of", repo: "acme/brain" }],
      },
    });
    expect(section).toMatch(/BRAIN_LINK_ACME_TOKEN is not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(linkTokenEnv({ id: "my-org", relation: "member-of" })).toBe("BRAIN_LINK_MY_ORG_TOKEN");
    expect(linkTokenEnv({ id: "x", relation: "member-of", tokenEnv: "CUSTOM_TOKEN" })).toBe("CUSTOM_TOKEN");
  });
});

describe("read-requests across a link", () => {
  it("serves a shared concept; 'private' and 'missing' get the same refusal", async () => {
    const { me } = await makePair();
    const store = new FsInstanceStore(me);
    const ctx = { env: {}, config: await store.loadConfig(), openLocalBrain: localBrainOpener(me) };
    await expect(readBrainPath(ctx, "acme/ops/nags.md", { maxChars: 1000 })).resolves.toContain("SIGN-THE-RESOLUTION");
    const privateErr = await readBrainPath(ctx, "acme/facts/bank.md", { maxChars: 1000 }).catch((e: Error) => e.message);
    const missingErr = await readBrainPath(ctx, "acme/facts/nope.md", { maxChars: 1000 }).catch((e: Error) => e.message);
    expect(privateErr).toMatch(/is not shared with this brain by 'acme' \(or does not exist\)/);
    expect(missingErr.replace("nope", "bank")).toBe(privateErr);
    await expect(readBrainPath(ctx, "nobody/x.md", { maxChars: 10 })).rejects.toThrow(/no link to 'nobody'/);
  });

  it("a model-issued read-request for a private concept is refused out loud in the continuation", async () => {
    const { me } = await makePair();
    let call = 0;
    const provider = new FakeProvider(() => {
      call++;
      return call === 1
        ? { text: "need it\n\n```read-request\nbrains: [acme/facts/bank.md, acme/ops/calendar.md]\n```" }
        : { text: "final" };
    });
    await runAgent({ instanceRoot: me, agentName: "chief-of-staff", provider, runId: "run-rr" });
    const continuation = provider.calls[1]!.prompt;
    expect(continuation).toMatch(/brains: acme\/facts\/bank\.md[\s\S]*not shared with this brain/);
    expect(continuation).not.toContain("PRIVATE-ACCOUNT-DETAIL");
    expect(continuation).toContain("franchise tax");
  });
});

describe("containment inherits law", () => {
  it("a materialized ancestor constitution's gates are enforced in the child", async () => {
    const root = await makeTree({
      "index.md": concept("index", {}, "# I\n"),
      "log.md": concept("log", {}, "# L\n"),
      "constitution.md": concept("constitution", { immutable: true }, "# Own\n"),
      "inherited/acme/constitution.md": concept(
        "inherited-constitution",
        { from: "acme", synced: "2026-10-10", immutable: true, "gated-actions": ["org-custom-gate"] },
        "# Acme constitution\n",
      ),
    });
    roots.push(root);
    const gated = loadGatedTypes(await loadBundle(root));
    expect(gated).toContain("org-custom-gate");
    expect(gated).toContain("money-movement"); // the floor stays
    expect(() =>
      assertActionAllowed({
        agent: "a",
        level: "L4",
        category: "reversible",
        actionType: "org-custom-gate",
        gatedTypes: gated,
        approvals: { get: () => undefined },
        whitelist: ["org-custom-gate"],
      }),
    ).toThrow(GateViolation);
  });
});

describe("multi-player: who may decide", () => {
  const cfg = (members?: MemberConfig[]): InstanceConfig => ({
    bundle: "bundle",
    ledger: "l",
    approvals: "a",
    reports: "r",
    drafts: "d",
    identity: { principal: { name: "Ada Lovelace", email: "ada@example.test" }, ...(members ? { members } : {}) },
  });

  it("single-player brains: the principal alone, as owner; any CLI caller decides (historical)", () => {
    expect(effectiveMembers(cfg())).toEqual([{ id: "ada-lovelace", name: "Ada Lovelace", email: "ada@example.test", role: "owner" }]);
    expect(assertMayDecide(cfg(), "anyone")).toBeUndefined();
  });

  it("declared members: only owner/approver members decide; by id or email", () => {
    const c = cfg([
      { id: "ada", name: "Ada", email: "ada@example.test", role: "owner" },
      { id: "bo", name: "Bo", role: "approver" },
      { id: "cy", name: "Cy", role: "viewer" },
    ]);
    expect(assertMayDecide(c, "ADA@example.test")?.id).toBe("ada");
    expect(assertMayDecide(c, "bo")?.role).toBe("approver");
    expect(() => assertMayDecide(c, "cy")).toThrow(/viewer - only owner or approver/);
    expect(() => assertMayDecide(c, "mallory")).toThrow(/not a member of this brain/);
  });
});

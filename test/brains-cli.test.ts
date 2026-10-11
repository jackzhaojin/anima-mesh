import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import { main } from "../src/cli.js";
import { ApprovalStore } from "../src/gates/approvals.js";
import { loadBundle } from "../src/okf/bundle.js";
import { loadGatedTypes } from "../src/gates/gatekeeper.js";
import { checkConformance } from "../src/okf/conformance.js";

/**
 * The operator surfaces of the mesh of brains: `init --kind person`,
 * `brains` (who can see what), `brains sync` (inherited law), member-
 * checked `gate`, and config-aware `validate`.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { log: (s: string) => out.push(s), error: (s: string) => err.push(s) },
    out: () => out.join("\n"),
    err: () => err.join("\n"),
  };
}

const instance = (prefix: string, config: Record<string, unknown>, bundle: Record<string, string>) => ({
  [`${prefix}/animamesh.config.json`]: JSON.stringify({ bundle: "bundle", ...config }, null, 2),
  [`${prefix}/bundle/index.md`]: concept("index", {}, "# Index\n"),
  [`${prefix}/bundle/log.md`]: concept("log", {}, "# Log\n"),
  ...Object.fromEntries(Object.entries(bundle).map(([k, v]) => [`${prefix}/bundle/${k}`, v])),
});

describe("init --kind person", () => {
  it("scaffolds a conformant personal brain with an identity, the person roster, and no commercial gate", async () => {
    const parent = await makeTree({});
    roots.push(parent);
    const dir = path.join(parent, "brain-me");
    const c = capture();
    const code = await main(
      ["init", dir, "--name", "Ada Lovelace", "--principal", "Ada", "--principal-email", "ada@example.test", "--kind", "person", "--brain-id", "ada", "--harness", "fake", "--model", "m"],
      c.io,
    );
    expect(code, c.err()).toBe(0);
    const config = JSON.parse(await readFile(path.join(dir, "animamesh.config.json"), "utf8"));
    expect(config.brain).toEqual({ id: "ada", kind: "person", name: "Ada Lovelace" });
    expect(config.links).toEqual([]);
    expect(config.activation).toBeUndefined();
    expect(config.identity.principal.email).toBe("ada@example.test");
    const hub = await readFile(path.join(dir, "bundle/agents/chief-of-staff.md"), "utf8");
    expect(hub).toContain("Personal Chief of Staff");
    expect(hub).toContain("sources: [brains, gmail, google-calendar]");
    expect(existsSync(path.join(dir, "bundle/agents/compliance-ops.md"))).toBe(true);
    expect(existsSync(path.join(dir, "bundle/facts/person.md"))).toBe(true);
    expect(await readFile(path.join(dir, "bundle/ops/calendar.md"), "utf8")).toContain("Obligations calendar");
    expect(checkConformance(await loadBundle(path.join(dir, "bundle")), "animamesh").ok).toBe(true);
  });

  it("rejects an unknown kind and a reserved id", async () => {
    const parent = await makeTree({});
    roots.push(parent);
    const c = capture();
    expect(await main(["init", path.join(parent, "x"), "--name", "X", "--principal", "P", "--kind", "planet"], c.io)).toBe(2);
    const c2 = capture();
    expect(await main(["init", path.join(parent, "y"), "--name", "Y", "--principal", "P", "--kind", "org", "--brain-id", "members"], c2.io)).toBe(1);
    expect(c2.err()).toMatch(/reserved word/);
  });
});

describe("brains - who can see what", () => {
  async function pair() {
    const root = await makeTree({
      ...instance(
        "brain-me",
        {
          identity: { principal: { name: "Me" } },
          brain: { id: "me", kind: "person", name: "Me" },
          links: [{ id: "acme", relation: "member-of", role: "owner", localPath: "../brain-acme" }],
        },
        {
          "constitution.md": concept("constitution", { immutable: true }, "# C\n"),
          "commitments/talk.md": concept("commitment", { share: ["groups"] }, "# Talk\n\nSee brain://acme/ops/nags.md and brain://acme/facts/secret.md.\n"),
          "finance/bank.md": concept("fact", {}, "# Bank\n"),
        },
      ),
      ...instance(
        "brain-acme",
        { brain: { id: "acme", kind: "org", name: "Acme" }, links: [{ id: "me", relation: "has-member", localPath: "../brain-me", grants: { brief: true } }] },
        {
          "constitution.md": concept("constitution", { immutable: true }, "# C\n"),
          "ops/nags.md": concept("nags", { share: ["me"] }, "# Nags\n"),
          "facts/secret.md": concept("fact", {}, "# Secret\n"),
        },
      ),
    });
    roots.push(root);
    return root;
  }

  it("shows both directions, transports, mutuality, and unresolvable cross-brain refs", async () => {
    const root = await pair();
    const c = capture();
    expect(await main(["brains", "--instance", path.join(root, "brain-me")], c.io)).toBe(0);
    const out = c.out();
    expect(out).toContain("Brain me - Me (person)");
    expect(out).toContain("Members: me (owner) - single-player default");
    expect(out).toContain("transports: local ../brain-acme ✓");
    expect(out).toContain("mutual: ✓ acme declares itself has-member this brain");
    expect(out).toMatch(/acme → me: 1 of 5 concept\(s\) \+ latest brief|acme → me: 1 of 5 concept\(s\)\n\s+ops\/nags\.md/);
    expect(out).toMatch(/me → acme: 1 of 5 concept\(s\)\n\s+commitments\/talk\.md/);
    expect(out).not.toMatch(/finance\/bank\.md/);
    expect(out).toContain("Cross-brain references: 2 found, 1 unresolvable from here");
    expect(out).toMatch(/brains\/ref-not-shared @ commitments\/talk\.md - brain:\/\/acme\/facts\/secret\.md is not shared/);
  });

  it("flags a one-sided link as not mutual", async () => {
    const root = await pair();
    const acmeConfig = path.join(root, "brain-acme/animamesh.config.json");
    const cfg = JSON.parse(await readFile(acmeConfig, "utf8"));
    cfg.links = [];
    await writeFile(acmeConfig, JSON.stringify(cfg));
    const c = capture();
    await main(["brains", "--instance", path.join(root, "brain-me")], c.io);
    expect(c.out()).toMatch(/acme → me: not read - 'acme' declares no link to 'me'/);
    expect(c.out()).toContain("brains/not-mutual");
  });
});

describe("brains sync - containment inherits law", () => {
  it("materializes the parent's constitution; the gatekeeper then enforces its gates", async () => {
    const root = await makeTree({
      ...instance(
        "brain-team",
        { brain: { id: "team", kind: "team" }, links: [{ id: "org", relation: "child-of", localPath: "../brain-org" }] },
        { "constitution.md": concept("constitution", { immutable: true }, "# Team\n") },
      ),
      ...instance(
        "brain-org",
        { brain: { id: "org", kind: "org" }, links: [{ id: "team", relation: "parent-of", localPath: "../brain-team" }] },
        { "constitution.md": concept("constitution", { immutable: true, "gated-actions": ["client-contact"] }, "# Org law\n\nNo client contact without approval.\n") },
      ),
    });
    roots.push(root);
    const team = path.join(root, "brain-team");
    const before = capture();
    await main(["brains", "--instance", team], before.io);
    expect(before.out()).toContain("NOT materialized - run `anima-mesh brains sync`");

    const c = capture();
    expect(await main(["brains", "sync", "--instance", team], c.io)).toBe(0);
    expect(c.out()).toContain("wrote bundle/inherited/org/constitution.md");
    const bundle = await loadBundle(path.join(team, "bundle"));
    expect(loadGatedTypes(bundle)).toContain("client-contact");
    expect(checkConformance(bundle, "animamesh").ok).toBe(true);
    expect(await readFile(path.join(team, "bundle/log.md"), "utf8")).toMatch(/Inherited constitution\(s\) synced from `org`/);

    const again = capture();
    await main(["brains", "sync", "--instance", team], again.io);
    expect(again.out()).toContain("current bundle/inherited/org/constitution.md");

    // The parent amends its law → the child's copy is stale until re-synced.
    await writeFile(
      path.join(root, "brain-org/bundle/constitution.md"),
      concept("constitution", { immutable: true, "gated-actions": ["client-contact", "hiring"] }, "# Org law v2\n"),
    );
    const stale = capture();
    await main(["brains", "--instance", team], stale.io);
    expect(stale.out()).toContain("STALE - run `anima-mesh brains sync`");
  });
});

describe("multi-player gate decisions", () => {
  it("with members declared, only owner/approver members may decide", async () => {
    const root = await makeTree(
      instance(
        "brain-org",
        {
          identity: {
            principal: { name: "Ada" },
            members: [
              { id: "ada", name: "Ada", email: "ada@example.test", role: "owner" },
              { id: "vic", name: "Vic", role: "viewer" },
            ],
          },
        },
        { "constitution.md": concept("constitution", { immutable: true }, "# C\n") },
      ),
    );
    roots.push(root);
    const dir = path.join(root, "brain-org");
    const store = new ApprovalStore(path.join(dir, "approvals"));
    const r1 = store.request({ actionType: "money-movement", summary: "pay", requestedBy: "agent" });
    const r2 = store.request({ actionType: "money-movement", summary: "pay again", requestedBy: "agent" });

    const denied = capture();
    expect(await main(["gate", "approve", r1.id, "--instance", dir, "--by", "vic"], denied.io)).toBe(1);
    expect(denied.err()).toMatch(/viewer - only owner or approver/);
    expect(store.get(r1.id)?.status).toBe("pending");

    const stranger = capture();
    expect(await main(["gate", "approve", r1.id, "--instance", dir, "--by", "mallory"], stranger.io)).toBe(1);
    expect(store.get(r1.id)?.status).toBe("pending");

    const ok = capture();
    expect(await main(["gate", "approve", r1.id, "--instance", dir, "--by", "ADA@example.test"], ok.io)).toBe(0);
    expect(store.get(r1.id)).toMatchObject({ status: "approved", decidedBy: "ada" });
    expect(await main(["gate", "deny", r2.id, "--instance", dir, "--by", "ada"], capture().io)).toBe(0);
  });
});

describe("validate is config-aware", () => {
  it("errors on a malformed link map, warns on markings that admit nobody", async () => {
    const root = await makeTree(
      instance(
        "brain-x",
        { brain: { id: "x", kind: "org" }, links: [{ id: "y", relation: "sibling-of" }] },
        {
          "constitution.md": concept("constitution", { immutable: true }, "# C\n"),
          "facts/a.md": concept("fact", { share: ["nobody-i-know"] }, "# A\n"),
        },
      ),
    );
    roots.push(root);
    const c = capture();
    expect(await main(["validate", path.join(root, "brain-x")], c.io)).toBe(1);
    // formatReport's own separator sits between rule and message; match any.
    expect(c.out()).toMatch(/\[error\] brains\/config . links\[0\]\.relation must be one of/);
    expect(c.out()).toMatch(/\[warning\] brains\/share-unknown @ facts\/a\.md/);
  });
});

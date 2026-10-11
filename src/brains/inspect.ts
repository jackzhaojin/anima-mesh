import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { FsInstanceStore } from "../instance/store-fs.js";
import { parseConcept, serializeConcept } from "../okf/frontmatter.js";
import { conceptsByType } from "../okf/bundle-core.js";
import { addLogEntry } from "../okf/log.js";
import { localBrainOpener } from "./local.js";
import { readLinkedBrain, openLinkedBrain, linkTokenEnv, type LinkedRead } from "../sources/brains.js";
import {
  brainIssues,
  computeExport,
  effectiveMembers,
  parentLink,
  INHERITED_CONSTITUTION_TYPE,
  INVERSE_RELATION,
  type BrainIssue,
  type ExportResult,
} from "./core.js";
import type { SourceContext } from "../sources/types.js";

/**
 * The operator's view of the mesh of brains (Node-only, CLI):
 *  - `inspectBrains` - who this brain is, who acts in it, every link's
 *    transport and mutuality, and - the point - WHO CAN SEE WHAT, in both
 *    directions, computed by the same code the harness enforces with.
 *  - `syncInherited` - materialize every ancestor constitution into
 *    bundle/inherited/<id>/constitution.md, where the gatekeeper reads it.
 *    Law is materialized (offline, versioned, auditable in git); context
 *    (briefs, shared concepts) is read live.
 */

const BRAIN_REF_RE = /brain:\/\/([a-z0-9][a-z0-9-]*)\/([^\s)`'"<>]+)/g;

export interface BrainsInspection {
  text: string;
  issues: BrainIssue[];
  /** No error-level issues. */
  ok: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function exportLine(label: string, result: ExportResult | undefined, extra = ""): string[] {
  if (!result) return [`    ${label}: (not computed)`];
  if (!result.ok) return [`    ${label}: nothing - ${result.reason}`];
  const v = result.view;
  const lines = [
    `    ${label}: ${v.concepts.length + v.omitted} of ${v.totalConcepts} concept(s)` +
      (v.brief ? ` + latest brief (${v.brief.name})` : "") +
      (v.constitutions?.length ? ` + ${v.constitutions.length} constitution(s)` : "") +
      extra,
  ];
  for (const c of v.concepts) lines.push(`        ${c.relPath}`);
  if (v.omitted > 0) lines.push(`        … ${v.omitted} more over the export cap`);
  return lines;
}

export async function inspectBrains(instanceRoot: string, env: Record<string, string | undefined> = {}): Promise<BrainsInspection> {
  const store = new FsInstanceStore(instanceRoot);
  const config = await store.loadConfig();
  const bundle = await store.loadBundle();
  const issues = brainIssues(bundle, config);
  const out: string[] = [];

  if (!config.brain) {
    out.push("This instance declares no brain identity (animamesh.config.json → brain: { id, kind, name }).");
    out.push("It can neither link to nor be read by other brains - single-brain operation, exactly as before v2.0.0.");
  } else {
    out.push(`Brain ${config.brain.id}${config.brain.name ? ` - ${config.brain.name}` : ""} (${config.brain.kind})`);
  }

  const members = effectiveMembers(config);
  const declared = Array.isArray(config.identity?.members) && config.identity!.members!.length > 0;
  out.push(
    `Members: ${members.map((m) => `${m.id} (${m.role})`).join(", ") || "(none)"}` +
      (declared ? "" : " - single-player default: the principal, as owner"),
  );

  const links = config.links ?? [];
  const ctx: SourceContext = { env, config, openLocalBrain: localBrainOpener(store.root) };
  out.push("", `Links (${links.length}):`);
  for (const link of links) {
    out.push(`- ${link.id}: this brain is ${link.relation} it${link.role ? ` (role: ${link.role})` : ""}`);
    const transports: string[] = [];
    if (link.localPath) {
      transports.push(`local ${link.localPath} ${ctx.openLocalBrain?.(link) ? "✓" : "✗ (no brain there)"}`);
    }
    if (link.repo) {
      const tokenName = linkTokenEnv(link);
      transports.push(`github ${link.repo}@${link.ref ?? "main"} ${env[tokenName] ? "✓ token set" : `- ${tokenName} not set here`}`);
    }
    out.push(`    transports: ${transports.join(" | ") || "none declared"}`);
    if (link.grants?.brief) out.push("    grants: this brain's latest brief");

    let inbound: LinkedRead | undefined;
    let outbound: ExportResult | undefined;
    if (config.brain) {
      inbound = await readLinkedBrain(link, config.brain, ctx);
      outbound = await computeExport(store, link.id);
    }
    if (inbound?.view) {
      out.push(`    mutual: ✓ ${link.id} declares itself ${inbound.view.relation} this brain`);
      out.push(...exportLine(`${link.id} → ${config.brain!.id}`, { ok: true, view: inbound.view }));
    } else if (inbound) {
      out.push(`    ${link.id} → ${config.brain!.id}: not read - ${inbound.problem}`);
      if (/mismatch|declares no link/.test(inbound.problem ?? "")) {
        issues.push({ level: "warning", rule: "brains/not-mutual", message: `${link.id}: ${inbound.problem}` });
      }
    }
    if (config.brain) {
      // What leaves THIS brain is computed from this brain's config + markings
      // only, so it is knowable even when the other side is unreachable.
      out.push(
        ...exportLine(
          `${config.brain.id} → ${link.id}`,
          outbound,
          inbound?.view || !links.length ? "" : ` (if ${link.id} reciprocates as ${INVERSE_RELATION[link.relation]})`,
        ),
      );
    }

    if (link.relation === "child-of" && inbound?.view?.constitutions) {
      for (const c of inbound.view.constitutions) {
        const rel = `inherited/${c.from}/constitution.md`;
        const local = bundle.concepts.find((x) => x.relPath === rel);
        const fresh = local?.frontmatter["source-sha256"] === sha256(c.content);
        out.push(`    inherited constitution from ${c.from}: ${local ? (fresh ? "materialized, current ✓" : "STALE - run `anima-mesh brains sync`") : "NOT materialized - run `anima-mesh brains sync`"}`);
        if (!local || !fresh) {
          issues.push({
            level: "warning",
            rule: "brains/inherited-stale",
            path: rel,
            message: `the gates are not enforcing ${c.from}'s current constitution - run anima-mesh brains sync`,
          });
        }
      }
    }
  }

  // Cross-brain references: brain://<id>/<path> in this bundle's bodies.
  const refs: Array<{ from: string; id: string; target: string }> = [];
  for (const c of bundle.concepts) {
    for (const m of c.body.matchAll(BRAIN_REF_RE)) refs.push({ from: c.relPath, id: m[1]!, target: m[2]!.replace(/[.,;:]+$/, "") });
  }
  if (refs.length > 0) {
    const cache = new Map<string, LinkedRead>();
    let broken = 0;
    for (const ref of refs) {
      const link = links.find((l) => l.id === ref.id);
      if (!link || !config.brain) {
        broken++;
        issues.push({ level: "warning", rule: "brains/ref-unlinked", path: ref.from, message: `brain://${ref.id}/${ref.target} names a brain this one does not link to` });
        continue;
      }
      if (!cache.has(ref.id)) cache.set(ref.id, await readLinkedBrain(link, config.brain, ctx, { maxConcepts: Number.MAX_SAFE_INTEGER }));
      const read = cache.get(ref.id)!;
      if (!read.view) continue; // unreachable here: can't judge, not broken
      if (!read.view.concepts.some((c) => c.relPath === ref.target)) {
        broken++;
        issues.push({
          level: "warning",
          rule: "brains/ref-not-shared",
          path: ref.from,
          message: `brain://${ref.id}/${ref.target} is not shared with this brain (or does not exist) - agents here cannot follow it`,
        });
      }
    }
    out.push("", `Cross-brain references: ${refs.length} found, ${broken} unresolvable from here`);
  }

  if (issues.length > 0) {
    out.push("", `Issues (${issues.length}):`);
    for (const i of issues) out.push(`  [${i.level}] ${i.rule}${i.path ? ` @ ${i.path}` : ""} - ${i.message}`);
  }
  return { text: out.join("\n"), issues, ok: !issues.some((i) => i.level === "error") };
}

export interface SyncResult {
  written: string[];
  unchanged: string[];
  note?: string;
}

/**
 * Materialize ancestor constitutions for a child brain. Writes
 * bundle/inherited/<from>/constitution.md (type inherited-constitution,
 * immutable, with the source hash for staleness checks) and appends one
 * log line. A brain with no child-of link has nothing to inherit.
 */
export async function syncInherited(
  instanceRoot: string,
  env: Record<string, string | undefined> = {},
  now: Date = new Date(),
): Promise<SyncResult> {
  const store = new FsInstanceStore(instanceRoot);
  const config = await store.loadConfig();
  const link = parentLink(config);
  if (!link || !config.brain) return { written: [], unchanged: [], note: "no child-of link - this brain inherits no constitution" };
  const opened = openLinkedBrain(link, { env, config, openLocalBrain: localBrainOpener(store.root) });
  if ("gap" in opened) throw new Error(`brains sync: parent '${link.id}' is not reachable - ${opened.gap}`);
  const read = await readLinkedBrain(link, config.brain, { env, config, openLocalBrain: localBrainOpener(store.root) });
  if (!read.view) throw new Error(`brains sync: ${read.problem}`);
  const constitutions = read.view.constitutions ?? [];
  if (constitutions.length === 0) throw new Error(`brains sync: '${link.id}' handed down no constitution`);

  const date = now.toISOString().slice(0, 10);
  const result: SyncResult = { written: [], unchanged: [] };
  const bundleDir = store.bundleDir;
  for (const c of constitutions) {
    const rel = `inherited/${c.from}/constitution.md`;
    const abs = path.join(bundleDir, rel);
    const hash = sha256(c.content);
    if (existsSync(abs)) {
      const current = parseConcept(readFileSync(abs, "utf8"));
      if (current?.frontmatter["source-sha256"] === hash) {
        result.unchanged.push(rel);
        continue;
      }
    }
    const parsed = parseConcept(c.content);
    const body = (parsed?.body ?? c.content).trim();
    const content = serializeConcept({
      frontmatter: {
        type: INHERITED_CONSTITUTION_TYPE,
        title: `Inherited constitution - ${c.from}`,
        from: c.from,
        synced: date,
        immutable: true,
        "gated-actions": c.gatedActions,
        "source-sha256": hash,
        // OKF v0.2 provenance: a process wrote this, from the parent's constitution.
        generated: { by: "process:anima-mesh-brains-sync", at: now.toISOString() },
        sources: [{ id: c.from, resource: `brain://${c.from}/constitution.md`, title: `Constitution of brain ${c.from}` }],
      },
      body:
        `> Materialized by \`anima-mesh brains sync\` from brain \`${c.from}\` on ${date}. ` +
        `BINDING on this brain: the gatekeeper unions these gates with this brain's own. ` +
        `Never edit by hand - change the source brain's constitution and re-sync.\n\n${body}\n`,
    });
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    result.written.push(rel);
  }
  if (result.written.length > 0) {
    const logFile = path.join(bundleDir, "log.md");
    if (existsSync(logFile)) {
      writeFileSync(
        logFile,
        addLogEntry(
          readFileSync(logFile, "utf8"),
          date,
          `- **Update**: Inherited constitution(s) synced from \`${link.id}\` by \`anima-mesh brains sync\`: ${result.written.join(", ")}.`,
        ),
        "utf8",
      );
    }
  }
  // Sanity: the gatekeeper will see what was just written.
  const after = await new FsInstanceStore(instanceRoot).loadBundle();
  if (conceptsByType(after, INHERITED_CONSTITUTION_TYPE).length < constitutions.length) {
    throw new Error("brains sync: materialized constitutions are not visible in the bundle - engine bug");
  }
  return result;
}

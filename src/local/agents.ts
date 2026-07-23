import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadInstance } from "../instance/config.js";
import { loadBundle } from "../okf/bundle.js";
import { agentsFromBundle } from "../agents/concept.js";
import {
  composeLocalAgents,
  selectLocalAgents,
  type LocalAgentArtifact,
} from "./agents-core.js";

/** Disk half of the local-agent export — Node only (the CLI path). */

export interface ExportLocalResult {
  /** Instance-relative paths written. */
  written: string[];
  skipped: { name: string; reason: string }[];
}

export async function exportLocalAgents(
  instanceRoot: string,
  opts: { names?: string[]; all?: boolean } = {},
): Promise<ExportLocalResult> {
  const instance = loadInstance(instanceRoot);
  const bundle = await loadBundle(instance.bundleDir);
  const selection = selectLocalAgents(agentsFromBundle(bundle), instance.config, opts);

  const artifacts: LocalAgentArtifact[] = selection.agents.flatMap((a) =>
    composeLocalAgents(a, instance.config),
  );
  const written: string[] = [];
  for (const artifact of artifacts) {
    const abs = path.join(instance.root, artifact.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, artifact.content, "utf8");
    written.push(artifact.relPath);
  }
  return { written, skipped: selection.skipped };
}

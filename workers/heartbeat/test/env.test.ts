import { describe, it, expect } from "vitest";
import { envRecord, type Env } from "../src/env.js";

/**
 * The Worker hands the engine an explicit env record - nothing passes
 * through by accident. v0.18.0 adds the principal's read-only Google
 * account and one READ-ONLY token per linked brain, the latter by name
 * pattern (a brain may have any number of links).
 */
describe("envRecord", () => {
  const base = {
    BRAIN_REPO: "owner/brain",
    BRAIN_REF: "main",
    BEAT_TIMEZONE: "America/New_York",
    BEAT_HOUR: "8",
    MOONSHOT_API_KEY: "",
    BEAT_TRIGGER_TOKEN: "t",
  } as unknown as Env;

  it("passes the Google read source vars and every BRAIN_LINK_<ID>_TOKEN, nothing else unlisted", () => {
    const record = envRecord({
      ...base,
      GOOGLE_READ_CLIENT_ID: "cid",
      GOOGLE_READ_CLIENT_SECRET: "cs",
      GOOGLE_READ_REFRESH_TOKEN: "rt",
      GCAL_READ_DAYS_AHEAD: "21",
      BRAIN_LINK_ACME_TOKEN: "link-acme",
      BRAIN_LINK_MY_TEAM_TOKEN: "link-team",
      SOMETHING_ELSE_SECRET: "must-not-pass",
    } as unknown as Env);
    expect(record).toMatchObject({
      GOOGLE_READ_CLIENT_ID: "cid",
      GOOGLE_READ_CLIENT_SECRET: "cs",
      GOOGLE_READ_REFRESH_TOKEN: "rt",
      GCAL_READ_DAYS_AHEAD: "21",
      BRAIN_LINK_ACME_TOKEN: "link-acme",
      BRAIN_LINK_MY_TEAM_TOKEN: "link-team",
    });
    expect(Object.values(record)).not.toContain("must-not-pass");
  });
  it("passes Slack delivery vars; the signing secret stays at the edge", () => {
    const record = envRecord({
      ...base,
      SLACK_BOT_TOKEN: "xoxb",
      SLACK_CHANNEL_ID: "C1",
      SLACK_WEBHOOK_URL: "https://hooks.example/x",
      SLACK_SIGNING_SECRET: "edge-only",
    } as unknown as Env);
    expect(record).toMatchObject({ SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL_ID: "C1", SLACK_WEBHOOK_URL: "https://hooks.example/x" });
    expect(Object.values(record)).not.toContain("edge-only");
  });
});

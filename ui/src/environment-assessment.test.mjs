import test from "node:test";
import assert from "node:assert/strict";
import { assessEnvironment, assessmentLifetime } from "./environment-assessment.mjs";

const now = Date.UTC(2026, 10, 17, 12);
const stamp = (ago = 0) => new Date(now - ago).toISOString();
const criticalIDs = ["egress_policy", "proxy_transport", "dns_transport", "guest_settings", "browser_settings", "filesystem_boundary", "management_boundary", "fail_closed", "udp_policy", "ipv6_policy", "exit_consistency"];
function sample() {
  const settings = { timezone: "America/Los_Angeles", locale: "en_US.UTF-8", browser_language: "en-US", auto_timezone: true, auto_language: false };
  const report = { id: "fixture-report", check_id: "fixture-check", run_id: "fixture-run", configuration: "fixture-configuration", policy: "cage-safety/3", created_at: stamp(1000), checks: criticalIDs.map(id => ({ id, state: "passed", critical: true, evidence: "isolated fixture", checked_at: stamp() })) };
  const location = { ip: "192.0.2.10", country_code: "US", timezone: settings.timezone, suggested_locale: settings.locale, suggested_browser_language: settings.browser_language,
    evidence: { country_status: "consistent", timezone_status: "consistent", status: "consistent", checked_at: stamp(), sources: ["source-a", "source-b"].map(provider => ({ provider, country_code: "US", timezone: settings.timezone })) } };
  const status = { vm_running: true, safety: { exit_ip: location.ip, report, gate: { run_id: report.run_id, configuration: report.configuration, policy: report.policy, mode: "open", policy_verified: true, until: stamp(-60_000), report: { id: report.id } } }, location };
  const browserReport = { run_id: report.run_id, configuration: report.configuration, target: "browser", expected_timezone: settings.timezone, expected_language: settings.browser_language, browser_timezone: settings.timezone, browser_language: settings.browser_language, checked_at: stamp(), checks: ["browser-version", "user-agent"].map(id => ({ id, state: "passed", evidence: "measured native version" })) };
  return { status, settings, location, browserReport, now };
}
const category = (result, id) => result.categories.find(group => group.id === id);

test("complete current evidence earns 100 with an explicit fixed breakdown", () => {
  const result = assessEnvironment(sample());
  assert.equal(result.score, 100);
  assert.equal(result.coverage, 100);
  assert.equal(result.label, "已核验项目一致");
  assert.deepEqual(result.categories.map(group => group.weight), [50, 25, 15, 10]);
  assert.deepEqual(result.patch, {});
});

test("missing observations stay unknown rather than becoming a perfect score on available checks", () => {
  const input = sample(); delete input.browserReport;
  const result = assessEnvironment(input);
  assert.equal(result.score, 85);
  assert.equal(result.coverage, 85);
  assert.equal(result.unknown, 15);
  assert.equal(result.failedPoints, 0);
  assert.equal(result.label, "部分证据待确认");
  assert.equal(assessEnvironment({ now }).score, null);
});

test("software rendering itself is not penalized while separate device failures remain prominent", () => {
  const input = sample(); input.browserReport.renderer_class = "software";
  assert.equal(assessEnvironment(input).score, 100);
  input.browserReport.checks.push({ id: "webgl-render", state: "failed", evidence: "readback mismatch" });
  const result = assessEnvironment(input);
  assert.equal(result.score, 100);
  assert.equal(result.label, "存在设备配置异常");
  assert.equal(result.deviceFailures, 1);
});

test("a high numerical score cannot hide a failed mandatory check", () => {
  const input = sample();
  input.status.safety.report.checks.find(check => check.id === "guest_settings").state = "failed";
  const result = assessEnvironment(input);
  assert.equal(result.score, 87.5);
  assert.equal(result.label, "关键检查未通过");
  assert.equal(result.criticalFailed, true);
});

test("paused or expired networking does not reuse old successful samples as live evidence", () => {
  for (const change of [gate => { gate.mode = "closed"; }, gate => { gate.until = stamp(1); }, gate => { gate.policy_verified = false; }, gate => { gate.report.id = "different-grant"; }]) {
    const input = sample(); change(input.status.safety.gate);
    const result = assessEnvironment(input);
    assert.equal(category(result, "network").earned, 0);
    assert.equal(category(result, "network").covered, 0);
    assert.equal(result.label, "关键证据待确认");
  }
});

test("changed environment, config, stopped state and active jobs invalidate old evidence", () => {
  for (const change of [input => { input.status.safety.gate.run_id = "new-run"; }, input => { input.status.safety.gate.configuration = "new-configuration"; }]) {
    const input = sample(); change(input);
    const result = assessEnvironment(input);
    assert.equal(category(result, "network").covered, 0);
    assert.equal(category(result, "identity").covered, 0);
  }
  for (const change of [input => { input.status.vm_running = false; }, input => { input.status.job = { running: true }; }]) {
    const input = sample(); change(input);
    const result = assessEnvironment(input);
    assert.equal(result.coverage, 0);
    assert.equal(result.score, null);
  }
});

test("duplicate, noncritical and unsupported-policy reports cannot earn critical points", () => {
  for (const change of [input => { input.status.safety.report.checks.push({ ...input.status.safety.report.checks[0] }); }, input => { input.status.safety.report.checks[0].critical = false; }]) {
    const input = sample(); change(input);
    assert.equal(category(assessEnvironment(input), "network").rows[0].state, "unknown");
  }
  const input = sample(); input.status.safety.report.policy = "future-policy";
  assert.equal(category(assessEnvironment(input), "network").covered, 0);
});

test("fresh device timezone and language readback overrides an older successful safety sample", () => {
  const input = sample(); input.browserReport.browser_timezone = "America/New_York";
  let result = assessEnvironment(input);
  assert.equal(category(result, "settings").rows[1].state, "failed");
  assert.equal(result.criticalFailed, true);
  input.browserReport.browser_timezone = "";
  result = assessEnvironment(input);
  assert.equal(category(result, "settings").rows[1].state, "unknown");
});

test("a partial device probe never clears a mandatory failure or replaces missing full checks", () => {
  const input = sample();
  input.status.safety.report.checks.find(check => check.id === "browser_settings").state = "failed";
  let result = assessEnvironment(input);
  assert.equal(category(result, "settings").rows[1].state, "failed");
  input.status.safety.report.checks = input.status.safety.report.checks.filter(check => check.id !== "browser_settings");
  result = assessEnvironment(input);
  assert.equal(category(result, "settings").rows[1].state, "unknown");
  input.status.guest_system = "debian-13";
  input.browserReport.browser_platform = "Win32";
  result = assessEnvironment(input);
  assert.equal(category(result, "settings").rows[1].state, "failed");
});

test("unknown browser metadata, old components and desktop reports never earn browser identity points", () => {
  const input = sample();
  for (const change of [report => { report.target = "desktop"; }, report => { delete report.run_id; }, report => { report.expected_language = "ja-JP"; }, report => { report.checked_at = stamp(assessmentLifetime.browser); }, report => { report.checked_at = stamp(-120_000); }]) {
    const next = structuredClone(input); change(next.browserReport);
    assert.equal(category(assessEnvironment(next), "identity").covered, 0);
  }
  input.browserReport.checks[0].state = "unknown";
  const result = assessEnvironment(input);
  assert.equal(category(result, "identity").earned, 7.5);
  assert.equal(result.unknown, 7.5);
});

test("stale, mismatched-IP or insufficient location evidence cannot recommend a new setting", () => {
  for (const change of [location => { location.evidence.checked_at = stamp(assessmentLifetime.location); }, location => { location.ip = "192.0.2.11"; }, location => { location.evidence.sources = [location.evidence.sources[0]]; }, location => { location.evidence.sources[1].provider = "source-a"; }]) {
    const input = sample(); input.settings.timezone = "America/New_York"; change(input.location);
    const result = assessEnvironment(input);
    assert.deepEqual(result.patch, {});
    assert.equal(category(result, "location").earned, 0);
  }
});

test("conflicts preserve settings even with a majority, and country restrictions cannot be overridden by recommendations", () => {
  for (const kind of ["timezone", "country", "mainland"]) {
    const input = sample();
    input.settings.timezone = "America/New_York"; input.settings.auto_language = true;
    input.location.evidence.sources.push({ provider: "source-c", country_code: kind === "mainland" ? "CN" : kind === "country" ? "CA" : "US", timezone: "America/New_York" });
    input.location.evidence.timezone_status = "conflict";
    if (kind !== "timezone") input.location.evidence.country_status = "conflict";
    const result = assessEnvironment(input);
    assert.deepEqual(result.patch, {});
    assert.equal(result.recommendations[0].value, input.settings.timezone);
  }
});

test("a city-only conflict permits supported timezone recommendations without saving anything", () => {
  const input = sample(); input.settings.timezone = "America/New_York";
  input.location.evidence.status = "conflict";
  input.location.evidence.sources[0].city = "sample-city";
  input.location.evidence.sources[1].city = "other-city";
  const before = structuredClone(input);
  const result = assessEnvironment(input);
  assert.deepEqual(result.patch, { timezone: "America/Los_Angeles", auto_timezone: false });
  assert.equal(category(result, "location").earned, 5);
  assert.deepEqual(input, before);
});

test("manual language preference is preserved, with paired suggestions only for confirmed automatic language", () => {
  const input = sample();
  input.settings.locale = "ja_JP.UTF-8"; input.settings.browser_language = "ja-JP";
  let result = assessEnvironment(input);
  assert.equal(result.recommendations[1].value, "ja_JP.UTF-8 / ja-JP");
  assert.deepEqual(result.patch, {});
  input.settings.auto_language = true;
  result = assessEnvironment(input);
  assert.deepEqual(result.patch, { locale: "en_US.UTF-8", browser_language: "en-US", auto_language: false });
  input.location.suggested_locale = "invalid-locale";
  assert.deepEqual(assessEnvironment(input).patch, {});
});

test("invalid timestamps and stale safety evidence stay unknown", () => {
  const input = sample(); input.status.safety.report.created_at = stamp(assessmentLifetime.safety);
  let result = assessEnvironment(input);
  assert.equal(category(result, "network").covered, 0);
  input.location.evidence.checked_at = "invalid date";
  result = assessEnvironment(input);
  assert.equal(category(result, "location").covered, 0);
});

test("UTC aliases agree without collapsing regions with different daylight-saving rules", () => {
  const input = sample();
  input.settings.timezone = "UTC"; input.location.timezone = "Etc/UTC";
  for (const source of input.location.evidence.sources) source.timezone = "Etc/GMT";
  assert.equal(category(assessEnvironment(input), "location").earned, 10);
  input.settings.timezone = "America/Denver";
  input.location.timezone = "America/Phoenix";
  for (const source of input.location.evidence.sources) source.timezone = "America/Phoenix";
  assert.equal(category(assessEnvironment(input), "location").earned, 5, "the same winter UTC offset must not merge different daylight-saving rules");
});

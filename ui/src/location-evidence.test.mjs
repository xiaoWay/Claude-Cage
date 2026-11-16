import test from "node:test";
import assert from "node:assert/strict";
import { canApplyLocationTimezone, locationEvidenceLabel, locationTimezoneState, sameLocationTimezone } from "./location-evidence.mjs";

test("automatic timezone requires country and timezone source agreement", () => {
  const location = { country_code: "US", timezone: "America/New_York", evidence: { country_status: "consistent", timezone_status: "consistent", status: "conflict" } };
  assert.equal(canApplyLocationTimezone(location), true, "city disagreement must not invalidate matching timezones");
  for (const field of ["country_status", "timezone_status"]) for (const status of ["conflict", "insufficient"]) {
    assert.equal(canApplyLocationTimezone({ ...location, evidence: { ...location.evidence, [field]: status } }), false);
  }
  assert.equal(canApplyLocationTimezone({ ...location, evidence: undefined }), false);
  assert.equal(canApplyLocationTimezone({ ...location, country_code: "CN" }), false);
});

test("location labels separate disagreement from unavailable evidence", () => {
  assert.equal(locationEvidenceLabel({ status: "conflict" }), "定位结果不一致");
  assert.equal(locationEvidenceLabel({ status: "insufficient" }), "定位证据不足");
  assert.equal(locationEvidenceLabel({ status: "consistent" }), "定位来源一致");
  assert.equal(locationEvidenceLabel(undefined), "尚无多来源定位结果");
});


test("unknown evidence cannot display agreement and UTC aliases compare equally", () => {
  assert.equal(locationEvidenceLabel({ status: "unknown" }), "定位证据不足");
  assert.equal(sameLocationTimezone("Etc/UTC", "UTC"), true);
  assert.equal(sameLocationTimezone("America/New_York", "America/Los_Angeles"), false);
});

test("saved timezone comparison separates mismatch, city disagreement and uncertain IP estimates", () => {
  const location = { country_code: "US", timezone: "America/New_York", evidence: { country_status: "consistent", timezone_status: "consistent", status: "conflict" } };
  assert.equal(locationTimezoneState(location, "America/New_York"), "passed");
  assert.equal(locationTimezoneState(location, "America/Los_Angeles"), "failed");
  assert.equal(locationTimezoneState(location, ""), "unknown");
  assert.equal(locationTimezoneState({ ...location, timezone: "UTC" }, "Etc/UTC"), "passed");
  assert.equal(locationTimezoneState({ ...location, timezone: "Europe/Berlin" }, "Africa/Lagos"), "failed", "equal winter offsets do not mean equal DST rules");
  for (const field of ["country_status", "timezone_status"]) for (const state of ["conflict", "insufficient"]) {
    assert.equal(locationTimezoneState({ ...location, evidence: { ...location.evidence, [field]: state } }, location.timezone), "unknown");
  }
  assert.equal(locationTimezoneState(undefined, "America/New_York"), "unknown");
});

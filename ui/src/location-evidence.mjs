export function canApplyLocationTimezone(location) {
  return Boolean(location?.timezone && location.country_code && location.country_code !== "CN" && location.evidence?.timezone_status === "consistent" && location.evidence?.country_status === "consistent");
}

export function locationEvidenceLabel(evidence) {
  if (!evidence) return "尚无多来源定位结果";
  if (evidence.status === "conflict") return "定位结果不一致";
  if (evidence.status === "insufficient") return "定位证据不足";
  return evidence.status === "consistent" ? "定位来源一致" : "定位证据不足";
}

export function sameLocationTimezone(a, b) {
  const utc = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT"]);
  return a === b || utc.has(a) && utc.has(b);
}

// The comparison concerns the saved setting, not whether it has taken effect
// in a running guest. Country/timezone uncertainty cannot become agreement.
export function locationTimezoneState(location, timezone) {
  if (!timezone || !canApplyLocationTimezone(location)) return "unknown";
  return sameLocationTimezone(timezone, location.timezone) ? "passed" : "failed";
}

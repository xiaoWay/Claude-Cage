package workbench

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/exitpolicy"
)

func TestRegionEvidencePreservesUncertainTimezone(t *testing.T) {
	cfg := cage.DefaultConfig()
	cfg.Timezone = "America/New_York"
	for _, state := range []string{exitpolicy.LocationConflict, exitpolicy.LocationInsufficient, exitpolicy.LocationConsistent} {
		loc := Location{Timezone: "America/Los_Angeles", CountryCode: "US", Evidence: &exitpolicy.LocationEvidence{TimezoneStatus: state, CountryStatus: exitpolicy.LocationConsistent}}
		got := autoRegionSettings(cfg, cfg, Preferences{AutoTimezone: true}, loc)
		want := cfg.Timezone
		if state == exitpolicy.LocationConsistent {
			want = loc.Timezone
		}
		if got.Timezone != want {
			t.Fatalf("%s changed timezone to %s", state, got.Timezone)
		}
		manual := autoRegionSettings(cfg, cfg, Preferences{}, loc)
		if manual != cfg {
			t.Fatal("location evidence overwrote manual choice")
		}
	}
}

func TestCountryEvidenceCannotBeOverriddenByTimezoneChoice(t *testing.T) {
	for _, other := range []string{"CA", "CN"} {
		loc := Location{IP: "192.0.2.10", CountryCode: "US", Timezone: "America/New_York", Evidence: &exitpolicy.LocationEvidence{CountryStatus: exitpolicy.LocationConflict, Sources: []exitpolicy.LocationSource{{CountryCode: "US"}, {CountryCode: other}}}}
		observed := loc.exitLocation()
		result, _ := exitpolicy.CheckExitCountry(loc.IP, &observed)
		if other == "CN" && result != cage.CheckFailed || other == "CA" && result != cage.CheckUnknown {
			t.Fatal("conflicting country was silently accepted", other, result)
		}
	}
}

func TestLocationEvidenceCacheAndSharing(t *testing.T) {
	s := testServer(t)
	loc := Location{IP: "192.0.2.10", CountryCode: "US", CheckedAt: time.Now(), Evidence: &exitpolicy.LocationEvidence{Status: exitpolicy.LocationConflict, TimezoneStatus: exitpolicy.LocationConflict, CountryStatus: exitpolicy.LocationConsistent}}
	s.locations = map[string]Location{loc.IP: loc}
	// This configuration cannot perform a network query: the recent evidence
	// must be reused by the monitor, including a timezone disagreement.
	got, err := s.locationForIP(context.Background(), cage.Config{}, loc.IP)
	if err != nil || got.Evidence != loc.Evidence {
		t.Fatal("cached evidence was queried again", err)
	}
	check := locationConsistencyCheck(&loc, "America/New_York", true)
	data, _ := json.Marshal(check)
	if check.Critical || check.State != cage.CheckUnknown || !strings.Contains(check.Evidence, "定位结果不一致") || strings.Contains(string(data), loc.IP) {
		t.Fatal("advisory strengthened claims or disclosed the address")
	}
}

func TestLocationAgreementDoesNotImplyAppliedTimezoneMatches(t *testing.T) {
	loc := Location{CountryCode: "US", Timezone: "America/New_York", Evidence: &exitpolicy.LocationEvidence{Status: exitpolicy.LocationConsistent, CountryStatus: exitpolicy.LocationConsistent, TimezoneStatus: exitpolicy.LocationConsistent}}
	mismatch := locationConsistencyCheck(&loc, "America/Los_Angeles", true)
	if mismatch.State != cage.CheckFailed || mismatch.Critical || !strings.Contains(mismatch.Evidence, "已应用时区不同") {
		t.Fatal("source agreement concealed config mismatch")
	}
	matched := locationConsistencyCheck(&loc, "America/New_York", true)
	if matched.State != cage.CheckPassed {
		t.Fatal("matching evidence missing")
	}
}

func TestLocationDisagreementCannotEstablishCityRule(t *testing.T) {
	loc := Location{IP: "192.0.2.10", CountryCode: "US", Region: "region-a", City: "city-a", Evidence: &exitpolicy.LocationEvidence{Status: exitpolicy.LocationConflict, CountryStatus: exitpolicy.LocationConsistent, TimezoneStatus: exitpolicy.LocationConsistent, Sources: []exitpolicy.LocationSource{{CountryCode: "US", Region: "region-a", City: "city-a"}, {CountryCode: "US", Region: "region-b", City: "city-b"}}}}
	observed := loc.exitLocation()
	if observed.Region != "" || observed.City != "" {
		t.Fatal("conflicting place silently became an anchor")
	}
	policy := cage.ExitPolicy{Mode: "dynamic", Scope: "city", CountryCode: "US", Region: "region-a", City: "city-a"}
	if state, _ := policy.Evaluate(loc.IP, &observed); state != cage.CheckUnknown {
		t.Fatal("disagreement passed a city rule", state)
	}
	policy = cage.ExitPolicy{Mode: "static", IP: loc.IP}
	if state, _ := policy.Evaluate(loc.IP, &observed); state != cage.CheckPassed {
		t.Fatal("city disagreement changed fixed IP evidence", state)
	}
}

func TestUncertainAutomaticRegionCannotUseClientDraft(t *testing.T) {
	saved := cage.DefaultConfig()
	saved.Timezone = "America/New_York"
	draft := saved
	draft.Timezone = "America/Los_Angeles"
	draft.Locale = "ja_JP.UTF-8"
	draft.BrowserLanguage = "ja-JP"
	location := Location{CountryCode: "US", Timezone: draft.Timezone, Evidence: &exitpolicy.LocationEvidence{CountryStatus: exitpolicy.LocationConflict, TimezoneStatus: exitpolicy.LocationConflict}}
	got := autoRegionSettings(draft, saved, Preferences{AutoTimezone: true, AutoLanguage: true}, location)
	if got != saved {
		t.Fatal("uncertain automatic region accepted an unconfirmed draft")
	}
	manual := autoRegionSettings(draft, saved, Preferences{}, location)
	if manual != draft {
		t.Fatal("explicit manual selection was overridden")
	}
}

func TestCityDisagreementDoesNotFailTimezoneComparison(t *testing.T) {
	location := Location{CountryCode: "US", Timezone: "America/New_York", Evidence: &exitpolicy.LocationEvidence{Status: exitpolicy.LocationConflict, CountryStatus: exitpolicy.LocationConsistent, TimezoneStatus: exitpolicy.LocationConsistent}}
	check := locationConsistencyCheck(&location, location.Timezone, true)
	if check.State != cage.CheckPassed || check.Critical || !strings.Contains(check.Evidence, "城市或地区来源存在分歧") {
		t.Fatal("city estimate disagreement was misclassified as a timezone mismatch")
	}
	location.CountryCode = "CN"
	if check := locationConsistencyCheck(&location, location.Timezone, false); check.State != cage.CheckUnknown {
		t.Fatal("mainland evidence silently passed comparison")
	}
	location.CountryCode = "US"
	location.Evidence.CountryStatus = exitpolicy.LocationInsufficient
	if check := locationConsistencyCheck(&location, location.Timezone, true); check.State != cage.CheckUnknown {
		t.Fatal("incomplete country evidence passed timezone comparison")
	}
}

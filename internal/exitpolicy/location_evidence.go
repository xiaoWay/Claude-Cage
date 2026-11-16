package exitpolicy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

const (
	LocationConsistent   = "consistent"
	LocationConflict     = "conflict"
	LocationInsufficient = "insufficient"
)

type LocationSource struct {
	Provider    string `json:"provider"`
	CountryCode string `json:"country_code,omitempty"`
	Region      string `json:"region,omitempty"`
	City        string `json:"city,omitempty"`
	Timezone    string `json:"timezone,omitempty"`
	Error       string `json:"error,omitempty"`
}

// Evidence is IP geolocation evidence, never proof of a device's physical
// position, a provider's internal risk score or account eligibility.
type LocationEvidence struct {
	Status         string           `json:"status"`
	CountryStatus  string           `json:"country_status"`
	TimezoneStatus string           `json:"timezone_status"`
	Sources        []LocationSource `json:"sources"`
	CheckedAt      time.Time        `json:"checked_at"`
}

// LookupEvidence uses the same caller-owned proxy-only client as Lookup.
// Queries run concurrently with each provider's existing eight-second limit.
// The first valid provider is retained deterministically; a majority never
// silently overwrites a conflicting timezone or country observation.
func LookupEvidence(ctx context.Context, client *http.Client, address net.IP) (Location, *LocationEvidence, error) {
	if err := ctx.Err(); err != nil {
		return Location{}, nil, err
	}
	type result struct {
		index    int
		location Location
		err      error
	}
	results := make(chan result, len(locationProviders))
	for i, provider := range locationProviders {
		go func() {
			loc, err := queryLocation(ctx, client, fmt.Sprintf(provider.url, address.String()), provider.requireSuccess, address)
			results <- result{i, loc, err}
		}()
	}
	locations := make([]Location, len(locationProviders))
	evidence := &LocationEvidence{Status: LocationInsufficient, CountryStatus: LocationInsufficient, TimezoneStatus: LocationInsufficient, Sources: make([]LocationSource, len(locationProviders)), CheckedAt: time.Now()}
	for range locationProviders {
		select {
		case <-ctx.Done():
			return Location{}, nil, ctx.Err()
		case result := <-results:
			source := LocationSource{Provider: locationProviders[result.index].name}
			if result.err != nil {
				source.Error = result.err.Error()
			} else {
				loc := result.location
				locations[result.index] = loc
				source.CountryCode, source.Region, source.City, source.Timezone = loc.CountryCode, loc.Region, loc.City, loc.Timezone
			}
			evidence.Sources[result.index] = source
		}
	}
	if err := ctx.Err(); err != nil {
		return Location{}, nil, err
	}
	var selected Location
	valid := 0
	countryConflict, zoneConflict, placeConflict := false, false, false
	for _, loc := range locations {
		if loc.IP == "" {
			continue
		}
		valid++
		if selected.IP == "" {
			selected = loc
			continue
		}
		countryConflict = countryConflict || selected.CountryCode != loc.CountryCode
		zoneConflict = zoneConflict || canonicalLocationTimezone(selected.Timezone) != canonicalLocationTimezone(loc.Timezone)
		placeConflict = placeConflict || !strings.EqualFold(strings.TrimSpace(selected.Region), strings.TrimSpace(loc.Region)) || !strings.EqualFold(strings.TrimSpace(selected.City), strings.TrimSpace(loc.City))
	}
	if valid == 0 {
		return Location{}, evidence, errors.New("已测得出口 IP，但各来源均未返回有效定位；请重试，未使用直连回退")
	}
	if valid >= 2 {
		evidence.Status, evidence.CountryStatus, evidence.TimezoneStatus = LocationConsistent, LocationConsistent, LocationConsistent
	}
	if countryConflict {
		evidence.CountryStatus = LocationConflict
	}
	if zoneConflict {
		evidence.TimezoneStatus = LocationConflict
	}
	if countryConflict || zoneConflict || placeConflict {
		evidence.Status = LocationConflict
	}
	return selected, evidence, nil
}

func canonicalLocationTimezone(zone string) string {
	switch zone {
	case "UTC", "Etc/UTC", "Etc/GMT", "GMT":
		return "UTC"
	default:
		return zone
	}
}

// SameLocationTimezone treats the common UTC aliases as the same zone while
// keeping different regional rules distinct, including their DST transitions.
func SameLocationTimezone(a, b string) bool {
	return canonicalLocationTimezone(a) == canonicalLocationTimezone(b)
}

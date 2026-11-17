package workbench

import (
	"context"
	"net"
	"net/http"
	"time"

	"github.com/sylvinus/agent-vm/internal/exitpolicy"
)

func lookupLocation(ctx context.Context, client *http.Client, address net.IP) (Location, error) {
	loc, err := exitpolicy.Lookup(ctx, client, address)
	if err != nil {
		return Location{}, err
	}
	locale, browser := languageSuggestion(loc.CountryCode)
	return Location{
		IP: loc.IP, Country: loc.Country, CountryCode: loc.CountryCode,
		Region: loc.Region, RegionCode: loc.RegionCode, City: loc.City,
		Timezone: loc.Timezone, CheckedAt: loc.CheckedAt,
		SuggestedLocale: locale, SuggestedBrowserLanguage: browser,
	}, nil
}

func lookupVerifiedLocation(ctx context.Context, client *http.Client, address net.IP) (Location, error) {
	loc, evidence, err := exitpolicy.LookupEvidence(ctx, client, address)
	if ctx.Err() != nil {
		return Location{}, ctx.Err()
	}
	locale, browser := languageSuggestion(loc.CountryCode)
	return Location{IP: address.String(), Country: loc.Country, CountryCode: loc.CountryCode, Region: loc.Region, RegionCode: loc.RegionCode, City: loc.City, Timezone: loc.Timezone, CheckedAt: time.Now(), SuggestedLocale: locale, SuggestedBrowserLanguage: browser, Evidence: evidence}, err
}

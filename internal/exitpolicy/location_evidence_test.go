package exitpolicy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func evidenceResponse(ip, country, city, zone string) *http.Response {
	data, _ := json.Marshal(map[string]any{"success": true, "ip": ip, "country": country, "country_code": country, "region": "test-region", "city": city, "timezone": zone})
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(data)))}
}

func TestLocationEvidenceDisagreements(t *testing.T) {
	for _, scenario := range []string{"consistent", "timezone conflict", "city conflict", "country conflict", "one source", "all unavailable", "wrong address", "UTC aliases"} {
		t.Run(scenario, func(t *testing.T) {
			client := &http.Client{Transport: locationTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Scheme != "https" || r.Method != "GET" || !strings.Contains(r.URL.Path, "192.0.2.10") || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("User-Agent") != "" {
					t.Error("location query changed fixed request or disclosed identity")
				}
				ip, country, city, zone := "192.0.2.10", "US", "sample-city", "America/New_York"
				primary := r.URL.Host == "ipwho.is"
				switch scenario {
				case "timezone conflict":
					if r.URL.Host == "ipapi.co" {
						zone = "America/Los_Angeles"
					}
				case "city conflict":
					if !primary {
						city = "another-city"
					}
				case "country conflict":
					if !primary {
						country = "CA"
					}
				case "one source":
					if !primary {
						return nil, errors.New("private upstream detail")
					}
				case "all unavailable":
					return nil, errors.New("private upstream detail")
				case "wrong address":
					if !primary {
						ip = "192.0.2.11"
					}
				case "UTC aliases":
					zone = "Etc/UTC"
					if primary {
						zone = "UTC"
					}
				}
				return evidenceResponse(ip, country, city, zone), nil
			})}
			loc, evidence, err := LookupEvidence(t.Context(), client, net.ParseIP("192.0.2.10"))
			if evidence == nil || len(evidence.Sources) != 5 {
				t.Fatal("missing source evidence")
			}
			if strings.Contains(strings.Join(func() []string {
				var s []string
				for _, r := range evidence.Sources {
					s = append(s, r.Error)
				}
				return s
			}(), " "), "private upstream detail") {
				t.Fatal("transport details escaped")
			}
			if scenario == "all unavailable" {
				if err == nil || loc.IP != "" || evidence.Status != LocationInsufficient {
					t.Fatal("unavailable providers invented a location")
				}
				return
			}
			if err != nil || loc.IP != "192.0.2.10" {
				t.Fatal("measured address lost", err)
			}
			want := LocationConsistent
			if strings.Contains(scenario, "conflict") {
				want = LocationConflict
			}
			if scenario == "one source" || scenario == "wrong address" {
				want = LocationInsufficient
			}
			if evidence.Status != want {
				t.Fatalf("status=%s, want %s", evidence.Status, want)
			}
			if scenario == "timezone conflict" && (loc.Timezone != "America/New_York" || evidence.TimezoneStatus != LocationConflict) {
				t.Fatal("conflict was hidden by a majority")
			}
			if scenario == "city conflict" && evidence.TimezoneStatus != LocationConsistent {
				t.Fatal("city disagreement changed timezone evidence")
			}
			if scenario == "country conflict" && evidence.CountryStatus != LocationConflict {
				t.Fatal("country conflict lost")
			}
		})
	}
}

func TestLocationEvidenceParallelTimeoutBudget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		client := &http.Client{Transport: locationTransport(func(r *http.Request) (*http.Response, error) {
			if r.URL.Host == "ipwho.is" || r.URL.Host == "api.ip.sb" {
				return evidenceResponse("192.0.2.10", "US", "sample-city", "America/New_York"), nil
			}
			<-r.Context().Done()
			return nil, r.Context().Err()
		})}
		loc, evidence, err := LookupEvidence(t.Context(), client, net.ParseIP("192.0.2.10"))
		if err != nil || evidence.TimezoneStatus != LocationConsistent || loc.IP != "192.0.2.10" {
			t.Fatal("valid partial evidence lost", err)
		}
		if elapsed := time.Since(started); elapsed != 8*time.Second {
			t.Fatalf("parallel budget=%v, want eight seconds", elapsed)
		}
	})
}

func TestLocationEvidenceCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	client := &http.Client{Transport: locationTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("canceled lookup made a request")
		return nil, nil
	})}
	_, evidence, err := LookupEvidence(ctx, client, net.ParseIP("192.0.2.10"))
	if !errors.Is(err, context.Canceled) || evidence != nil {
		t.Fatal("cancellation became partial success", err)
	}
}

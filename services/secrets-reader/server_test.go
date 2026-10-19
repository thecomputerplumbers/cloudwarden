package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const readerToken = "reader-token-for-tests-0123456789"

// fakeCloudwarden serves the machine routes with secrets the JavaScript library encrypted.
type fakeCloudwarden struct {
	v         vectors
	auths     atomic.Int32
	lists     atomic.Int32
	failLists atomic.Bool
	reject    atomic.Int32 // the next N list calls answer 401
	secrets   []map[string]string
}

func newFake(t *testing.T) (*fakeCloudwarden, *httptest.Server) {
	v := loadVectors(t)
	s := v.Secrets
	f := &fakeCloudwarden{v: v, secrets: []map[string]string{
		{"id": "11111111-1111-4111-8111-111111111111", "projectId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "key": s[3].Encrypted, "value": s[0].Encrypted},
		{"id": "22222222-2222-4222-8222-222222222222", "projectId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "key": s[4].Encrypted, "value": s[1].Encrypted},
		{"id": "33333333-3333-4333-8333-333333333333", "projectId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "key": s[3].Encrypted, "value": s[2].Encrypted},
	}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cloudwarden/sm/auth":
			token, _ := ParseAccessToken(v.Token)
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["tokenId"] != token.TokenID || body["clientSecret"] != token.ClientSecret {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			f.auths.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"accessToken": "bearer-" + string(rune('0'+f.auths.Load())), "expiresIn": 600, "organizationId": v.OrganizationID, "encryptedPayload": v.EncryptedPayload})
		case "/api/cloudwarden/sm/machine/secrets":
			f.lists.Add(1)
			if f.failLists.Load() {
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			if f.reject.Load() > 0 {
				f.reject.Add(-1)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": f.secrets})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return f, server
}

func newTestClient(t *testing.T, url string, ttl time.Duration) *Client {
	token, err := ParseAccessToken(loadVectors(t).Token)
	if err != nil {
		t.Fatal(err)
	}
	return NewClient(url, token, ttl, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func get(t *testing.T, handler http.Handler, path, bearer string) (int, map[string]any) {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var body map[string]any
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	return recorder.Code, body
}

func TestRoutes(t *testing.T) {
	_, upstream := newFake(t)
	v := loadVectors(t)
	handler := NewHandler(newTestClient(t, upstream.URL, time.Minute), readerToken)

	if code, _ := get(t, handler, "/healthz", ""); code != http.StatusServiceUnavailable {
		t.Fatalf("healthz before any load: %d, want 503", code)
	}
	if code, body := get(t, handler, "/v1/secrets/exactly-sixteen!", readerToken); code != 200 || body["value"] != v.Secrets[1].Plaintext {
		t.Fatalf("by key: %d %v", code, body)
	}
	if code, _ := get(t, handler, "/v1/secrets/x", readerToken); code != http.StatusConflict {
		t.Fatalf("duplicate key: %d, want 409", code)
	}
	if code, body := get(t, handler, "/v1/secrets/x?project=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", readerToken); code != 200 || body["value"] != v.Secrets[2].Plaintext {
		t.Fatalf("narrowed by project: %d %v", code, body)
	}
	if code, body := get(t, handler, "/v1/secrets/by-id/11111111-1111-4111-8111-111111111111", readerToken); code != 200 || body["value"] != v.Secrets[0].Plaintext {
		t.Fatalf("by id: %d %v", code, body)
	}
	if code, body := get(t, handler, "/v1/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", readerToken); code != 200 || len(body) != 2 || body["x"] != v.Secrets[0].Plaintext {
		t.Fatalf("project map: %d %v", code, body)
	}
	for _, path := range []string{"/v1/secrets/missing", "/v1/secrets/by-id/99999999-9999-4999-8999-999999999999", "/v1/projects/cccccccc-cccc-4ccc-8ccc-cccccccccccc"} {
		if code, _ := get(t, handler, path, readerToken); code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", path, code)
		}
	}
	for _, bearer := range []string{"", "wrong", readerToken + "x"} {
		if code, _ := get(t, handler, "/v1/secrets/exactly-sixteen!", bearer); code != http.StatusUnauthorized {
			t.Errorf("bearer %q: %d, want 401", bearer, code)
		}
	}
	if code, body := get(t, handler, "/healthz", ""); code != 200 || body["authenticated"] != true {
		t.Fatalf("healthz after load: %d %v", code, body)
	}
}

func TestCachesForTheTTL(t *testing.T) {
	fake, upstream := newFake(t)
	client := newTestClient(t, upstream.URL, time.Hour)
	for range 5 {
		if _, err := client.Secrets(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if fake.lists.Load() != 1 || fake.auths.Load() != 1 {
		t.Fatalf("lists %d, auths %d: want 1 and 1", fake.lists.Load(), fake.auths.Load())
	}
}

func TestReauthenticatesWhenTheBearerIsRefused(t *testing.T) {
	fake, upstream := newFake(t)
	client := newTestClient(t, upstream.URL, time.Nanosecond)
	if _, err := client.Secrets(context.Background()); err != nil {
		t.Fatal(err)
	}
	fake.reject.Store(1)
	time.Sleep(time.Millisecond)
	secrets, err := client.Secrets(context.Background())
	if err != nil || len(secrets) != 3 {
		t.Fatalf("after a 401: %v, %d secrets", err, len(secrets))
	}
	if fake.auths.Load() != 2 {
		t.Fatalf("auths %d, want 2", fake.auths.Load())
	}
}

func TestReauthenticatesBeforeExpiry(t *testing.T) {
	fake, upstream := newFake(t)
	client := newTestClient(t, upstream.URL, time.Nanosecond)
	now := time.Now()
	client.now = func() time.Time { return now }
	if _, err := client.Secrets(context.Background()); err != nil {
		t.Fatal(err)
	}
	now = now.Add(9*time.Minute + 31*time.Second) // inside the 30s margin of a 600s token
	if _, err := client.Secrets(context.Background()); err != nil {
		t.Fatal(err)
	}
	if fake.auths.Load() != 2 {
		t.Fatalf("auths %d, want 2", fake.auths.Load())
	}
}

func TestServesTheLastGoodCopyWhenRefreshFails(t *testing.T) {
	fake, upstream := newFake(t)
	client := newTestClient(t, upstream.URL, time.Nanosecond)
	if _, err := client.Secrets(context.Background()); err != nil {
		t.Fatal(err)
	}
	fake.failLists.Store(true)
	time.Sleep(time.Millisecond)
	secrets, err := client.Secrets(context.Background())
	if err != nil || len(secrets) != 3 {
		t.Fatalf("stale read: %v, %d secrets", err, len(secrets))
	}
	health := client.Health()
	if !health.Stale || health.LastError == "" {
		t.Fatalf("health does not report the stale copy: %+v", health)
	}
	fake.failLists.Store(false)
	time.Sleep(time.Millisecond)
	if _, err := client.Secrets(context.Background()); err != nil || client.Health().Stale {
		t.Fatalf("did not recover: %v %+v", err, client.Health())
	}
}

func TestFailsWithoutACopy(t *testing.T) {
	fake, upstream := newFake(t)
	fake.failLists.Store(true)
	handler := NewHandler(newTestClient(t, upstream.URL, time.Minute), readerToken)
	if code, _ := get(t, handler, "/v1/secrets/x", readerToken); code != http.StatusBadGateway {
		t.Fatalf("no copy yet: %d, want 502", code)
	}
}

package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
)

// SecretSource is what the HTTP routes read from: the Client, or a fake in tests.
type SecretSource interface {
	Secrets(ctx context.Context) ([]Secret, error)
	Health() Health
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// requireBearer admits only `Authorization: Bearer <readerToken>`, compared in
// constant time over digests so the token's length does not leak either.
func requireBearer(readerToken string, next http.Handler) http.Handler {
	want := sha256.Sum256([]byte(readerToken))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		presented, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		got := sha256.Sum256([]byte(presented))
		if !ok || subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// NewHandler serves External Secrets Operator's webhook provider (docs/secrets-manager.md).
func NewHandler(source SecretSource, readerToken string) http.Handler {
	api := http.NewServeMux()
	load := func(w http.ResponseWriter, r *http.Request) ([]Secret, bool) {
		secrets, err := source.Secrets(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, "secrets are unavailable")
			return nil, false
		}
		return secrets, true
	}
	api.HandleFunc("GET /v1/secrets/by-id/{id}", func(w http.ResponseWriter, r *http.Request) {
		secrets, ok := load(w, r)
		if !ok {
			return
		}
		id := strings.ToLower(r.PathValue("id"))
		for _, secret := range secrets {
			if strings.ToLower(secret.ID) == id {
				writeJSON(w, http.StatusOK, map[string]string{"value": secret.Value})
				return
			}
		}
		writeError(w, http.StatusNotFound, "secret not found")
	})
	api.HandleFunc("GET /v1/secrets/{key}", func(w http.ResponseWriter, r *http.Request) {
		secrets, ok := load(w, r)
		if !ok {
			return
		}
		key, project := r.PathValue("key"), strings.ToLower(r.URL.Query().Get("project"))
		var found []Secret
		for _, secret := range secrets {
			if secret.Key == key && (project == "" || strings.ToLower(secret.ProjectID) == project) {
				found = append(found, secret)
			}
		}
		switch len(found) {
		case 0:
			writeError(w, http.StatusNotFound, "secret not found")
		case 1:
			writeJSON(w, http.StatusOK, map[string]string{"value": found[0].Value})
		default:
			writeError(w, http.StatusConflict, "several readable secrets have this key; add ?project=")
		}
	})
	api.HandleFunc("GET /v1/projects/{projectId}", func(w http.ResponseWriter, r *http.Request) {
		secrets, ok := load(w, r)
		if !ok {
			return
		}
		project := strings.ToLower(r.PathValue("projectId"))
		values := map[string]string{}
		for _, secret := range secrets {
			if strings.ToLower(secret.ProjectID) != project {
				continue
			}
			if _, dup := values[secret.Key]; dup {
				writeError(w, http.StatusConflict, "this project has several secrets with one key")
				return
			}
			values[secret.Key] = secret.Value
		}
		if len(values) == 0 {
			writeError(w, http.StatusNotFound, "no readable secrets in this project")
			return
		}
		writeJSON(w, http.StatusOK, values)
	})

	root := http.NewServeMux()
	root.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		health := source.Health()
		status := http.StatusOK
		if !health.Authenticated {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, health)
	})
	root.Handle("/v1/", requireBearer(readerToken, api))
	return root
}

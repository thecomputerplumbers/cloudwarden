package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Secret is a decrypted secret.
type Secret struct {
	ID        string
	ProjectID string
	Key       string
	Value     string
}

// Client talks to cloudwarden's machine routes and keeps a decrypted cache.
type Client struct {
	baseURL string
	token   AccessToken
	http    *http.Client
	ttl     time.Duration
	log     *slog.Logger
	now     func() time.Time

	authMu    sync.Mutex
	access    string
	expires   time.Time
	orgKey    *SymmetricKey
	authedYet bool

	cacheMu   sync.Mutex
	secrets   []Secret
	fetchedAt time.Time
	attempted time.Time
	lastError string
	stale     bool
}

func NewClient(baseURL string, token AccessToken, ttl time.Duration, log *slog.Logger) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 15 * time.Second},
		ttl:     ttl,
		log:     log,
		now:     time.Now,
	}
}

type httpError struct {
	status int
	path   string
}

func (e *httpError) Error() string { return fmt.Sprintf("%s: HTTP %d", e.path, e.status) }

func (c *Client) do(ctx context.Context, method, path, bearer string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		return err
	}
	if response.StatusCode/100 != 2 {
		return &httpError{status: response.StatusCode, path: path}
	}
	return json.Unmarshal(data, out)
}

// authenticate exchanges the access token for a short-lived bearer and opens
// the payload to recover the organization key.
func (c *Client) authenticate(ctx context.Context) error {
	var response struct {
		AccessToken      string `json:"accessToken"`
		ExpiresIn        int    `json:"expiresIn"`
		OrganizationID   string `json:"organizationId"`
		EncryptedPayload string `json:"encryptedPayload"`
	}
	err := c.do(ctx, http.MethodPost, "/api/cloudwarden/sm/auth", "", map[string]string{
		"tokenId":      c.token.TokenID,
		"clientSecret": c.token.ClientSecret,
	}, &response)
	if err != nil {
		return fmt.Errorf("authenticate: %w", err)
	}
	payload, err := OpenPayload(response.EncryptedPayload, c.token.KeyMaterial)
	if err != nil {
		return fmt.Errorf("open access token payload: %w", err)
	}
	if payload.OrganizationID != response.OrganizationID {
		return errors.New("access token payload is for another organization")
	}
	lifetime := time.Duration(response.ExpiresIn) * time.Second
	// Re-authenticate a little before the server's expiry.
	margin := min(30*time.Second, lifetime/5)
	c.access = response.AccessToken
	c.expires = c.now().Add(lifetime - margin)
	c.orgKey = &payload.OrganizationKey
	c.authedYet = true
	return nil
}

// bearer returns a valid bearer, authenticating when there is none or it is about to expire.
func (c *Client) bearer(ctx context.Context, force bool) (string, SymmetricKey, error) {
	c.authMu.Lock()
	defer c.authMu.Unlock()
	if force || c.access == "" || !c.now().Before(c.expires) {
		if err := c.authenticate(ctx); err != nil {
			return "", SymmetricKey{}, err
		}
	}
	return c.access, *c.orgKey, nil
}

// Authenticated reports whether the reader has ever authenticated successfully.
func (c *Client) Authenticated() bool {
	c.authMu.Lock()
	defer c.authMu.Unlock()
	return c.authedYet
}

type remoteSecret struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Key       string `json:"key"`
	Value     string `json:"value"`
}

func (c *Client) fetch(ctx context.Context) ([]Secret, error) {
	var list struct {
		Data []remoteSecret `json:"data"`
	}
	bearer, key, err := c.bearer(ctx, false)
	if err != nil {
		return nil, err
	}
	err = c.do(ctx, http.MethodGet, "/api/cloudwarden/sm/machine/secrets", bearer, nil, &list)
	var status *httpError
	if errors.As(err, &status) && status.status == http.StatusUnauthorized {
		// The bearer was refused (expired or revoked): authenticate again, once.
		if bearer, key, err = c.bearer(ctx, true); err != nil {
			return nil, err
		}
		err = c.do(ctx, http.MethodGet, "/api/cloudwarden/sm/machine/secrets", bearer, nil, &list)
	}
	if err != nil {
		return nil, fmt.Errorf("list secrets: %w", err)
	}
	secrets := make([]Secret, 0, len(list.Data))
	for _, remote := range list.Data {
		k, err := DecryptString(remote.Key, key)
		if err != nil {
			return nil, fmt.Errorf("decrypt secret %s key: %w", remote.ID, err)
		}
		v, err := DecryptString(remote.Value, key)
		if err != nil {
			return nil, fmt.Errorf("decrypt secret %s value: %w", remote.ID, err)
		}
		secrets = append(secrets, Secret{ID: remote.ID, ProjectID: remote.ProjectID, Key: string(k), Value: string(v)})
	}
	return secrets, nil
}

// Secrets returns the decrypted secrets, refreshing when the cache is older
// than the TTL. A failed refresh serves the last good copy and says so.
func (c *Client) Secrets(ctx context.Context) ([]Secret, error) {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	// One attempt per TTL, fresh or failing: an outage is not retried on every request.
	if !c.fetchedAt.IsZero() && c.now().Sub(c.attempted) < c.ttl {
		return c.secrets, nil
	}
	c.attempted = c.now()
	fresh, err := c.fetch(ctx)
	if err != nil {
		c.lastError = err.Error()
		if !c.fetchedAt.IsZero() {
			if !c.stale {
				c.log.Warn("refresh failed; serving the last good copy", "error", err.Error(), "age", c.now().Sub(c.fetchedAt).Round(time.Second).String())
			}
			c.stale = true
			return c.secrets, nil
		}
		return nil, err
	}
	if c.stale {
		c.log.Info("refresh recovered")
	}
	c.secrets, c.fetchedAt, c.lastError, c.stale = fresh, c.now(), "", false
	return c.secrets, nil
}

// Health describes the cache, never its contents.
type Health struct {
	Authenticated bool   `json:"authenticated"`
	Secrets       int    `json:"secrets"`
	FetchedAt     string `json:"fetchedAt,omitempty"`
	Stale         bool   `json:"stale"`
	LastError     string `json:"lastError,omitempty"`
}

func (c *Client) Health() Health {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	health := Health{Authenticated: c.Authenticated(), Secrets: len(c.secrets), Stale: c.stale, LastError: c.lastError}
	if !c.fetchedAt.IsZero() {
		health.FetchedAt = c.fetchedAt.UTC().Format(time.RFC3339)
	}
	return health
}

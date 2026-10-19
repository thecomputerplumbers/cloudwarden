// Command secrets-reader serves cloudwarden Secrets Manager secrets to
// External Secrets Operator inside a Kubernetes cluster. It authenticates
// with a machine access token, decrypts locally, and never logs a secret.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type config struct {
	url         string
	token       AccessToken
	readerToken string
	listen      string
	ttl         time.Duration
}

func loadConfig() (config, error) {
	c := config{
		url:         os.Getenv("CLOUDWARDEN_URL"),
		readerToken: os.Getenv("READER_TOKEN"),
		listen:      os.Getenv("LISTEN_ADDR"),
		ttl:         60 * time.Second,
	}
	if c.listen == "" {
		c.listen = ":8080"
	}
	if c.url == "" {
		return c, errors.New("CLOUDWARDEN_URL is required")
	}
	if len(c.readerToken) < 16 {
		return c, errors.New("READER_TOKEN is required (at least 16 characters)")
	}
	token, err := ParseAccessToken(os.Getenv("CLOUDWARDEN_ACCESS_TOKEN"))
	if err != nil {
		return c, errors.New("CLOUDWARDEN_ACCESS_TOKEN is missing or not a cw1 token")
	}
	c.token = token
	if raw := os.Getenv("CACHE_TTL"); raw != "" {
		ttl, err := time.ParseDuration(raw)
		if err != nil || ttl <= 0 {
			return c, errors.New("CACHE_TTL must be a positive duration such as 60s")
		}
		c.ttl = ttl
	}
	return c, nil
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := loadConfig()
	if err != nil {
		log.Error("configuration", "error", err.Error())
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	client := NewClient(cfg.url, cfg.token, cfg.ttl, log)
	// Authenticate and warm the cache in the background; /healthz stays 503 until it works.
	go func() {
		for delay := time.Second; ctx.Err() == nil; delay = min(delay*2, time.Minute) {
			if _, err := client.Secrets(ctx); err == nil {
				log.Info("authenticated and loaded secrets", "token", cfg.token.TokenID)
				return
			} else {
				log.Warn("initial load failed; retrying", "error", err.Error(), "in", delay.String())
			}
			select {
			case <-ctx.Done():
			case <-time.After(delay):
			}
		}
	}()

	server := &http.Server{
		Addr:              cfg.listen,
		Handler:           NewHandler(client, cfg.readerToken),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Info("listening", "addr", cfg.listen, "cacheTTL", cfg.ttl.String())
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server", "error", err.Error())
		os.Exit(1)
	}
}

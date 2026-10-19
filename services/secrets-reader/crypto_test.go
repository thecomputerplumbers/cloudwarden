package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type vectors struct {
	OrganizationID   string `json:"organizationId"`
	OrganizationKey  string `json:"organizationKey"`
	Token            string `json:"token"`
	EncryptedPayload string `json:"encryptedPayload"`
	Secrets          []struct {
		Plaintext string `json:"plaintext"`
		Encrypted string `json:"encrypted"`
	} `json:"secrets"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	data, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// The JavaScript library made these; Go must read every one exactly.
func TestJavaScriptVectors(t *testing.T) {
	v := loadVectors(t)
	token, err := ParseAccessToken(v.Token)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := OpenPayload(v.EncryptedPayload, token.KeyMaterial)
	if err != nil {
		t.Fatalf("open payload: %v", err)
	}
	if payload.OrganizationID != v.OrganizationID {
		t.Fatalf("organization %q, want %q", payload.OrganizationID, v.OrganizationID)
	}
	raw, _ := base64.StdEncoding.DecodeString(v.OrganizationKey)
	if string(append(payload.OrganizationKey.Enc, payload.OrganizationKey.Mac...)) != string(raw) {
		t.Fatal("the payload's organization key differs from the one encrypted")
	}
	for i, secret := range v.Secrets {
		plain, err := DecryptString(secret.Encrypted, payload.OrganizationKey)
		if err != nil {
			t.Fatalf("secret %d: %v", i, err)
		}
		if string(plain) != secret.Plaintext {
			t.Fatalf("secret %d: got %q, want %q", i, plain, secret.Plaintext)
		}
	}
}

func orgKeyOf(t *testing.T, v vectors) SymmetricKey {
	raw, _ := base64.StdEncoding.DecodeString(v.OrganizationKey)
	key, err := NewSymmetricKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// tamper flips one bit in part i (0 iv, 1 data, 2 mac) of a type 2 string.
func tamper(t *testing.T, value string, part int) string {
	parts := strings.Split(strings.TrimPrefix(value, "2."), "|")
	bytes, err := base64.StdEncoding.DecodeString(parts[part])
	if err != nil {
		t.Fatal(err)
	}
	bytes[0] ^= 1
	parts[part] = base64.StdEncoding.EncodeToString(bytes)
	return "2." + strings.Join(parts, "|")
}

func TestRejectsTamperingAndWrongKeys(t *testing.T) {
	v := loadVectors(t)
	key := orgKeyOf(t, v)
	encrypted := v.Secrets[0].Encrypted
	for name, value := range map[string]string{
		"tampered mac":  tamper(t, encrypted, 2),
		"tampered iv":   tamper(t, encrypted, 0),
		"tampered data": tamper(t, encrypted, 1),
		"not type 2":    "0." + strings.TrimPrefix(encrypted, "2."),
		"two parts":     "2.AAAA|BBBB",
		"bad base64":    "2.!!!|@@@|###",
	} {
		if _, err := DecryptString(value, key); err == nil {
			t.Errorf("%s: decrypted, want an error", name)
		}
	}
	wrong := key
	wrong.Mac = append([]byte(nil), key.Mac...)
	wrong.Mac[0] ^= 1
	if _, err := DecryptString(encrypted, wrong); err == nil {
		t.Error("wrong MAC key: decrypted, want an error")
	}
	token, _ := ParseAccessToken(v.Token)
	material := append([]byte(nil), token.KeyMaterial...)
	material[0] ^= 1
	if _, err := OpenPayload(v.EncryptedPayload, material); err == nil {
		t.Error("wrong token key material opened the payload")
	}
}

func TestBadPaddingIsRejected(t *testing.T) {
	if _, err := unpad(append(make([]byte, 15), 0)); err == nil {
		t.Error("zero padding accepted")
	}
	if _, err := unpad(append(make([]byte, 14), 3, 2)); err == nil {
		t.Error("inconsistent padding accepted")
	}
	if _, err := unpad(append(make([]byte, 15), 17)); err == nil {
		t.Error("padding longer than a block accepted")
	}
}

func TestParseAccessTokenRejectsMalformed(t *testing.T) {
	good := loadVectors(t).Token
	parts := strings.Split(good, ".")
	for name, token := range map[string]string{
		"empty":          "",
		"wrong prefix":   "cw2." + strings.Join(parts[1:], "."),
		"three parts":    strings.Join(parts[:3], "."),
		"five parts":     good + ".x",
		"short material": strings.Join(append(parts[:3:3], "AAAA"), "."),
		"bad base64":     strings.Join(append(parts[:3:3], "!!!!!!!!!!!!!!!!!!!!!!"), "."),
		"empty secret":   strings.Join([]string{parts[0], parts[1], "", parts[3]}, "."),
	} {
		if _, err := ParseAccessToken(token); err == nil {
			t.Errorf("%s: parsed, want an error", name)
		}
	}
	if _, err := ParseAccessToken("  " + good + "\n"); err != nil {
		t.Errorf("surrounding whitespace: %v", err)
	}
}

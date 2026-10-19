package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Crypto for cloudwarden's Secrets Manager, as docs/secrets-manager.md
// specifies it: Bitwarden's type 2 encrypted strings, and access tokens whose
// key is derived with HKDF-SHA256.

// SymmetricKey is a 64-byte key: 32 bytes of AES-256 key, then 32 of HMAC-SHA256 key.
type SymmetricKey struct {
	Enc []byte
	Mac []byte
}

var errDecrypt = errors.New("decryption failed")

func NewSymmetricKey(raw []byte) (SymmetricKey, error) {
	if len(raw) != 64 {
		return SymmetricKey{}, fmt.Errorf("a symmetric key is 64 bytes, not %d", len(raw))
	}
	return SymmetricKey{Enc: append([]byte(nil), raw[:32]...), Mac: append([]byte(nil), raw[32:]...)}, nil
}

// DecryptString opens a type 2 string, `2.<iv>|<data>|<mac>`. The MAC is
// checked, in constant time, before anything is decrypted.
func DecryptString(value string, key SymmetricKey) ([]byte, error) {
	rest, ok := strings.CutPrefix(value, "2.")
	if !ok {
		return nil, errors.New("not a type 2 encrypted string")
	}
	parts := strings.Split(rest, "|")
	if len(parts) != 3 {
		return nil, errors.New("not a type 2 encrypted string")
	}
	var decoded [3][]byte
	for i, part := range parts {
		bytes, err := base64.StdEncoding.DecodeString(part)
		if err != nil {
			return nil, errors.New("not a type 2 encrypted string")
		}
		decoded[i] = bytes
	}
	iv, data, mac := decoded[0], decoded[1], decoded[2]
	if len(iv) != aes.BlockSize || len(data) == 0 || len(data)%aes.BlockSize != 0 {
		return nil, errDecrypt
	}
	h := hmac.New(sha256.New, key.Mac)
	h.Write(iv)
	h.Write(data)
	if !hmac.Equal(h.Sum(nil), mac) {
		return nil, errDecrypt
	}
	block, err := aes.NewCipher(key.Enc)
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(data))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, data)
	return unpad(plain)
}

func unpad(plain []byte) ([]byte, error) {
	n := int(plain[len(plain)-1])
	if n == 0 || n > aes.BlockSize || n > len(plain) {
		return nil, errDecrypt
	}
	for _, b := range plain[len(plain)-n:] {
		if int(b) != n {
			return nil, errDecrypt
		}
	}
	return plain[:len(plain)-n], nil
}

// AccessToken is a parsed `cw1.<tokenId>.<clientSecret>.<keyMaterial>` token.
type AccessToken struct {
	TokenID      string
	ClientSecret string
	KeyMaterial  []byte
}

func ParseAccessToken(token string) (AccessToken, error) {
	invalid := errors.New("not a cloudwarden access token")
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 4 || parts[0] != "cw1" || parts[1] == "" || parts[2] == "" {
		return AccessToken{}, invalid
	}
	material, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || len(material) != 16 {
		return AccessToken{}, invalid
	}
	return AccessToken{TokenID: parts[1], ClientSecret: parts[2], KeyMaterial: material}, nil
}

// TokenKey derives the 64-byte token key from the token's key material.
func TokenKey(keyMaterial []byte) (SymmetricKey, error) {
	raw, err := hkdf.Key(sha256.New, keyMaterial, []byte("cloudwarden-sm-access-token"), "sm-access-token-key", 64)
	if err != nil {
		return SymmetricKey{}, err
	}
	return NewSymmetricKey(raw)
}

// Payload is what an access token's encrypted payload holds.
type Payload struct {
	OrganizationID  string
	OrganizationKey SymmetricKey
}

// OpenPayload decrypts the payload `auth` returns, recovering the organization key.
func OpenPayload(encryptedPayload string, keyMaterial []byte) (Payload, error) {
	key, err := TokenKey(keyMaterial)
	if err != nil {
		return Payload{}, err
	}
	plain, err := DecryptString(encryptedPayload, key)
	if err != nil {
		return Payload{}, err
	}
	var payload struct {
		OrganizationID  string `json:"organizationId"`
		OrganizationKey string `json:"organizationKey"`
	}
	if err := json.Unmarshal(plain, &payload); err != nil {
		return Payload{}, errors.New("malformed access token payload")
	}
	raw, err := base64.StdEncoding.DecodeString(payload.OrganizationKey)
	if err != nil {
		return Payload{}, errors.New("malformed access token payload")
	}
	orgKey, err := NewSymmetricKey(raw)
	if err != nil {
		return Payload{}, err
	}
	return Payload{OrganizationID: payload.OrganizationID, OrganizationKey: orgKey}, nil
}

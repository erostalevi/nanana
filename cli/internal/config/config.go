// Package config resolves tokens, API base and the credentials file.
package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// DefaultAPI is the production API base.
const DefaultAPI = "https://api.nanana.lat"

// Credentials is the on-disk login state.
type Credentials struct {
	Token string `json:"token"`
	Email string `json:"email,omitempty"`
	API   string `json:"api,omitempty"`
}

// Dir returns the nanana config directory.
// XDG_CONFIG_HOME wins, then %AppData% on Windows, then ~/.config.
func Dir() (string, error) {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "nanana"), nil
	}
	if runtime.GOOS == "windows" {
		if a := os.Getenv("AppData"); a != "" {
			return filepath.Join(a, "nanana"), nil
		}
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".config", "nanana"), nil
}

// Path returns the credentials file path.
func Path() (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "credentials.json"), nil
}

// ErrNoCredentials is returned by Load when nothing is stored.
var ErrNoCredentials = errors.New("not logged in")

// Load reads the credentials file.
func Load() (*Credentials, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoCredentials
	}
	if err != nil {
		return nil, err
	}
	var c Credentials
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	if c.Token == "" {
		return nil, ErrNoCredentials
	}
	return &c, nil
}

// Save writes the credentials file with mode 0600 (dir 0700).
func Save(c *Credentials) error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Delete removes the credentials file; a missing file is not an error.
func Delete() error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// APIBase resolves the API base: flag, NANANA_API, default. Trailing slash trimmed.
func APIBase(flag string) string {
	v := flag
	if v == "" {
		v = os.Getenv("NANANA_API")
	}
	if v == "" {
		v = DefaultAPI
	}
	return strings.TrimRight(v, "/")
}

// Token resolves a token: flag, NANANA_TOKEN, credentials file.
// Credentials saved for a different API base are ignored so a token is never
// sent to a server it was not issued by. source describes where it came from.
func Token(flag, apiBase string) (token, source string) {
	if flag != "" {
		return flag, "flag"
	}
	if v := os.Getenv("NANANA_TOKEN"); v != "" {
		return v, "env"
	}
	if c, err := Load(); err == nil {
		if c.API == "" || strings.TrimRight(c.API, "/") == apiBase {
			return c.Token, "credentials"
		}
	}
	return "", ""
}

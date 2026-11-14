package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCredentialsRoundTripAndPerms(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	if _, err := Load(); err != ErrNoCredentials {
		t.Fatalf("want ErrNoCredentials, got %v", err)
	}
	if err := Save(&Credentials{Token: "nna_abc", Email: "a@b.c", API: "http://x"}); err != nil {
		t.Fatal(err)
	}
	p, _ := Path()
	if p != filepath.Join(dir, "nanana", "credentials.json") {
		t.Fatalf("path %s", p)
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v", st.Mode().Perm())
		}
	}
	c, err := Load()
	if err != nil || c.Token != "nna_abc" || c.Email != "a@b.c" {
		t.Fatalf("load %+v %v", c, err)
	}
	if err := Delete(); err != nil {
		t.Fatal(err)
	}
	if err := Delete(); err != nil {
		t.Fatal("second delete should be fine", err)
	}
	if _, err := Load(); err != ErrNoCredentials {
		t.Fatal("want gone")
	}
}

func TestTokenPrecedence(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("NANANA_TOKEN", "")
	if tok, _ := Token("", "http://x"); tok != "" {
		t.Fatal("expected none")
	}
	_ = Save(&Credentials{Token: "nna_file", API: "http://x"})
	if tok, src := Token("", "http://x"); tok != "nna_file" || src != "credentials" {
		t.Fatal(tok, src)
	}
	if tok, _ := Token("", "http://other"); tok != "" {
		t.Fatal("credentials for other API must be ignored")
	}
	t.Setenv("NANANA_TOKEN", "nnt_env")
	if tok, src := Token("", "http://x"); tok != "nnt_env" || src != "env" {
		t.Fatal(tok, src)
	}
	if tok, src := Token("nnt_flag", "http://x"); tok != "nnt_flag" || src != "flag" {
		t.Fatal(tok, src)
	}
}

func TestAPIBase(t *testing.T) {
	t.Setenv("NANANA_API", "")
	if APIBase("") != DefaultAPI {
		t.Fatal("default")
	}
	t.Setenv("NANANA_API", "http://e/")
	if APIBase("") != "http://e" {
		t.Fatal("env")
	}
	if APIBase("http://f//") != "http://f" {
		t.Fatal("flag")
	}
}

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/erostalevi/nanana/cli/internal/config"
)

func testApp(t *testing.T) (*app, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("NANANA_TOKEN", "")
	t.Setenv("NANANA_API", "")
	t.Setenv("NANANA_SUB", "")
	out, errb := &bytes.Buffer{}, &bytes.Buffer{}
	a := newApp("1.0.0")
	a.out, a.errOut, a.in = out, errb, strings.NewReader("")
	a.openBrowser = func(string) error { return nil }
	return a, out, errb
}

func parse(t *testing.T, args ...string) (*tunnelOpts, int) {
	a, _, errb := testApp(t)
	var got *tunnelOpts
	calls := 0
	a.runTunnel = func(ctx context.Context, o *tunnelOpts) error { got = o; calls++; return nil }
	if code := a.execute(context.Background(), args); code != 0 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	return got, calls
}

func TestShorthandFlags(t *testing.T) {
	o, n := parse(t, "-t=x", "-p=3000", "-h=192.168.1.20")
	if n != 1 || o.Token != "x" || o.Port != 3000 || o.Host != "192.168.1.20" || o.Scheme != "http" {
		t.Fatalf("%d %+v", n, o)
	}
	tg, err := o.target()
	if err != nil || tg.String() != "http://192.168.1.20:3000" {
		t.Fatalf("%v %v", tg, err)
	}
}

func TestTunnelSubcommandFlags(t *testing.T) {
	o, _ := parse(t, "tunnel", "myslug", "-t", "nnt_a", "-p", "8080", "-h", "db.local", "--scheme", "https",
		"--preserve-host", "--no-tail", "--json")
	if o.slugArg != "myslug" || o.Token != "nnt_a" || o.Port != 8080 || o.Host != "db.local" || o.Scheme != "https" ||
		!o.PreserveHost || !o.NoTail || !o.JSON {
		t.Fatalf("%+v", o)
	}
	o, _ = parse(t, "tunnel", "--url", "https://localhost:9443", "--sub", "abc")
	tg, err := o.target()
	if err != nil || tg.String() != "https://localhost:9443" || o.Sub != "abc" {
		t.Fatalf("%v %v", tg, err)
	}
}

func TestTargetValidation(t *testing.T) {
	for _, o := range []*tunnelOpts{
		{Host: "x", Scheme: "http"}, {Port: 70000, Host: "x", Scheme: "http"}, {Port: 1, Scheme: "ftp"}, {URL: "nope"},
	} {
		if _, err := o.target(); err == nil {
			t.Fatalf("expected error for %+v", o)
		}
	}
	tg, _ := (&tunnelOpts{Port: 80, Host: "[::1]", Scheme: "http"}).target()
	if tg.String() != "http://[::1]:80" {
		t.Fatal(tg.String())
	}
}

func TestHelpIsLongOnly(t *testing.T) {
	a, out, _ := testApp(t)
	a.runTunnel = func(context.Context, *tunnelOpts) error { return nil }
	if code := a.execute(context.Background(), []string{"--help"}); code != 0 || !strings.Contains(out.String(), "--host") {
		t.Fatalf("help: %d %s", code, out.String())
	}
	if !strings.Contains(out.String(), "-h, --host") {
		t.Fatalf("-h must be --host:\n%s", out.String())
	}
	// bare `nanana` shows help rather than starting a tunnel
	out.Reset()
	called := false
	a.runTunnel = func(context.Context, *tunnelOpts) error { called = true; return nil }
	a.execute(context.Background(), nil)
	if called || !strings.Contains(out.String(), "Usage") {
		t.Fatal("bare nanana should print help")
	}
}

// fakeAPI serves the REST endpoints used by the commands.
func fakeAPI(t *testing.T) (*httptest.Server, *atomic.Int32) {
	var polls atomic.Int32
	mux := http.NewServeMux()
	wj := func(w http.ResponseWriter, code int, v interface{}) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("/auth/device", func(w http.ResponseWriter, r *http.Request) {
		wj(w, 200, map[string]interface{}{"deviceCode": "dc", "userCode": "ABCD-EFGH",
			"verificationUri": "https://nanana.lat/device", "verificationUriComplete": "https://nanana.lat/device?code=ABCD-EFGH",
			"interval": 1, "expiresIn": 600})
	})
	mux.HandleFunc("/auth/device/token", func(w http.ResponseWriter, r *http.Request) {
		switch polls.Add(1) {
		case 1:
			wj(w, 400, map[string]interface{}{"error": map[string]string{"code": "authorization_pending"}})
		case 2:
			wj(w, 400, map[string]interface{}{"error": map[string]string{"code": "slow_down"}})
		default:
			wj(w, 200, map[string]interface{}{"accessToken": "nna_secret", "account": map[string]string{"email": "me@x.io"}})
		}
	})
	mux.HandleFunc("/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer nna_secret" {
			wj(w, 401, map[string]interface{}{"error": map[string]string{"code": "unauthorized", "message": "no"}})
			return
		}
		wj(w, 200, map[string]interface{}{"account": map[string]string{"email": "me@x.io", "plan": "free"}, "limits": map[string]int{"maxActiveSubdomains": 3}})
	})
	mux.HandleFunc("/subdomains", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			var in map[string]string
			_ = json.NewDecoder(r.Body).Decode(&in)
			slug := "rand1234"
			if in["name"] != "" {
				slug = in["name"]
			}
			wj(w, 201, map[string]interface{}{"subdomain": map[string]string{"slug": slug, "url": "https://" + slug + ".nanana.lat", "dashboardUrl": "d"}, "token": "nnt_new", "dashboardUrlWithToken": "dt"})
			return
		}
		wj(w, 200, map[string]interface{}{"subdomains": []map[string]interface{}{{"slug": "aaa", "url": "https://aaa.nanana.lat", "state": "active", "tunnelOnline": true, "hardExpiresAt": "2030-01-01T00:00:00Z"}}})
	})
	mux.HandleFunc("/subdomains/_self", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer nnt_tok" {
			wj(w, 401, map[string]interface{}{"error": map[string]string{"code": "unauthorized"}})
			return
		}
		wj(w, 200, map[string]string{"slug": "selfslug", "url": "https://selfslug.nanana.lat"})
	})
	mux.HandleFunc("/subdomains/selfslug/claim", func(w http.ResponseWriter, r *http.Request) {
		var in map[string]string
		_ = json.NewDecoder(r.Body).Decode(&in)
		if r.Header.Get("Authorization") != "Bearer nna_secret" || in["token"] != "nnt_tok" {
			wj(w, 403, map[string]interface{}{"error": map[string]string{"code": "forbidden"}})
			return
		}
		wj(w, 200, map[string]string{"slug": "selfslug", "url": "https://selfslug.nanana.lat"})
	})
	mux.HandleFunc("/subdomains/gone", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &polls
}

func TestLoginWhoamiListCreateDeleteLogout(t *testing.T) {
	srv, polls := fakeAPI(t)
	a, out, _ := testApp(t)
	var slept []time.Duration
	sleep = func(d time.Duration) { slept = append(slept, d) }
	defer func() { sleep = time.Sleep }()
	var opened string
	a.openBrowser = func(u string) error { opened = u; return nil }
	run := func(args ...string) int {
		out.Reset()
		return a.execute(context.Background(), append([]string{"--api", srv.URL}, args...))
	}

	if code := run("login"); code != 0 {
		t.Fatalf("login %d: %s", code, out)
	}
	if opened != "https://nanana.lat/device?code=ABCD-EFGH" || !strings.Contains(out.String(), "ABCD-EFGH") {
		t.Fatalf("opened=%q out=%s", opened, out)
	}
	if polls.Load() != 3 || len(slept) != 3 || slept[0] != time.Second || slept[2] != 6*time.Second {
		t.Fatalf("polls=%d slept=%v (slow_down must add 5s)", polls.Load(), slept)
	}
	c, err := config.Load()
	if err != nil || c.Token != "nna_secret" || c.API != srv.URL {
		t.Fatalf("%+v %v", c, err)
	}

	if run("whoami") != 0 || !strings.Contains(out.String(), "me@x.io") || !strings.Contains(out.String(), "maxActiveSubdomains: 3") {
		t.Fatal(out.String())
	}
	if run("list") != 0 || !strings.Contains(out.String(), "aaa") || !strings.Contains(out.String(), "online") {
		t.Fatal(out.String())
	}
	if run("create", "mine") != 0 || !strings.Contains(out.String(), "nnt_new") || !strings.Contains(out.String(), "mine") {
		t.Fatal(out.String())
	}
	// delete without --yes and without confirming: aborted, no request
	if run("delete", "gone") != 0 || !strings.Contains(out.String(), "Aborted") {
		t.Fatal(out.String())
	}
	a.in = strings.NewReader("y\n")
	if run("delete", "gone") != 0 || !strings.Contains(out.String(), "Deleted gone") {
		t.Fatal(out.String())
	}
	if run("delete", "gone", "--yes") != 0 || !strings.Contains(out.String(), "Deleted gone") {
		t.Fatal(out.String())
	}
	if run("claim", "-t", "nnt_tok") != 0 || !strings.Contains(out.String(), "Claimed selfslug") {
		t.Fatal(out.String())
	}
	if run("claim", "-t", "nnt_tok", "--slug", "selfslug") != 0 {
		t.Fatal(out.String())
	}
	if run("logout") != 0 {
		t.Fatal(out.String())
	}
	if _, err := config.Load(); err != config.ErrNoCredentials {
		t.Fatal("credentials should be gone")
	}
	if run("whoami") == 0 {
		t.Fatal("whoami must fail when logged out")
	}
}

func TestResolveTunnelAuth(t *testing.T) {
	srv, _ := fakeAPI(t)
	a, _, _ := testApp(t)
	ctx := context.Background()

	// only an nnt_ token: slug comes from /subdomains/_self
	tok, slug, err := a.resolveTunnelAuth(ctx, &tunnelOpts{Token: "nnt_tok"}, srv.URL)
	if err != nil || tok != "nnt_tok" || slug != "selfslug" {
		t.Fatalf("%v %v %v", tok, slug, err)
	}
	// explicit slug skips the lookup
	_, slug, _ = a.resolveTunnelAuth(ctx, &tunnelOpts{Token: "nnt_zzz", Sub: "given"}, srv.URL)
	if slug != "given" {
		t.Fatal(slug)
	}
	t.Setenv("NANANA_SUB", "fromenv")
	_, slug, _ = a.resolveTunnelAuth(ctx, &tunnelOpts{Token: "nnt_zzz"}, srv.URL)
	if slug != "fromenv" {
		t.Fatal(slug)
	}
	t.Setenv("NANANA_SUB", "")
	// positional slug wins; account token requires a slug
	_, slug, _ = a.resolveTunnelAuth(ctx, &tunnelOpts{Token: "nna_x", slugArg: "pos"}, srv.URL)
	if slug != "pos" {
		t.Fatal(slug)
	}
	if _, _, err := a.resolveTunnelAuth(ctx, &tunnelOpts{Token: "nna_x"}, srv.URL); err == nil {
		t.Fatal("nna_ without slug must fail")
	}
	// no token anywhere
	if _, _, err := a.resolveTunnelAuth(ctx, &tunnelOpts{}, srv.URL); err == nil {
		t.Fatal("no token must fail")
	}
	// credentials file is used when no flag/env
	_ = config.Save(&config.Credentials{Token: "nna_file", API: srv.URL})
	tok, _, err = a.resolveTunnelAuth(ctx, &tunnelOpts{slugArg: "s"}, srv.URL)
	if err != nil || tok != "nna_file" {
		t.Fatal(tok, err)
	}
	// bad nnt_ token: lookup fails with a helpful message
	if _, _, err := a.resolveTunnelAuth(ctx, &tunnelOpts{Token: "nnt_bad"}, srv.URL); err == nil {
		t.Fatal("expected lookup error")
	}
}

func TestUpdateCheckToleratesFailure(t *testing.T) {
	a, out, errb := testApp(t)
	old := updateCheckURL
	defer func() { updateCheckURL = old }()

	updateCheckURL = "http://127.0.0.1:1/nope"
	if code := a.execute(context.Background(), []string{"update-check"}); code != 0 || !strings.Contains(errb.String(), "could not check") {
		t.Fatalf("%d %s", code, errb)
	}
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v1.2.0","html_url":"https://example/rel"}`))
	}))
	defer gh.Close()
	updateCheckURL = gh.URL
	if code := a.execute(context.Background(), []string{"update-check"}); code != 0 || !strings.Contains(out.String(), "v1.2.0") {
		t.Fatalf("%d %s", code, out)
	}
}

func TestNewer(t *testing.T) {
	cases := []struct {
		l, c string
		want bool
	}{{"v1.2.0", "1.1.9", true}, {"v1.0.0", "1.0.0", false}, {"1.0.0", "dev", false}, {"v2", "1.9.9", true}, {"1.0.0", "1.0.1", false}}
	for _, c := range cases {
		if newer(c.l, c.c) != c.want {
			t.Fatalf("%+v", c)
		}
	}
}

func TestVersionCommand(t *testing.T) {
	a, out, _ := testApp(t)
	a.execute(context.Background(), []string{"version"})
	if !strings.HasPrefix(out.String(), "nanana 1.0.0") {
		t.Fatal(out.String())
	}
}

// End to end: root shorthand -> _self lookup -> websocket -> proxy -> JSON tail -> bye replaced (exit 2).
func TestEndToEndShorthand(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(204)
	}))
	defer stub.Close()
	hostPort := strings.TrimPrefix(stub.URL, "http://")
	idx := strings.LastIndex(hostPort, ":")
	host, port := hostPort[:idx], hostPort[idx+1:]

	up := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/subdomains/_self", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"slug":"abc"}`))
	})
	mux.HandleFunc("/tunnel", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("sub") != "abc" {
			http.Error(w, "x", 404)
			return
		}
		ws, _ := up.Upgrade(w, r, nil)
		_ = ws.WriteJSON(map[string]interface{}{"t": "hello", "protocol": 1, "sub": "abc", "url": "https://abc.nanana.lat", "dashboard": "https://abc.tools.nanana.lat"})
		_ = ws.WriteJSON(map[string]interface{}{"t": "req", "id": "11111111-2222-3333-4444-555555555555", "method": "GET", "path": "/hook", "bodyLen": 0, "replay": true})
		for {
			var m map[string]interface{}
			if err := ws.ReadJSON(&m); err != nil {
				return
			}
			if m["t"] == "res" {
				_ = ws.WriteJSON(map[string]string{"t": "bye", "reason": "replaced"})
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	a, out, errb := testApp(t)
	code := a.execute(context.Background(), []string{"--api", srv.URL, "-t=nnt_tok2", "-p=" + port, "-h=" + host, "--json"})
	// the fake _self requires nothing, so the lookup succeeds for any token
	if code != 2 {
		t.Fatalf("exit %d want 2; err=%s out=%s", code, errb, out)
	}
	if !strings.Contains(errb.String(), "replaced") {
		t.Fatalf("stderr: %s", errb)
	}
	var sawReq, sawConn bool
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]interface{}
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("non-JSON line %q", line)
		}
		switch m["event"] {
		case "connected":
			sawConn = m["url"] == "https://abc.nanana.lat"
		case "request":
			sawReq = m["status"] == float64(204) && m["replay"] == true && m["path"] == "/hook"
		}
	}
	if !sawReq || !sawConn {
		t.Fatalf("out: %s", out)
	}
}

func TestTailTextFormat(t *testing.T) {
	var buf bytes.Buffer
	t.Setenv("NO_COLOR", "1")
	p := newPrinter(&buf, &buf, false, false, "http://127.0.0.1:3000")
	if p.color {
		t.Fatal("NO_COLOR must disable color")
	}
	tm := time.Date(2026, 1, 2, 15, 4, 5, 0, time.Local)
	p.Request(tunnelEvent(tm, "POST", "/pay", 200, 12*time.Millisecond, true, ""))
	p.Request(tunnelEvent(tm, "GET", "/x", 0, 3*time.Millisecond, false, "ECONNREFUSED"))
	got := buf.String()
	if !strings.HasPrefix(got, "15:04:05 POST    /pay 200 12ms [replay]\n") || !strings.Contains(got, "ERR") || strings.Contains(got, "\x1b[") {
		t.Fatalf("%q", got)
	}
}

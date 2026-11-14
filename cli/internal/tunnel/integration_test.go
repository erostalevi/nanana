package tunnel

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const reqID = "11111111-2222-3333-4444-555555555555"

// ---- fake tunnel server (API.md protocol) ----

type fakeConn struct {
	ws     *websocket.Conn
	in     chan frame
	hdr    http.Header
	query  string
	closed chan struct{}
	mu     sync.Mutex
}

type frame struct {
	typ  int
	data []byte
}

type fakeServer struct {
	srv      *httptest.Server
	conns    chan *fakeConn
	failCode int // when set, reject upgrade with this HTTP status
}

func newFakeServer(t *testing.T) *fakeServer {
	f := &fakeServer{conns: make(chan *fakeConn, 10)}
	up := websocket.Upgrader{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/tunnel" {
			http.NotFound(w, r)
			return
		}
		if f.failCode != 0 {
			http.Error(w, `{"error":{"code":"x","message":"y"}}`, f.failCode)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		c := &fakeConn{ws: ws, in: make(chan frame, 256), hdr: r.Header, query: r.URL.RawQuery, closed: make(chan struct{})}
		go func() {
			defer close(c.closed)
			for {
				typ, data, err := ws.ReadMessage()
				if err != nil {
					close(c.in)
					return
				}
				c.in <- frame{typ, data}
			}
		}()
		c.sendJSON(map[string]interface{}{"t": "hello", "protocol": 1, "sub": "abc", "url": "https://abc.nanana.lat", "dashboard": "https://abc.tools.nanana.lat"})
		f.conns <- c
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) base() string { return f.srv.URL }

func (f *fakeServer) accept(t *testing.T) *fakeConn {
	t.Helper()
	select {
	case c := <-f.conns:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("no tunnel connection")
		return nil
	}
}

func (c *fakeConn) sendJSON(v interface{}) {
	b, _ := json.Marshal(v)
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.ws.WriteMessage(websocket.TextMessage, b)
}

func (c *fakeConn) sendReq(id, method, path string, headers map[string]interface{}, body []byte, replay bool) {
	c.sendJSON(map[string]interface{}{"t": "req", "id": id, "method": method, "path": path, "headers": headers, "bodyLen": len(body), "replay": replay})
	uid, _ := ParseUUID(id)
	for off := 0; off < len(body); off += ChunkSize {
		end := off + ChunkSize
		if end > len(body) {
			end = len(body)
		}
		c.mu.Lock()
		_ = c.ws.WriteMessage(websocket.BinaryMessage, EncodeBinary(uid, body[off:end]))
		c.mu.Unlock()
	}
}

type reply struct {
	msg    Message
	body   []byte
	frames int
	maxChk int
}

// await reads until a res/err for id arrives (and its whole body).
func (c *fakeConn) await(t *testing.T, id string) reply {
	t.Helper()
	var r reply
	uid, _ := ParseUUID(id)
	timeout := time.After(10 * time.Second)
	for {
		select {
		case fr, ok := <-c.in:
			if !ok {
				t.Fatal("connection closed while waiting")
			}
			if fr.typ == websocket.TextMessage {
				var m Message
				_ = json.Unmarshal(fr.data, &m)
				if m.T == "pong" {
					continue
				}
				if m.ID != id {
					continue
				}
				r.msg = m
				if m.T == "err" || m.BodyLen == 0 {
					return r
				}
			} else {
				gid, chunk, _ := DecodeBinary(fr.data)
				if gid != uid {
					continue
				}
				r.body = append(r.body, chunk...)
				r.frames++
				if len(chunk) > r.maxChk {
					r.maxChk = len(chunk)
				}
				if len(r.body) >= r.msg.BodyLen {
					return r
				}
			}
		case <-timeout:
			t.Fatal("timeout awaiting response")
		}
	}
}

// ---- helpers ----

func stubTarget(t *testing.T, h http.HandlerFunc) (Target, *httptest.Server) {
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(s.URL, "http://"))
	return Target{Scheme: "http", Host: host, Port: port}, s
}

type runner struct {
	cancel context.CancelFunc
	done   chan error
	mu     sync.Mutex
	events []Event
	discos int
}

func startClient(t *testing.T, f *fakeServer, tgt Target, mod func(*Config)) *runner {
	r := &runner{done: make(chan error, 1)}
	cfg := Config{
		APIBase: f.base(), Token: "nnt_test", Sub: "abc", Target: tgt, ClientVersion: "9.9.9",
		BackoffMin: 20 * time.Millisecond, BackoffMax: 50 * time.Millisecond,
		Hooks: Hooks{
			Request:      func(e Event) { r.mu.Lock(); r.events = append(r.events, e); r.mu.Unlock() },
			Disconnected: func(error, time.Duration) { r.mu.Lock(); r.discos++; r.mu.Unlock() },
		},
	}
	if mod != nil {
		mod(&cfg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	go func() { r.done <- New(cfg).Run(ctx) }()
	t.Cleanup(cancel)
	return r
}

func (r *runner) stop(t *testing.T) {
	t.Helper()
	r.cancel()
	select {
	case err := <-r.done:
		if err != nil {
			t.Fatalf("Run after cancel: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}

func (r *runner) lastEvent() Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.events[len(r.events)-1]
}

// ---- tests ----

func TestProxyPostMultiValueHeaders(t *testing.T) {
	var gotHost, gotBody, gotMethod, gotURI string
	var gotMulti []string
	var gotXFF string
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody, gotHost, gotMethod, gotURI = string(b), r.Host, r.Method, r.RequestURI
		gotMulti = r.Header.Values("X-Multi")
		gotXFF = r.Header.Get("X-Forwarded-For")
		w.Header().Add("Set-Cookie", "a=1")
		w.Header().Add("Set-Cookie", "b=2")
		w.Header().Set("X-Custom", "yes")
		w.WriteHeader(201)
		_, _ = w.Write([]byte("created"))
	})
	f := newFakeServer(t)
	r := startClient(t, f, tgt, nil)
	c := f.accept(t)
	if c.hdr.Get("Authorization") != "Bearer nnt_test" || c.hdr.Get("X-Nanana-Protocol") != "1" ||
		c.hdr.Get("X-Nanana-Client") != "nanana-cli/9.9.9" || c.query != "sub=abc" {
		t.Fatalf("bad upgrade request: %v %q", c.hdr, c.query)
	}
	c.sendReq(reqID, "POST", "/pay?x=1&y=a%20b", map[string]interface{}{
		"x-multi": []string{"one", "two"}, "x-forwarded-for": "1.2.3.4", "content-type": "text/plain",
		"host": "abc.nanana.lat", "connection": "keep-alive",
	}, []byte("payload"), false)
	rep := c.await(t, reqID)
	if rep.msg.T != "res" || rep.msg.Status != 201 || string(rep.body) != "created" {
		t.Fatalf("%+v", rep)
	}
	if len(rep.msg.Headers["set-cookie"]) != 2 || rep.msg.Headers.Get("x-custom") != "yes" {
		t.Fatalf("headers %v", rep.msg.Headers)
	}
	if gotBody != "payload" || gotMethod != "POST" || gotURI != "/pay?x=1&y=a%20b" {
		t.Fatalf("%q %q %q", gotBody, gotMethod, gotURI)
	}
	if gotHost != tgt.HostPort() {
		t.Fatalf("Host %q want %q", gotHost, tgt.HostPort())
	}
	if len(gotMulti) != 2 || gotMulti[0] != "one" || gotMulti[1] != "two" || gotXFF != "1.2.3.4" {
		t.Fatalf("multi=%v xff=%q", gotMulti, gotXFF)
	}
	ev := r.lastEvent()
	if ev.Status != 201 || ev.Replay || ev.Method != "POST" {
		t.Fatalf("%+v", ev)
	}
	r.stop(t)
}

func TestPreserveHost(t *testing.T) {
	var gotHost string
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) { gotHost = r.Host })
	f := newFakeServer(t)
	startClient(t, f, tgt, func(c *Config) { c.PreserveHost = true })
	c := f.accept(t)
	c.sendReq(reqID, "GET", "/", map[string]interface{}{"host": "abc.nanana.lat"}, nil, false)
	c.await(t, reqID)
	if gotHost != "abc.nanana.lat" {
		t.Fatalf("host %q", gotHost)
	}
}

func TestConnRefusedSendsErr(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	_, port, _ := net.SplitHostPort(l.Addr().String())
	l.Close()
	f := newFakeServer(t)
	r := startClient(t, f, Target{"http", "127.0.0.1", port}, nil)
	c := f.accept(t)
	c.sendReq(reqID, "GET", "/x", nil, nil, false)
	rep := c.await(t, reqID)
	if rep.msg.T != "err" || rep.msg.Code != "ECONNREFUSED" || rep.msg.Msg == "" {
		t.Fatalf("%+v", rep.msg)
	}
	time.Sleep(50 * time.Millisecond)
	if ev := r.lastEvent(); ev.ErrCode != "ECONNREFUSED" || ev.Status != 0 {
		t.Fatalf("%+v", ev)
	}
}

func TestTimeoutSendsETIMEDOUT(t *testing.T) {
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) { time.Sleep(600 * time.Millisecond) })
	f := newFakeServer(t)
	startClient(t, f, tgt, func(c *Config) { c.RequestTimeout = 100 * time.Millisecond })
	c := f.accept(t)
	c.sendReq(reqID, "GET", "/", nil, nil, false)
	if rep := c.await(t, reqID); rep.msg.Code != "ETIMEDOUT" {
		t.Fatalf("%+v", rep.msg)
	}
}

func TestReplayTagAndNoRedirectFollow(t *testing.T) {
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/elsewhere", 302)
	})
	f := newFakeServer(t)
	r := startClient(t, f, tgt, nil)
	c := f.accept(t)
	c.sendReq(reqID, "GET", "/r", nil, nil, true)
	rep := c.await(t, reqID)
	if rep.msg.Status != 302 || rep.msg.Headers.Get("location") != "/elsewhere" {
		t.Fatalf("redirect must be passed through: %+v", rep.msg)
	}
	time.Sleep(50 * time.Millisecond)
	if ev := r.lastEvent(); !ev.Replay {
		t.Fatal("replay flag lost")
	}
}

func TestPingPong(t *testing.T) {
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) {})
	f := newFakeServer(t)
	startClient(t, f, tgt, nil)
	c := f.accept(t)
	c.sendJSON(map[string]string{"t": "ping"})
	select {
	case fr := <-c.in:
		var m Message
		_ = json.Unmarshal(fr.data, &m)
		if m.T != "pong" {
			t.Fatalf("got %s", fr.data)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no pong")
	}
}

func TestReconnectAfterDrop(t *testing.T) {
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) })
	f := newFakeServer(t)
	r := startClient(t, f, tgt, nil)
	c1 := f.accept(t)
	c1.ws.Close()
	c2 := f.accept(t) // must reconnect
	c2.sendReq(reqID, "GET", "/", nil, nil, false)
	if rep := c2.await(t, reqID); rep.msg.Status != 200 {
		t.Fatalf("%+v", rep.msg)
	}
	r.mu.Lock()
	d := r.discos
	r.mu.Unlock()
	if d < 1 {
		t.Fatal("Disconnected hook not called")
	}
	r.stop(t)
}

func TestByeReplacedNoReconnect(t *testing.T) {
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) {})
	f := newFakeServer(t)
	r := startClient(t, f, tgt, nil)
	c := f.accept(t)
	c.sendJSON(map[string]string{"t": "bye", "reason": "replaced"})
	select {
	case err := <-r.done:
		ee, ok := err.(*ExitError)
		if !ok || ee.Code != 2 {
			t.Fatalf("want exit code 2, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not exit")
	}
	select {
	case <-f.conns:
		t.Fatal("must not reconnect after replaced")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestByeServerShutdownReconnects(t *testing.T) {
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) {})
	f := newFakeServer(t)
	r := startClient(t, f, tgt, nil)
	c := f.accept(t)
	c.sendJSON(map[string]string{"t": "bye", "reason": "server_shutdown"})
	f.accept(t) // server_shutdown must reconnect
	r.stop(t)
}

func TestByeDeletedExits(t *testing.T) {
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) {})
	f := newFakeServer(t)
	r := startClient(t, f, tgt, nil)
	c := f.accept(t)
	c.sendJSON(map[string]string{"t": "bye", "reason": "deleted"})
	err := <-r.done
	if ee, ok := err.(*ExitError); !ok || ee.Code != 1 {
		t.Fatalf("%v", err)
	}
}

func TestHandshakeErrorsAreFatal(t *testing.T) {
	for status, want := range map[int]string{401: "unauthorized", 403: "forbidden", 404: "not found", 426: "upgrade required"} {
		f := newFakeServer(t)
		f.failCode = status
		tgt := Target{"http", "127.0.0.1", "1"}
		r := startClient(t, f, tgt, nil)
		select {
		case err := <-r.done:
			ee, ok := err.(*ExitError)
			if !ok || !strings.Contains(ee.Msg, want) {
				t.Fatalf("status %d: %v", status, err)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("status %d: Run did not exit", status)
		}
	}
}

func TestBigBodyChunking(t *testing.T) {
	big := bytes.Repeat([]byte("0123456789abcdef"), 16*1024*3/2+5) // ~393 KiB
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if !bytes.Equal(b, big) {
			w.WriteHeader(400)
			return
		}
		_, _ = w.Write(b)
	})
	f := newFakeServer(t)
	startClient(t, f, tgt, nil)
	c := f.accept(t)
	c.sendReq(reqID, "POST", "/big", map[string]interface{}{"content-type": "application/octet-stream"}, big, false)
	rep := c.await(t, reqID)
	if rep.msg.Status != 200 || !bytes.Equal(rep.body, big) {
		t.Fatalf("status %d len %d/%d", rep.msg.Status, len(rep.body), len(big))
	}
	if rep.maxChk > ChunkSize || rep.frames < len(big)/ChunkSize {
		t.Fatalf("chunking: frames=%d max=%d", rep.frames, rep.maxChk)
	}
}

func TestOversizeResponseIsErr(t *testing.T) {
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) {
		chunk := make([]byte, 1<<20)
		for i := 0; i < 11; i++ {
			_, _ = w.Write(chunk)
		}
	})
	f := newFakeServer(t)
	startClient(t, f, tgt, nil)
	c := f.accept(t)
	c.sendReq(reqID, "GET", "/huge", nil, nil, false)
	rep := c.await(t, reqID)
	if rep.msg.T != "err" || rep.msg.Code != "EOTHER" {
		t.Fatalf("%+v", rep.msg)
	}
}

func TestConcurrentRequests(t *testing.T) {
	tgt, _ := stubTarget(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(50 * time.Millisecond)
		_, _ = w.Write([]byte(r.URL.Path))
	})
	f := newFakeServer(t)
	startClient(t, f, tgt, nil)
	c := f.accept(t)
	ids := []string{
		"00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002",
		"00000000-0000-0000-0000-000000000003",
	}
	for i, id := range ids {
		c.sendReq(id, "GET", "/p"+string(rune('1'+i)), nil, nil, false)
	}
	got := map[string]string{}
	deadline := time.After(5 * time.Second)
	for len(got) < 3 {
		select {
		case fr := <-c.in:
			if fr.typ == websocket.BinaryMessage {
				id, chunk, _ := DecodeBinary(fr.data)
				got[FormatUUID(id)] = string(chunk)
			}
		case <-deadline:
			t.Fatalf("got %v", got)
		}
	}
	for i, id := range ids {
		if got[id] != "/p"+string(rune('1'+i)) {
			t.Fatalf("mismatch %v", got)
		}
	}
}

func TestWSURL(t *testing.T) {
	u, _ := WSURL("https://api.nanana.lat/", "abc")
	if u != "wss://api.nanana.lat/tunnel?sub=abc" {
		t.Fatal(u)
	}
	u, _ = WSURL("http://localhost:3001", "a b")
	if u != "ws://localhost:3001/tunnel?sub=a+b" {
		t.Fatal(u)
	}
	if _, err := WSURL("ftp://x", "a"); err == nil {
		t.Fatal("bad scheme")
	}
}

func TestBackoffBounds(t *testing.T) {
	for i := 0; i < 20; i++ {
		d := backoff(i, time.Second, 30*time.Second)
		if d < 750*time.Millisecond || d > 30*time.Second {
			t.Fatalf("attempt %d: %v", i, d)
		}
	}
}

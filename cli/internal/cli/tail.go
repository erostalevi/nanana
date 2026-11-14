package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/erostalevi/nanana/cli/internal/tunnel"
)

type printer struct {
	mu     sync.Mutex
	out    io.Writer
	errOut io.Writer
	color  bool
	json   bool
	noTail bool
	target string
}

func newPrinter(out, errOut io.Writer, jsonMode, noTail bool, target string) *printer {
	return &printer{out: out, errOut: errOut, color: useColor(out), json: jsonMode, noTail: noTail, target: target}
}

func useColor(w io.Writer) bool {
	if _, ok := os.LookupEnv("NO_COLOR"); ok {
		return false
	}
	if os.Getenv("TERM") == "dumb" {
		return false
	}
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

func (p *printer) paint(code, s string) string {
	if !p.color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (p *printer) jsonLine(v map[string]interface{}) {
	b, _ := json.Marshal(v)
	fmt.Fprintln(p.out, string(b))
}

func (p *printer) Connected(h tunnel.Message, first bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.json {
		p.jsonLine(map[string]interface{}{"event": "connected", "time": time.Now().UTC().Format(time.RFC3339), "url": h.URL, "dashboard": h.Dashboard, "target": p.target, "reconnect": !first})
		return
	}
	if !first {
		fmt.Fprintf(p.out, "%s reconnected\n", p.paint("32", "*"))
		return
	}
	fmt.Fprintf(p.out, "%s\n", p.paint("1", "nanana tunnel online"))
	fmt.Fprintf(p.out, "  Public URL   %s\n", h.URL)
	fmt.Fprintf(p.out, "  Dashboard    %s\n", h.Dashboard)
	fmt.Fprintf(p.out, "  Forwarding   %s -> %s\n", h.URL, p.target)
	fmt.Fprintf(p.out, "\nCtrl+C to stop\n\n")
}

func (p *printer) Disconnected(err error, retry time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	msg := "disconnected"
	if err != nil {
		msg = err.Error()
	}
	if p.json {
		p.jsonLine(map[string]interface{}{"event": "disconnected", "time": time.Now().UTC().Format(time.RFC3339), "error": msg, "retryInMs": retry.Milliseconds()})
		return
	}
	fmt.Fprintf(p.out, "%s %s; retrying in %s\n", p.paint("33", "!"), msg, retry.Round(100*time.Millisecond))
}

func (p *printer) Request(e tunnel.Event) {
	if p.noTail {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.json {
		m := map[string]interface{}{
			"event": "request", "time": e.Time.UTC().Format(time.RFC3339Nano), "id": e.ID,
			"method": e.Method, "path": e.Path, "latencyMs": e.Latency.Milliseconds(), "replay": e.Replay,
		}
		if e.ErrCode != "" {
			m["error"] = e.ErrCode
			m["message"] = e.ErrMsg
		} else {
			m["status"] = e.Status
		}
		p.jsonLine(m)
		return
	}
	status, code := fmt.Sprintf("%d", e.Status), "32"
	switch {
	case e.ErrCode != "":
		status, code = "ERR", "31"
	case e.Status >= 500:
		code = "31"
	case e.Status >= 400:
		code = "33"
	case e.Status >= 300:
		code = "36"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s %-7s %s %s %s", e.Time.Format("15:04:05"), e.Method, e.Path, p.paint(code, status), fmtLatency(e.Latency))
	if e.Replay {
		b.WriteString(" " + p.paint("35", "[replay]"))
	}
	if e.ErrCode != "" {
		b.WriteString("  " + p.paint("31", e.ErrCode+": "+hint(e, p.target)))
	}
	fmt.Fprintln(p.out, b.String())
}

func hint(e tunnel.Event, target string) string {
	if e.ErrCode == "ECONNREFUSED" {
		return "nothing is listening on " + target
	}
	return e.ErrMsg
}

func fmtLatency(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	return fmt.Sprintf("%.2fs", d.Seconds())
}

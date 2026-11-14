package cli

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/erostalevi/nanana/cli/internal/api"
	"github.com/erostalevi/nanana/cli/internal/config"
	"github.com/erostalevi/nanana/cli/internal/tunnel"
)

// target validates the forwarding flags.
func (o *tunnelOpts) target() (tunnel.Target, error) {
	if o.URL != "" {
		u, err := url.Parse(o.URL)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return tunnel.Target{}, fmt.Errorf("--url must look like http://host:port, got %q", o.URL)
		}
		port := u.Port()
		if port == "" {
			port = map[string]string{"http": "80", "https": "443"}[u.Scheme]
		}
		return tunnel.Target{Scheme: u.Scheme, Host: u.Hostname(), Port: port}, nil
	}
	if o.Port == 0 {
		return tunnel.Target{}, errors.New("a port is required: use -p <port> (or --url http://host:port)")
	}
	if o.Port < 1 || o.Port > 65535 {
		return tunnel.Target{}, fmt.Errorf("invalid port %d", o.Port)
	}
	if o.Scheme != "http" && o.Scheme != "https" {
		return tunnel.Target{}, fmt.Errorf("--scheme must be http or https, got %q", o.Scheme)
	}
	host := strings.Trim(o.Host, "[]")
	if host == "" {
		host = "127.0.0.1"
	}
	return tunnel.Target{Scheme: o.Scheme, Host: host, Port: strconv.Itoa(o.Port)}, nil
}

// resolveTunnelAuth returns the token and slug to use for the tunnel.
func (a *app) resolveTunnelAuth(ctx context.Context, o *tunnelOpts, apiBase string) (token, slug string, err error) {
	token, _ = config.Token(o.Token, apiBase)
	if token == "" {
		return "", "", errors.New("no token: run `nanana login`, set NANANA_TOKEN, or pass -t <token>")
	}
	slug = firstNonEmpty(o.slugArg, o.Sub, os.Getenv("NANANA_SUB"))
	if slug != "" {
		return token, slug, nil
	}
	if strings.HasPrefix(token, "nna_") {
		return "", "", errors.New("an account token needs a subdomain: nanana tunnel <slug> -p <port> (see `nanana list`)")
	}
	self, err := api.New(apiBase, token, a.version).Self(ctx)
	if err != nil {
		return "", "", fmt.Errorf("could not determine the subdomain for this token (pass --sub <slug>): %w", err)
	}
	return token, self.Slug, nil
}

func (a *app) runTunnelReal(ctx context.Context, o *tunnelOpts) error {
	target, err := o.target()
	if err != nil {
		return err
	}
	apiBase := config.APIBase(a.api)
	token, slug, err := a.resolveTunnelAuth(ctx, o, apiBase)
	if err != nil {
		return err
	}
	p := newPrinter(a.out, a.errOut, o.JSON, o.NoTail, target.String())
	first := true
	cl := tunnel.New(tunnel.Config{
		APIBase: apiBase, Token: token, Sub: slug, Target: target,
		PreserveHost: o.PreserveHost, Insecure: o.Insecure, ClientVersion: a.version,
		Hooks: tunnel.Hooks{
			Connected:    func(h tunnel.Message) { p.Connected(h, first); first = false },
			Disconnected: p.Disconnected,
			Request:      p.Request,
		},
	})
	if err := cl.Run(ctx); err != nil {
		return err
	}
	if !o.JSON {
		fmt.Fprintln(a.out, "\ntunnel closed")
	}
	return nil
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

// friendly rewrites API/network errors into actionable text.
func friendly(err error) string {
	var ae *api.Error
	if errors.As(err, &ae) {
		switch ae.Status {
		case 401:
			return "not authorized: the token is missing, invalid or revoked (run `nanana login`)"
		case 403:
			return "forbidden: " + firstNonEmpty(ae.Message, "this token cannot do that")
		case 404:
			return "not found: " + firstNonEmpty(ae.Message, "no such subdomain")
		case 426:
			return "this nanana CLI is too old for the server; run `nanana update-check`"
		case 429:
			return "rate limited: try again shortly"
		}
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return "cannot reach the nanana API (" + err.Error() + "); check your network or --api"
	}
	return err.Error()
}

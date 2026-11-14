// Package cli wires the cobra commands.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/erostalevi/nanana/cli/internal/tunnel"
)

// tunnelOpts are the parsed `tunnel` flags (also used by the root shorthand).
type tunnelOpts struct {
	Token        string
	Sub          string
	Port         int
	Host         string
	Scheme       string
	URL          string
	PreserveHost bool
	NoTail       bool
	JSON         bool
	Insecure     bool
	slugArg      string
}

type app struct {
	version string
	api     string // --api flag
	out     io.Writer
	errOut  io.Writer
	in      io.Reader

	// seams for tests
	runTunnel   func(ctx context.Context, o *tunnelOpts) error
	openBrowser func(url string) error
}

func newApp(version string) *app {
	a := &app{version: version, out: os.Stdout, errOut: os.Stderr, in: os.Stdin, openBrowser: openBrowser}
	a.runTunnel = a.runTunnelReal
	return a
}

// Execute runs the CLI and returns the process exit code.
func Execute(version string, args []string) int {
	a := newApp(version)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return a.execute(ctx, args)
}

func (a *app) execute(ctx context.Context, args []string) int {
	root := a.newRoot()
	root.SetArgs(args)
	if err := root.ExecuteContext(ctx); err != nil {
		var ee *tunnel.ExitError
		code := 1
		if errors.As(err, &ee) {
			code = ee.Code
		}
		fmt.Fprintln(a.errOut, "Error:", friendly(err))
		return code
	}
	return 0
}

func addTunnelFlags(f *pflag.FlagSet, o *tunnelOpts) {
	f.StringVarP(&o.Token, "token", "t", "", "subdomain (nnt_) or account (nna_) token [env NANANA_TOKEN]")
	f.IntVarP(&o.Port, "port", "p", 0, "local port to forward to")
	f.StringVarP(&o.Host, "host", "h", "127.0.0.1", "local host to forward to")
	f.StringVar(&o.Scheme, "scheme", "http", "local scheme: http or https")
	f.StringVar(&o.URL, "url", "", "forward target as a URL, e.g. http://localhost:3000 (replaces -h/-p/--scheme)")
	f.StringVar(&o.Sub, "sub", "", "subdomain slug [env NANANA_SUB]")
	f.BoolVar(&o.PreserveHost, "preserve-host", false, "keep the original Host header instead of rewriting it to the target")
	f.BoolVar(&o.NoTail, "no-tail", false, "do not print one line per proxied request")
	f.BoolVar(&o.JSON, "json", false, "machine-readable output: one JSON object per line")
	f.BoolVar(&o.Insecure, "insecure", false, "skip TLS verification of an https target (self-signed dev certs)")
}

func (a *app) newRoot() *cobra.Command {
	rootOpts := &tunnelOpts{}
	root := &cobra.Command{
		Use:   "nanana",
		Short: "nanana.lat webhook inspector and tunnel",
		Long: `nanana forwards webhooks sent to <slug>.nanana.lat to a service on your machine.

Shorthand:  nanana -t=<token> -p=<port> [-h=<host>]   (same as 'nanana tunnel')`,
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       a.version,
		Args:          cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			f := cmd.Flags()
			if !f.Changed("port") && !f.Changed("url") && !f.Changed("token") && !f.Changed("sub") {
				return cmd.Help()
			}
			return a.runTunnel(cmd.Context(), rootOpts)
		},
	}
	root.SetOut(a.out)
	root.SetErr(a.errOut)
	root.PersistentFlags().StringVar(&a.api, "api", "", "API base URL [env NANANA_API] (default https://api.nanana.lat)")
	addTunnelFlags(root.Flags(), rootOpts)

	tOpts := &tunnelOpts{}
	tun := &cobra.Command{
		Use:   "tunnel [slug]",
		Short: "Forward a subdomain to a local port",
		Long: `Forward <slug>.nanana.lat to a local service.

Authentication:
  nanana tunnel <slug> -p 3000            logged in (nanana login), owned subdomain
  nanana tunnel -t nnt_... -p 3000        subdomain token; the slug is looked up with GET /subdomains/_self
  nanana tunnel -t nnt_... --sub k7x2m9qa -p 3000   explicit slug (or NANANA_SUB)`,
		Args:          cobra.MaximumNArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 1 {
				tOpts.slugArg = args[0]
			}
			return a.runTunnel(cmd.Context(), tOpts)
		},
	}
	addTunnelFlags(tun.Flags(), tOpts)

	root.AddCommand(tun, a.loginCmd(), a.logoutCmd(), a.whoamiCmd(), a.listCmd(), a.createCmd(),
		a.deleteCmd(), a.claimCmd(), a.versionCmd(), a.updateCheckCmd())
	root.SetVersionTemplate("nanana {{.Version}}\n")
	disableShortHelp(root)
	return root
}

// disableShortHelp makes --help long-only on every command: -h means --host.
func disableShortHelp(c *cobra.Command) {
	if c.Flags().Lookup("help") == nil {
		c.Flags().Bool("help", false, "help for "+c.Name())
	}
	for _, s := range c.Commands() {
		disableShortHelp(s)
	}
}

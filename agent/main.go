package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gurungsandex/wms-agent/collector"
	"github.com/gurungsandex/wms-agent/config"
	"github.com/gurungsandex/wms-agent/transport"
)

const agentVersion = "1.1.0"

// Optional collectors this build supports. Advertised to the server on
// connect; the server will not request anything absent from this list.
var capabilities = []string{"process", "ports"}

// How many processes to report per sample. Keeps the payload small — a full
// inventory of a busy workstation is mostly idle daemons nobody looks at.
const topProcessCount = 15

// policyStore holds the collector policy last pushed by the server.
// Every collector starts disabled and only runs once the server says so.
type policyStore struct {
	mu       sync.RWMutex
	policies map[string]transport.CollectorPolicy
	lastRun  map[string]time.Time
}

func newPolicyStore() *policyStore {
	return &policyStore{
		policies: map[string]transport.CollectorPolicy{},
		lastRun:  map[string]time.Time{},
	}
}

func (p *policyStore) set(policies map[string]transport.CollectorPolicy) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for name, pol := range policies {
		prev, existed := p.policies[name]
		p.policies[name] = pol
		if !existed || prev.Enabled != pol.Enabled {
			log.Printf("collector %q: enabled=%v interval=%ds", name, pol.Enabled, pol.IntervalSec)
		}
	}
}

// due reports whether a collector is enabled and its interval has elapsed.
func (p *policyStore) due(name string, now time.Time) bool {
	p.mu.RLock()
	pol, ok := p.policies[name]
	last := p.lastRun[name]
	p.mu.RUnlock()

	if !ok || !pol.Enabled {
		return false
	}
	interval := time.Duration(pol.IntervalSec) * time.Second
	if interval < 15*time.Second {
		interval = 15 * time.Second
	}
	return now.Sub(last) >= interval
}

func (p *policyStore) markRun(name string, now time.Time) {
	p.mu.Lock()
	p.lastRun[name] = now
	p.mu.Unlock()
}

type state struct {
	WorkstationID string `json:"workstation_id"`
	AgentToken    string `json:"agent_token"`
}

func loadState(path string) *state {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s state
	if err := json.Unmarshal(b, &s); err != nil {
		return nil
	}
	return &s
}

func saveState(path string, s *state) {
	b, _ := json.Marshal(s)
	_ = os.WriteFile(path, b, 0600)
}

func main() {
	cfg := config.Load()

	// Load persisted state (overrides env vars if present)
	if s := loadState(cfg.StateFile); s != nil {
		if cfg.AgentToken == "" {
			cfg.AgentToken = s.AgentToken
		}
		if cfg.WorkstationID == "" {
			cfg.WorkstationID = s.WorkstationID
		}
	}

	// Enrollment flow
	if cfg.AgentToken == "" {
		if cfg.EnrollToken == "" {
			log.Fatal("No WMS_AGENT_TOKEN and no WMS_ENROLL_TOKEN — cannot start. Run enroll first.")
		}

		hostname, _ := os.Hostname()
		// Derive HTTP base from WS URL
		httpBase := cfg.ServerURL
		if len(httpBase) > 3 && httpBase[:3] == "wss" {
			httpBase = "https" + httpBase[3:]
		} else if len(httpBase) > 2 && httpBase[:2] == "ws" {
			httpBase = "http" + httpBase[2:]
		}
		// Strip /ws/agent suffix
		for _, suffix := range []string{"/ws/agent", "/ws"} {
			if len(httpBase) > len(suffix) && httpBase[len(httpBase)-len(suffix):] == suffix {
				httpBase = httpBase[:len(httpBase)-len(suffix)]
				break
			}
		}

		sys := collector.GatherSystemInfo()
		if sys.Hostname == "" {
			sys.Hostname = hostname
		}

		log.Printf("Enrolling with token %s...", cfg.EnrollToken[:8]+"****")
		resp, err := transport.Enroll(httpBase, transport.EnrollRequest{
			Token:        cfg.EnrollToken,
			Hostname:     sys.Hostname,
			OSName:       sys.OSName,
			OSShort:      sys.OSShort,
			OSFamily:     sys.OSFamily,
			CPUModel:     sys.CPUModel,
			CPUCores:     sys.CPUCores,
			RAMTotalGB:   sys.RAMTotalGB,
			AgentVersion: agentVersion,
		})
		if err != nil {
			log.Fatalf("Enrollment failed: %v", err)
		}

		cfg.AgentToken = resp.AgentToken
		cfg.WorkstationID = resp.WorkstationID
		saveState(cfg.StateFile, &state{
			WorkstationID: cfg.WorkstationID,
			AgentToken:    cfg.AgentToken,
		})
		log.Printf("Enrolled as workstation %s", cfg.WorkstationID)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	client := transport.New(cfg.ServerURL, cfg.AgentToken, cfg.WorkstationID)
	client.SetHello(agentVersion, capabilities)

	policy := newPolicyStore()
	client.OnServerMessage = func(msg transport.ServerMessage) {
		if msg.Type == "policy" && msg.Collectors != nil {
			policy.set(msg.Collectors)
		}
	}

	if err := client.Connect(ctx); err != nil {
		log.Printf("Initial connect failed: %v — will retry", err)
		client.Reconnect(ctx)
	}
	defer client.Close()

	ticker := time.NewTicker(cfg.SendInterval)
	defer ticker.Stop()

	// Optional collectors are checked on a fixed short tick and each runs on
	// its own server-configured interval. 15s matches the policy minimum.
	activityTicker := time.NewTicker(15 * time.Second)
	defer activityTicker.Stop()

	log.Printf("Agent running — sending metrics every %s", cfg.SendInterval)
	log.Printf("Optional collectors available: %v (all off until enabled server-side)", capabilities)

	send := func(payload any) {
		if err := client.Send(payload); err != nil {
			log.Printf("send error: %v — reconnecting", err)
			client.Reconnect(ctx)
			if err2 := client.Send(payload); err2 != nil {
				log.Printf("send retry failed: %v", err2)
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			log.Println("Shutting down agent.")
			return

		case <-ticker.C:
			snap, err := collector.Collect(cfg.WorkstationID)
			if err != nil {
				log.Printf("collect error: %v", err)
				continue
			}
			send(snap)

		case now := <-activityTicker.C:
			if policy.due("process", now) {
				policy.markRun("process", now)
				procs, newly, total := collector.TopProcesses(topProcessCount)
				if len(procs) > 0 {
					send(collector.ProcessPayload{
						Type:      "processes",
						Processes: procs,
						Total:     total,
						New:       newly,
					})
				}
			}

			if policy.due("ports", now) {
				policy.markRun("ports", now)
				ports, opened, closed := collector.ListeningPorts()
				if len(ports) > 0 || len(closed) > 0 {
					send(collector.PortPayload{
						Type:   "ports",
						Ports:  ports,
						Opened: opened,
						Closed: closed,
					})
				}
			}
		}
	}
}

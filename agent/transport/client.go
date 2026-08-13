package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type EnrollRequest struct {
	Token        string  `json:"enrollment_token"`
	Hostname     string  `json:"hostname"`
	OSName       string  `json:"os_name"`
	OSShort      string  `json:"os_short"`
	OSFamily     string  `json:"os_family"`
	CPUModel     string  `json:"cpu_model"`
	CPUCores     int     `json:"cpu_cores"`
	RAMTotalGB   float64 `json:"ram_total_gb"`
	AgentVersion string  `json:"agent_version"`
}

type EnrollResponse struct {
	WorkstationID string `json:"workstation_id"`
	AgentToken    string `json:"agent_token"`
}

// CollectorPolicy is the server's instruction for one optional collector.
type CollectorPolicy struct {
	Enabled     bool `json:"enabled"`
	IntervalSec int  `json:"interval_sec"`
}

// ServerMessage is a frame sent by the server to the agent. Only "policy" is
// acted on today; unknown types are ignored so the server can add more without
// breaking agents already in the field.
type ServerMessage struct {
	Type       string                     `json:"type"`
	Collectors map[string]CollectorPolicy `json:"collectors"`
}

// Hello is the agent's capability advertisement, sent once per connection.
// A server that receives no hello must assume the agent supports nothing
// beyond the original metric stream.
type Hello struct {
	Type         string   `json:"type"`
	AgentVersion string   `json:"agent_version"`
	Capabilities []string `json:"capabilities"`
}

type Client struct {
	serverURL     string
	agentToken    string
	workstationID string
	conn          *websocket.Conn
	mu            sync.Mutex

	// OnServerMessage is invoked for every decoded server frame.
	OnServerMessage func(ServerMessage)
	// hello is re-sent automatically on every (re)connect.
	hello *Hello
}

func New(serverURL, agentToken, workstationID string) *Client {
	return &Client{
		serverURL:     serverURL,
		agentToken:    agentToken,
		workstationID: workstationID,
	}
}

// SetHello records the capability advertisement to send on each connect.
func (c *Client) SetHello(agentVersion string, capabilities []string) {
	c.hello = &Hello{
		Type:         "hello",
		AgentVersion: agentVersion,
		Capabilities: capabilities,
	}
}

// Enroll exchanges a one-time enrollment token for a long-lived agent JWT.
func Enroll(httpBase string, req EnrollRequest) (*EnrollResponse, error) {
	body, _ := json.Marshal(req)
	resp, err := http.Post(httpBase+"/api/enroll/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("enroll: status %d: %s", resp.StatusCode, b)
	}
	var result EnrollResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Connect establishes the WebSocket connection to the server.
func (c *Client) Connect(ctx context.Context) error {
	u, err := url.Parse(c.serverURL)
	if err != nil {
		return err
	}

	q := u.Query()
	q.Set("token", c.agentToken)
	u.RawQuery = q.Encode()

	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	// Read server frames in the background and dispatch the ones we understand.
	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				if !strings.Contains(err.Error(), "use of closed network connection") {
					log.Printf("ws read: %v", err)
				}
				return
			}
			var msg ServerMessage
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue // not a frame we understand — ignore
			}
			if c.OnServerMessage != nil && msg.Type != "" {
				c.OnServerMessage(msg)
			}
		}
	}()

	// Advertise capabilities so the server knows what it may ask for.
	if c.hello != nil {
		if err := c.Send(c.hello); err != nil {
			log.Printf("hello send failed: %v", err)
		}
	}

	return nil
}

// Send serialises the payload and sends it over the WebSocket.
//
// Metric snapshots are sent as a bare object with no "type" field, exactly as
// before, so a new agent still works against an older server. Everything else
// carries a "type" discriminator.
func (c *Client) Send(payload any) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.conn == nil {
		return fmt.Errorf("not connected")
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return c.conn.WriteMessage(websocket.TextMessage, b)
}

func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != nil {
		_ = c.conn.Close()
	}
}

// Reconnect retries Connect with exponential backoff.
func (c *Client) Reconnect(ctx context.Context) {
	backoff := time.Second
	for {
		log.Printf("Reconnecting to %s...", c.serverURL)
		if err := c.Connect(ctx); err == nil {
			log.Println("Reconnected.")
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

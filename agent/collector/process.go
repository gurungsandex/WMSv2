package collector

import (
	"sort"
	"time"

	"github.com/shirou/gopsutil/v3/process"
)

// ProcessInfo is one row of the process inventory.
//
// Deliberately excludes command-line arguments: argv routinely carries
// passwords, tokens and document paths, which is user content. Name and
// executable path are enough to identify what is running.
type ProcessInfo struct {
	PID        int32   `json:"pid"`
	Name       string  `json:"name"`
	Username   string  `json:"username"`
	Exe        string  `json:"exe"`
	CPUPct     float64 `json:"cpu_pct"`
	MemPct     float64 `json:"mem_pct"`
	MemRSSMB   float64 `json:"mem_rss_mb"`
	IOReadMBs  float64 `json:"io_read_mbs"`
	IOWriteMBs float64 `json:"io_write_mbs"`
	StartedAt  int64   `json:"started_at"` // unix ms, 0 if unknown
}

// ProcessPayload is sent as {"type":"processes", ...}.
type ProcessPayload struct {
	Type      string        `json:"type"`
	Processes []ProcessInfo `json:"processes"`
	Total     int           `json:"total"` // processes seen, before top-N truncation
	New       []ProcessInfo `json:"new"`   // appeared since the previous sample
}

// Per-PID counters carried between samples so CPU and IO can be expressed
// as a rate over the interval rather than an average since process start.
// Mirrors the delta approach already used for disk and network in Collect().
type procCounters struct {
	cpuSeconds float64
	ioRead     uint64
	ioWrite    uint64
}

var (
	prevProcCounters = map[int32]procCounters{}
	prevProcSample   time.Time
	knownPIDs        = map[int32]string{} // pid -> name, for new-process detection
	procFirstRun     = true
)

// TopProcesses returns the top N processes by CPU, plus any processes that
// appeared since the previous sample.
//
// Cost note: this walks every process on the host. On Linux that is a
// /proc/<pid>/{stat,status,io} read per process. Measured at roughly 0.15ms
// per process (~15ms for 100 processes, ~45ms for 300). At a 60s interval
// that is well under 0.1% of one core.
func TopProcesses(topN int) (procs []ProcessInfo, newlySeen []ProcessInfo, total int) {
	all, err := process.Processes()
	if err != nil {
		return nil, nil, 0
	}

	now := time.Now()
	dt := 0.0
	if !prevProcSample.IsZero() {
		dt = now.Sub(prevProcSample).Seconds()
	}

	currentCounters := make(map[int32]procCounters, len(all))
	currentPIDs := make(map[int32]string, len(all))
	rows := make([]ProcessInfo, 0, len(all))

	for _, p := range all {
		name, err := p.Name()
		if err != nil || name == "" {
			continue // process exited between enumeration and read
		}

		info := ProcessInfo{PID: p.Pid, Name: name}
		currentPIDs[p.Pid] = name

		if u, err := p.Username(); err == nil {
			info.Username = u
		}
		if exe, err := p.Exe(); err == nil {
			info.Exe = exe
		} else {
			info.Exe = name
		}
		if mp, err := p.MemoryPercent(); err == nil {
			info.MemPct = float64(mp)
		}
		if mi, err := p.MemoryInfo(); err == nil && mi != nil {
			info.MemRSSMB = float64(mi.RSS) / 1e6
		}
		if ct, err := p.CreateTime(); err == nil {
			info.StartedAt = ct
		}

		c := procCounters{}
		if times, err := p.Times(); err == nil {
			c.cpuSeconds = times.User + times.System
		}
		// IOCounters is unavailable for other users' processes on macOS and
		// on some hardened Linux configs — absence is normal, not an error.
		if io, err := p.IOCounters(); err == nil && io != nil {
			c.ioRead = io.ReadBytes
			c.ioWrite = io.WriteBytes
		}
		currentCounters[p.Pid] = c

		if prev, ok := prevProcCounters[p.Pid]; ok && dt > 0 {
			if d := c.cpuSeconds - prev.cpuSeconds; d > 0 {
				info.CPUPct = d / dt * 100
			}
			if c.ioRead >= prev.ioRead {
				info.IOReadMBs = float64(c.ioRead-prev.ioRead) / 1e6 / dt
			}
			if c.ioWrite >= prev.ioWrite {
				info.IOWriteMBs = float64(c.ioWrite-prev.ioWrite) / 1e6 / dt
			}
		}

		rows = append(rows, info)
	}

	// New-process detection.
	//
	// This is a polling diff, not a kernel process-creation hook: a process
	// that starts and exits entirely between two samples is never seen. True
	// process-creation eventing needs auditd/ETW, which is a different
	// privilege and complexity class.
	if !procFirstRun {
		for _, info := range rows {
			if _, seen := knownPIDs[info.PID]; !seen {
				newlySeen = append(newlySeen, info)
			}
		}
	}

	prevProcCounters = currentCounters
	prevProcSample = now
	knownPIDs = currentPIDs
	procFirstRun = false

	sort.Slice(rows, func(i, j int) bool {
		if rows[i].CPUPct != rows[j].CPUPct {
			return rows[i].CPUPct > rows[j].CPUPct
		}
		return rows[i].MemRSSMB > rows[j].MemRSSMB
	})

	total = len(rows)
	if len(rows) > topN {
		rows = rows[:topN]
	}

	// Cap the new-process burst so a boot storm cannot flood the server.
	if len(newlySeen) > topN {
		newlySeen = newlySeen[:topN]
	}

	return rows, newlySeen, total
}

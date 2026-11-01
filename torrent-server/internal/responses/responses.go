package responses

import (
	bittorrent "github.com/anacrolix/torrent"
)

type TorrentFile struct {
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	Size     int64   `json:"size"`
	Progress float64 `json:"progress"`
}

type TorrentResponse struct {
	InfoHash   string        `json:"infoHash"`
	Name       string        `json:"name"`
	Progress   float64       `json:"progress"`
	Size       int64         `json:"size"`
	Downloaded int64         `json:"downloaded"`
	Files      []TorrentFile `json:"files"`

	// Peer diagnostics (cheap; present on every response).
	ActivePeers      int `json:"activePeers"`
	HalfOpenPeers    int `json:"halfOpenPeers"`
	PendingPeers     int `json:"pendingPeers"`
	TotalPeers       int `json:"totalPeers"`
	ConnectedSeeders int `json:"connectedSeeders"`

	// Piece diagnostics: only filled by WithPieceStats (single-torrent endpoint);
	// omitted from list responses because they walk the piece state.
	PiecesComplete     *int  `json:"piecesComplete,omitempty"`
	PiecesTotal        *int  `json:"piecesTotal,omitempty"`
	PiecesMissing      *int  `json:"piecesMissing,omitempty"`
	MissingPieceSample []int `json:"missingPieceSample,omitempty"`
}

// WithPieceStats fills the piece counters and up to 10 missing piece indices.
// Uses PieceStateRuns (run-length encoded), so cost is O(runs), not O(pieces)
// for the counts. Intended for GET /torrents/:infoHash only, not the list.
func WithPieceStats(r TorrentResponse, torrent *bittorrent.Torrent) TorrentResponse {
	const sampleMax = 10
	total, complete := 0, 0
	sample := []int{}
	for _, run := range torrent.PieceStateRuns() {
		if run.Complete {
			complete += run.Length
		} else {
			for i := 0; i < run.Length && len(sample) < sampleMax; i++ {
				sample = append(sample, total+i)
			}
		}
		total += run.Length
	}
	missing := total - complete
	r.PiecesComplete, r.PiecesTotal, r.PiecesMissing = &complete, &total, &missing
	r.MissingPieceSample = sample
	return r
}

// ratio returns done/total, treating an empty total as fully complete so the
// JSON encoder never sees NaN.
func ratio(done, total int64) float64 {
	if total <= 0 {
		return 1
	}
	return float64(done) / float64(total)
}

// TorrentToResponse builds the response; withFiles=false skips the per-file loop.
func TorrentToResponse(torrent *bittorrent.Torrent, withFiles bool) TorrentResponse {
	files := []TorrentFile{}
	if withFiles {
		tFiles := torrent.Files()
		files = make([]TorrentFile, 0, len(tFiles))
		for _, file := range tFiles {
			files = append(files, TorrentFile{
				Name:     file.DisplayPath(),
				Path:     file.Path(),
				Size:     file.Length(),
				Progress: ratio(file.BytesCompleted(), file.Length()),
			})
		}
	}
	st := torrent.Stats()
	response := TorrentResponse{
		ActivePeers:      st.ActivePeers,
		HalfOpenPeers:    st.HalfOpenPeers,
		PendingPeers:     st.PendingPeers,
		TotalPeers:       st.TotalPeers,
		ConnectedSeeders: st.ConnectedSeeders,
		InfoHash:   torrent.InfoHash().String(),
		Name:       torrent.Name(),
		Progress:   ratio(torrent.BytesCompleted(), torrent.Length()),
		Files:      files,
		Size:       torrent.Length(),
		Downloaded: torrent.BytesCompleted(),
	}
	return response
}

func TorrentsToResponse(torrents []*bittorrent.Torrent, withFiles bool) []TorrentResponse {
	responses := make([]TorrentResponse, 0, len(torrents))
	for _, torrent := range torrents {
		responses = append(responses, TorrentToResponse(torrent, withFiles))
	}
	return responses
}

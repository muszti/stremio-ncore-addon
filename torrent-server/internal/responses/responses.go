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
	response := TorrentResponse{
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

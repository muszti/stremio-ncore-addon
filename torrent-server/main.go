package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	bittorrent "github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	rangeparser "github.com/detarkende/stremio-ncore-addon/torrent-server/internal/range-parser"
	responses "github.com/detarkende/stremio-ncore-addon/torrent-server/internal/responses"
	gin "github.com/gin-gonic/gin"
)

type AddTorrentRequest struct {
	Path string `json:"path"`
}

const (
	// gotInfoTimeout bounds how long a request waits for torrent metadata.
	gotInfoTimeout = 30 * time.Second
	// streamReadahead is the readahead window of a streaming reader.
	streamReadahead = 16 << 20
)

// verifySem limits concurrent background piece verifications.
var verifySem = make(chan struct{}, 1)

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return def
}

// parseInfoHash parses a hex info hash without panicking on bad input.
func parseInfoHash(s string) (metainfo.Hash, bool) {
	var h metainfo.Hash
	if err := h.FromHexString(s); err != nil {
		return h, false
	}
	return h, true
}

// lookupTorrent resolves the :infoHash param and writes a 400/404 on failure.
func lookupTorrent(c *gin.Context, client *bittorrent.Client) (*bittorrent.Torrent, bool) {
	h, ok := parseInfoHash(c.Param("infoHash"))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid info hash"})
		return nil, false
	}
	t, ok := client.Torrent(h)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "Torrent not found"})
		return nil, false
	}
	return t, true
}

// waitForInfo waits for torrent metadata, the request context or a timeout.
// It writes a 504 on timeout; it returns false if the caller should stop.
func waitForInfo(c *gin.Context, t *bittorrent.Torrent) bool {
	timer := time.NewTimer(gotInfoTimeout)
	defer timer.Stop()
	select {
	case <-t.GotInfo():
		return true
	case <-c.Request.Context().Done():
		return false
	case <-timer.C:
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": "Timed out waiting for torrent metadata"})
		return false
	}
}

// verifyInBackground re-checks piece hashes without blocking any request.
func verifyInBackground(t *bittorrent.Torrent) {
	go func() {
		verifySem <- struct{}{}
		defer func() { <-verifySem }()
		<-t.GotInfo()
		log.Printf("verifying %s", t.InfoHash().HexString())
		t.VerifyData()
		log.Printf("verified %s", t.InfoHash().HexString())
	}()
}

func main() {
	var port int
	var downloadDir string
	var establishedConns, halfOpenConns int
	var disableIPv6 bool

	flag.IntVar(&port, "p", 0, "Port to run the server on")
	flag.StringVar(&downloadDir, "d", "", "Directory to store downloads")
	flag.IntVar(&establishedConns, "max-conns", envInt("TORRENT_MAX_CONNS", 0), "Max established peer connections per torrent (0 = library default)")
	flag.IntVar(&halfOpenConns, "max-half-open", envInt("TORRENT_MAX_HALF_OPEN", 0), "Max half-open peer connections per torrent (0 = library default)")
	flag.BoolVar(&disableIPv6, "disable-ipv6", os.Getenv("TORRENT_DISABLE_IPV6") == "1", "Disable IPv6 for peer connections")

	flag.Parse()

	if port == 0 {
		log.Fatal("Port flag is required")
		return
	}
	if downloadDir == "" {
		log.Fatal("Download directory flag is required")
		return
	}

	log.Printf("Starting server on port %d. Downloading to directory: %s", port, downloadDir)

	cfg := bittorrent.NewDefaultClientConfig()
	cfg.DataDir = downloadDir // Store all downloads in a specific directory
	cfg.Seed = true
	if establishedConns > 0 {
		cfg.EstablishedConnsPerTorrent = establishedConns
	}
	if halfOpenConns > 0 {
		cfg.HalfOpenConnsPerTorrent = halfOpenConns
	}
	cfg.DisableIPv6 = disableIPv6

	client, err := bittorrent.NewClient(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	r := gin.Default()

	r.GET("/torrents", func(c *gin.Context) {
		torrents := client.Torrents()
		response := responses.TorrentsToResponse(torrents, c.Query("files") != "0")
		c.JSON(http.StatusOK, response)
	})

	r.POST("/torrents", func(c *gin.Context) {
		var json AddTorrentRequest
		if err := c.ShouldBindBodyWithJSON(&json); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		mi, err := metainfo.LoadFromFile(json.Path)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		// Idempotent: an already-added torrent is returned as is.
		if existing, ok := client.Torrent(mi.HashInfoBytes()); ok {
			c.JSON(http.StatusOK, responses.TorrentToResponse(existing, true))
			return
		}
		// Metadata comes from the file, so GotInfo is already satisfied. Existing
		// data is validated through the piece-completion store, not a full recheck.
		torrent, err := client.AddTorrent(mi)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if c.Query("verify") == "1" {
			verifyInBackground(torrent)
		}
		c.JSON(http.StatusAccepted, responses.TorrentToResponse(torrent, true))
	})

	r.POST("/torrents/:infoHash/verify", func(c *gin.Context) {
		torrent, ok := lookupTorrent(c, client)
		if !ok {
			return
		}
		verifyInBackground(torrent)
		c.JSON(http.StatusAccepted, gin.H{"message": "Verification started"})
	})

	r.GET("/torrents/:infoHash", func(c *gin.Context) {
		torrent, ok := lookupTorrent(c, client)
		if !ok {
			return
		}
		c.JSON(http.StatusOK, responses.TorrentToResponse(torrent, c.Query("files") != "0"))
	})

	// Plain-text dump of peers, trackers and piece state for debugging stalled torrents
	r.GET("/debug/status", func(c *gin.Context) {
		client.WriteStatus(c.Writer)
	})

	r.POST("/torrents/:infoHash/download", func(c *gin.Context) {
		infoHash := c.Param("infoHash")
		torrent, ok := client.Torrent(infohash.FromHexString(infoHash))
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "Torrent not found"})
			return
		}
		// Not persisted: has to be requested again if the server restarts before completion
		torrent.DownloadAll()
		c.JSON(http.StatusOK, responses.TorrentToResponse(torrent))
	})

	r.DELETE("/torrents/:infoHash", func(c *gin.Context) {
		infoHash := c.Param("infoHash")
		torrent, ok := lookupTorrent(c, client)
		if !ok {
			return
		}
		// Get torrent's root directory/files before dropping
		downloadPath := cfg.DataDir
		torrentName := torrent.Name()

		torrent.Drop()

		// Remove the data files
		fullPath := path.Join(downloadPath, torrentName)
		err := os.RemoveAll(fullPath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Torrent removed but failed to delete data files",
				"details": err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"message":  "Torrent and data deleted successfully",
			"infoHash": infoHash,
		})
	})

	r.Match([]string{"GET", "HEAD"}, "/torrents/:infoHash/files/*filePath", func(c *gin.Context) {
		filepath := strings.TrimPrefix(c.Param("filePath"), "/")
		torrent, ok := lookupTorrent(c, client)
		if !ok {
			return
		}

		if !waitForInfo(c, torrent) {
			return
		}
		var targetFile *bittorrent.File
		for _, file := range torrent.Files() {
			if file.Path() == filepath {
				targetFile = file
				break
			}
		}
		if targetFile == nil {
			log.Printf("file not found: %s", filepath)
			c.JSON(http.StatusNotFound, gin.H{"error": "File not found: " + filepath})
			return
		}

		fileSize := targetFile.Length()
		contentType := getContentType(filepath)

		if c.Request.Method == "HEAD" {
			c.Header("Content-Length", strconv.FormatInt(fileSize, 10))
			c.Header("Content-Type", contentType)
			c.Header("Accept-Ranges", "bytes")
			c.Status(http.StatusOK)
			return
		}

		// No Range header: serve the whole file with 200. Otherwise parse the range.
		status := http.StatusOK
		start, end := int64(0), fileSize-1
		extraHeaders := map[string]string{"Accept-Ranges": "bytes"}
		if rangeHeader := c.GetHeader("Range"); rangeHeader != "" {
			var err error
			start, end, err = rangeparser.ParseRangeHeader(rangeHeader, fileSize)
			if err != nil {
				log.Printf("range error for %s: %v", filepath, err)
				c.Header("Accept-Ranges", "bytes")
				c.Header("Content-Type", contentType)
				c.Header("Content-Range", fmt.Sprintf("bytes */%d", fileSize))
				c.Status(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			status = http.StatusPartialContent
			extraHeaders["Content-Range"] = fmt.Sprintf("bytes %d-%d/%d", start, end, fileSize)
		}
		length := end - start + 1

		// Create reader for the specific range
		reader := targetFile.NewReader()
		reader.SetResponsive()
		reader.SetReadahead(streamReadahead)

		// Tie the reader to the request so a disconnect or seek releases it
		// even when a read is blocked waiting for pieces.
		var closeOnce sync.Once
		closeReader := func() { closeOnce.Do(func() { reader.Close() }) }
		done := make(chan struct{})
		defer func() {
			close(done)
			closeReader()
		}()
		go func() {
			select {
			case <-c.Request.Context().Done():
				closeReader()
			case <-done:
			}
		}()

		if _, err := reader.Seek(start, io.SeekStart); err != nil {
			c.String(http.StatusInternalServerError, "Failed to seek to position: %v", err)
			return
		}

		// Stream only the requested range
		limitedReader := io.LimitReader(reader, length)
		c.DataFromReader(status, length, contentType, limitedReader, extraHeaders)
	})

	baseCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(port),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// Request contexts derive from baseCtx, so streams end on shutdown.
		// No WriteTimeout: streams are long-lived.
		BaseContext: func(net.Listener) context.Context { return baseCtx },
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server error: %v", err)
		}
	case <-baseCtx.Done():
		log.Print("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			srv.Close()
		}
	}
	// client.Close() runs via the deferred call above.
}

func getContentType(filepath string) string {
	ext := strings.ToLower(path.Ext(filepath))
	switch ext {
	case ".mp4":
		return "video/mp4"
	case ".mkv":
		return "video/x-matroska"
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".srt":
		return "text/plain; charset=utf-8"
	case ".sub":
		return "text/plain; charset=utf-8"
	case ".ass", ".ssa":
		return "text/plain; charset=utf-8"
	case ".vtt":
		return "text/vtt; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}

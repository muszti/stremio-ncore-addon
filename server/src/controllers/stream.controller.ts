import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamQuerySchema } from '@/schemas/stream.schema';
import type { TorrentService } from '@/services/torrent';
import type { StreamService } from '@/services/stream';
import type { UserService } from '@/services/user';
import type { TorrentStoreService } from '@/services/torrent-store';
import { playSchema } from '@/schemas/play.schema';
import { proxy } from 'hono/proxy';
import { HttpStatusCode } from '@/types/http';
import type { TorrentResponse } from '@/services/torrent-store/types';
import type { TorrentSourceManager } from '@/services/torrent-source';
import { TorrentServerTimeoutError } from '@/services/torrent-store/torrent-server.sdk';

const PROXY_HEADERS_TIMEOUT_MS = 30_000;

export class StreamController {
  constructor(
    private torrentSource: TorrentSourceManager,
    private torrentService: TorrentService,
    private streamService: StreamService,
    private userService: UserService,
    private torrentStoreService: TorrentStoreService,
  ) {}

  public async getStreamsForMedia(c: Context) {
    const params = c.req.param();
    const result = streamQuerySchema.safeParse(params);
    if (!result.success) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, {
        message: result.error.message,
      });
    }
    const { imdbId, type, episode, season, deviceToken } = result.data;

    const user = await this.userService.getUserByDeviceTokenOrThrow(deviceToken);

    const allTorrents = await this.torrentSource.getTorrentsForImdbId({
      imdbId,
      type,
      season,
      episode,
    });
    // never emit a stream for a torrent without a matching media file (index -1)
    const torrents = allTorrents.filter(
      (torrent) => torrent.getMediaFileIndex({ season, episode }) >= 0,
    );

    const orderedTorrents = await this.streamService.orderTorrents({
      torrents,
      season,
      episode,
      user,
    });

    const { preferredLanguage } = user;

    const streams = orderedTorrents.map((torrent, i) =>
      this.streamService.convertTorrentToStream({
        torrent,
        isRecommended: i === 0,
        deviceToken,
        season,
        episode,
        preferredLanguage,
      }),
    );

    return c.json({ streams });
  }

  public async play(c: Context) {
    const params = c.req.param();
    const result = playSchema.safeParse(params);
    if (!result.success) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, {
        message: result.error.message,
      });
    }
    const { sourceName, sourceId, infoHash, fileIdx } = result.data;

    let torrent: TorrentResponse;
    try {
      torrent = await this.getOrAddTorrent({ infoHash, sourceId, sourceName });
    } catch (e) {
      if (e instanceof TorrentServerTimeoutError) {
        console.error(e.message);
        throw new HTTPException(HttpStatusCode.SERVICE_UNAVAILABLE, {
          res: new Response('Torrent server is busy, try again shortly.', {
            status: HttpStatusCode.SERVICE_UNAVAILABLE,
            headers: { 'Retry-After': '10' },
          }),
        });
      }
      throw e;
    }
    const file = torrent.files[fileIdx];
    if (!file) {
      throw new HTTPException(HttpStatusCode.NOT_FOUND, {
        message: 'File not found in torrent',
      });
    }

    // Only bound the time until response headers arrive. Once the Response is
    // returned the timer is cleared, so the stream itself has no total timeout.
    const controller = new AbortController();
    const headersTimer = setTimeout(() => controller.abort(), PROXY_HEADERS_TIMEOUT_MS);
    try {
      return await proxy(
        this.torrentStoreService.getFileStreamingUrl({
          infoHash: torrent.infoHash,
          filePath: file.path,
        }),
        { headers: { ...c.req.header() }, signal: controller.signal },
      );
    } catch (e) {
      if (controller.signal.aborted) {
        console.error('Timed out waiting for torrent server stream headers.');
        throw new HTTPException(HttpStatusCode.SERVICE_UNAVAILABLE, {
          res: new Response('Torrent server is busy, try again shortly.', {
            status: HttpStatusCode.SERVICE_UNAVAILABLE,
            headers: { 'Retry-After': '10' },
          }),
        });
      }
      throw e;
    } finally {
      clearTimeout(headersTimer);
    }
  }

  private async getOrAddTorrent({
    infoHash,
    sourceId,
    sourceName,
  }: {
    infoHash: string;
    sourceId: string;
    sourceName: string;
  }): Promise<TorrentResponse> {
    const existing = await this.torrentStoreService.getTorrent(infoHash);
    if (existing) {
      return existing;
    }
    const torrentUrl = await this.torrentSource.getTorrentUrlBySourceId({
      sourceId,
      sourceName,
    });
    if (!torrentUrl) {
      throw new HTTPException(HttpStatusCode.NOT_FOUND, {
        message: 'Torrent not found',
      });
    }
    const torrentFilePath = await this.torrentService.downloadTorrentFile(torrentUrl);
    return await this.torrentStoreService.addTorrent(torrentFilePath);
  }
}

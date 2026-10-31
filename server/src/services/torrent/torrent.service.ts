import parseTorrent from 'parse-torrent';
import contentDisposition from 'content-disposition';
import type { ParsedTorrentDetails } from './types';
import { writeFileWithCreateDir } from '@/utils/files';
import { env } from '@/env';
import { Cached, DEFAULT_TTL } from '@/utils/cache';

const DOWNLOAD_TIMEOUT_MS = 20_000;

export class TorrentService {
  @Cached({
    max: 1_000,
    ttl: DEFAULT_TTL,
    ttlAutopurge: true,
    generateKey: (torrentUrl) => torrentUrl,
  })
  public async downloadAndParseTorrent(
    torrentUrl: string,
  ): Promise<ParsedTorrentDetails> {
    const torrentResponse = await fetch(torrentUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!torrentResponse.ok) {
      throw new Error(
        `Failed to download torrent file. Status: ${torrentResponse.status}`,
      );
    }
    const buffer = await torrentResponse.arrayBuffer();
    const torrentData = await parseTorrent(new Uint8Array(buffer));
    return {
      infoHash: torrentData.infoHash,
      files:
        torrentData.files?.map((file) => ({
          name: file.name,
          length: file.length,
          offset: file.offset,
          path: file.path,
        })) ?? [],
    };
  }

  /**
   * @returns the path to the downloaded torrent file
   */
  public async downloadTorrentFile(torrentUrl: string): Promise<string> {
    const torrentReq = await fetch(torrentUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!torrentReq.ok) {
      throw new Error(`Failed to download torrent file. Status: ${torrentReq.status}`);
    }
    const torrentArrayBuffer = await torrentReq.arrayBuffer();
    const parsedTorrent = await parseTorrent(new Uint8Array(torrentArrayBuffer));
    // torrent file name without the .torrent extension
    const torrentFileName = contentDisposition
      .parse(torrentReq.headers.get('content-disposition') ?? '')
      .parameters.filename?.replace(/\.torrent$/i, '');

    const torrentFilePath = `${env.TORRENTS_DIR}/${torrentFileName}-${parsedTorrent.infoHash}.torrent`;

    writeFileWithCreateDir(torrentFilePath, Buffer.from(torrentArrayBuffer));
    return torrentFilePath;
  }
}

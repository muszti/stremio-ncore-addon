import { HttpStatusCode } from '@/types/http';
import { AddTorrentRequest, InfoHash, TorrentResponse } from './types';
import { rm } from 'fs/promises';
import { globSync } from 'glob';
import { env } from '@/env';

const GET_TIMEOUT_MS = 10_000;
const GET_ALL_TIMEOUT_MS = 15_000;
// The Go server verifies every piece before answering, so adds can be slow (until it is made async).
const ADD_TIMEOUT_MS = 10 * 60_000;
const DELETE_TIMEOUT_MS = 30_000;

export class TorrentServerTimeoutError extends Error {
  constructor(operation: string) {
    super(`Torrent server did not respond in time (${operation}).`);
    this.name = 'TorrentServerTimeoutError';
  }
}

async function serverFetch(
  operation: string,
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new TorrentServerTimeoutError(operation);
    }
    throw e;
  }
}

export class TorrentServerSdk {
  private torrentFilePaths = new Map<InfoHash, string>();
  constructor(private readonly url: string) {}

  public async getTorrent(infoHash: InfoHash): Promise<TorrentResponse | null> {
    const req = await serverFetch(
      'get torrent',
      `${this.url}/torrents/${infoHash}`,
      GET_TIMEOUT_MS,
    );
    if (!req.ok) {
      if (req.status === HttpStatusCode.NOT_FOUND) {
        return null;
      }
      const responseText = await req.text();
      throw Error(
        `Could not find torrent. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
    return (await req.json()) as TorrentResponse;
  }

  public async getAllTorrents(): Promise<TorrentResponse[]> {
    const req = await serverFetch(
      'get torrents',
      `${this.url}/torrents`,
      GET_ALL_TIMEOUT_MS,
    );
    if (!req.ok) {
      const responseText = await req.text();
      throw Error(
        `Failed to get torrents. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
    return (await req.json()) as TorrentResponse[];
  }

  public async addTorrent(torrentFilePath: string): Promise<TorrentResponse> {
    const req = await serverFetch('add torrent', `${this.url}/torrents`, ADD_TIMEOUT_MS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: torrentFilePath } satisfies AddTorrentRequest),
    });
    if (!req.ok) {
      const responseText = await req.text();
      throw Error(
        `Could not add torrent. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
    const torrent = (await req.json()) as TorrentResponse;
    this.torrentFilePaths.set(torrent.infoHash, torrentFilePath);
    return torrent;
  }

  public async downloadAll(infoHash: InfoHash): Promise<void> {
    const req = await fetch(`${this.url}/torrents/${infoHash}/download`, {
      method: 'POST',
    });
    if (!req.ok) {
      const responseText = await req.text();
      throw Error(
        `Could not force full download. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
  }

  public async deleteTorrent(infoHash: InfoHash): Promise<void> {
    const req = await serverFetch(
      'delete torrent',
      `${this.url}/torrents/${infoHash}`,
      DELETE_TIMEOUT_MS,
      { method: 'DELETE' },
    );
    if (!req.ok) {
      const responseText = await req.text();
      throw Error(
        `Could not delete torrent. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
    // the path is deterministic ("<name>-<infoHash>.torrent"), so fall back to a glob
    // when this process never saw the add (e.g. the add timed out or the app restarted)
    const torrentFilePath =
      this.torrentFilePaths.get(infoHash) ??
      globSync(`${env.TORRENTS_DIR}/*-${infoHash}.torrent`)[0];
    if (!torrentFilePath) {
      throw Error(
        `Failed to delete torrent file for ${infoHash}. File not found in "${env.TORRENTS_DIR}".`,
      );
    }
    try {
      await rm(torrentFilePath);
      this.torrentFilePaths.delete(infoHash);
    } catch (e) {
      throw Error(
        `Failed to delete torrent file at path: "${torrentFilePath}". Error: "${e}"`,
      );
    }
  }

  public getFileStreamingUrl(infoHash: InfoHash, filePath: string): string {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    return `${this.url}/torrents/${infoHash}/files/${encodedPath}`;
  }
}

import { ChildProcess, spawn } from 'node:child_process';
import { TorrentSourceManager } from '../torrent-source';
import { TorrentResponse, TorrentStoreStats } from './types';
import { env } from '@/env';
import { resolve } from 'node:path';
import { formatBytes } from '@/utils/bytes';
import { globSync } from 'glob';
import { TorrentServerSdk } from './torrent-server.sdk';
import { sleep } from '@/utils/sleep';
import { processInBatches } from '@/utils/process-in-batches';

const LOAD_CONCURRENCY = 3;

export class TorrentStoreService {
  private torrentServerUrl: string = `http://localhost:${env.TORRENT_SERVER_PORT}`;
  private torrentServerInstance: ChildProcess | null = null;
  private restartCount = 0;
  private torrentServerSdk: TorrentServerSdk = new TorrentServerSdk(
    this.torrentServerUrl,
  );

  constructor(private torrentSource: TorrentSourceManager) {}

  public async startServer() {
    if (process.env.NODE_ENV === 'production') {
      this.spawnServer();
      await this.waitForServer(30);
    } else {
      await this.waitForServer(5);
    }
  }

  private spawnServer() {
    const executablePath = resolve(
      import.meta.dirname,
      '../../../torrent-server/torrent-server',
    );
    // stdout/stderr must NOT be left as unread pipes: once the pipe buffer fills up,
    // the Go process blocks on its next log write and every request hangs.
    const child = spawn(
      executablePath,
      ['-p', `${env.TORRENT_SERVER_PORT}`, '-d', env.DOWNLOADS_DIR],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, GIN_MODE: 'release' },
      },
    );
    this.torrentServerInstance = child;
    const startedAt = Date.now();

    child.on('error', (error) => {
      console.error('[torrent-server] failed to start or crashed:', error);
    });
    child.on('exit', (code, signal) => {
      console.error(`[torrent-server] exited (code: ${code}, signal: ${signal}).`);
      if (this.torrentServerInstance !== child) {
        return;
      }
      // reset the backoff if the server had been running stably for a while
      if (Date.now() - startedAt > 60_000) {
        this.restartCount = 0;
      }
      const delayMs = Math.min(1_000 * 2 ** this.restartCount, 30_000);
      this.restartCount++;
      console.error(`[torrent-server] restarting in ${delayMs} ms.`);
      setTimeout(() => {
        this.spawnServer();
        this.waitForServer(30)
          .then(() => this.loadExistingTorrents())
          .catch((e) => console.error('[torrent-server] reload after restart failed', e));
      }, delayMs);
    });
  }

  private async waitForServer(maxRetries: number) {
    let retryCount = 0;
    while (retryCount < maxRetries) {
      try {
        retryCount++;
        console.log(`Looking for torrent server. Try #${retryCount}`);
        await sleep(1000);
        await fetch(this.torrentServerUrl, { signal: AbortSignal.timeout(2_000) });
        console.log('Found torrent server.');
        return;
      } catch {
        console.log(`Server is not up yet. Retrying in 1 second`);
      }
    }
    console.error(`Torrent server did not come up after ${maxRetries} tries.`);
  }

  private checkServer() {
    if (this.torrentServerInstance === null && process.env.NODE_ENV === 'production') {
      throw Error(
        'The torrent server is not running. You need to initialize it first. This is a bug, please create an issue on github.',
      );
    }
  }

  public async addTorrent(torrentFilePath: string): Promise<TorrentResponse> {
    this.checkServer();
    const torrent = await this.torrentServerSdk.addTorrent(torrentFilePath);
    return torrent;
  }

  public async getTorrent(infoHash: string): Promise<TorrentResponse | null> {
    this.checkServer();
    const torrent = await this.torrentServerSdk.getTorrent(infoHash);
    return torrent;
  }

  public async deleteTorrent(infoHash: string): Promise<void> {
    this.checkServer();
    return await this.torrentServerSdk.deleteTorrent(infoHash);
  }

  public async getStoreStats(): Promise<TorrentStoreStats[]> {
    this.checkServer();
    const torrents = await this.torrentServerSdk.getAllTorrents();
    const stats = torrents
      .map(
        (t) =>
          ({
            hash: t.infoHash,
            name: t.name,
            size: formatBytes(t.size),
            downloaded: formatBytes(t.downloaded),
            progress: `${(t.progress * 100).toFixed(2)}%`,
          }) satisfies TorrentStoreStats,
      )
      .sort((a, z) => a.name.localeCompare(z.name));
    return stats;
  }

  public getFileStreamingUrl({
    infoHash,
    filePath,
  }: {
    infoHash: string;
    filePath: string;
  }) {
    return this.torrentServerSdk.getFileStreamingUrl(infoHash, filePath);
  }

  public async loadExistingTorrents(): Promise<void> {
    this.checkServer();
    console.log('Looking for torrent files...');
    const savedTorrentFilePaths = globSync(`${env.TORRENTS_DIR}/*.torrent`);
    console.log(`Found ${savedTorrentFilePaths.length} torrent files.`);
    let loaded = 0;
    let failed = 0;
    // bounded concurrency: every add triggers a full piece verification in the Go server
    await processInBatches(
      savedTorrentFilePaths,
      LOAD_CONCURRENCY,
      0,
      async (filePath) => {
        try {
          await this.addTorrent(filePath);
          loaded++;
        } catch (e) {
          failed++;
          console.error(`Failed to load torrent file "${filePath}":`, e);
        }
      },
    );
    console.log(`Torrent files loaded and verified: ${loaded} loaded, ${failed} failed.`);
  }

  public deleteUnnecessaryTorrents = async () => {
    try {
      this.checkServer();
      console.log('Gathering unnecessary torrents...');
      const deletableInfoHashes = await this.torrentSource.getRemovableInfoHashes();
      console.log(`Found ${deletableInfoHashes.length} deletable torrents.`);
      for (const infoHash of deletableInfoHashes) {
        try {
          const torrent = await this.getTorrent(infoHash);
          if (torrent) {
            await this.deleteTorrent(infoHash);
            console.log(`Successfully deleted ${torrent.name} - ${torrent.infoHash}.`);
          }
        } catch (e) {
          console.error(`Failed to delete torrent ${infoHash}:`, e);
        }
      }
    } catch (e) {
      console.error('Failed to delete unnecessary torrents:', e);
    }
  };
}

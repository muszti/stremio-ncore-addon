import type { Stream } from 'stremio-addon-sdk';
import type { TorrentDetails } from '../torrent-source';
import type { TorrentFileDetails } from '../torrent-source/types';
import { languageEmojiMap } from './constants';
import { rateList } from '@/utils/rate-list';
import { formatBytes } from '@/utils/bytes';
import { ConfigService } from '../config';
import { UserService } from '../user';
import { User } from '@/types/user';
import { Language } from '@/db/schema/users';
import path from 'node:path';

const SUBTITLE_EXTENSIONS = ['.srt', '.sub', '.ass', '.ssa', '.vtt'];

function isSubtitleFile(fileName: string): boolean {
  return SUBTITLE_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
}

function detectSubtitleLanguage(fileName: string): string {
  const lower = fileName.toLowerCase();
  const base = path.basename(lower, path.extname(lower));
  const parts = base.split(/[.\-_]/);
  const lastPart = parts[parts.length - 1];

  const langMap: Record<string, string> = {
    hun: 'hun', hu: 'hun', hungarian: 'hun', magyar: 'hun',
    eng: 'eng', en: 'eng', english: 'eng',
    ger: 'ger', de: 'ger', german: 'ger',
    fre: 'fre', fr: 'fre', french: 'fre',
    ita: 'ita', it: 'ita', italian: 'ita',
    spa: 'spa', es: 'spa', spanish: 'spa',
    por: 'por', pt: 'por', portuguese: 'por',
    rum: 'rum', ro: 'rum', romanian: 'rum',
    cze: 'cze', cs: 'cze', czech: 'cze',
    pol: 'pol', pl: 'pol', polish: 'pol',
    slo: 'slo', sk: 'slo', slovak: 'slo',
    hrv: 'hrv', hr: 'hrv', croatian: 'hrv',
    srp: 'srp', sr: 'srp', serbian: 'srp',
  };

  if (lastPart && langMap[lastPart]) {
    return langMap[lastPart];
  }

  for (const part of parts) {
    if (langMap[part]) {
      return langMap[part];
    }
  }

  return 'und';
}

export class StreamService {
  constructor(
    private configService: ConfigService,
    private userService: UserService,
  ) {}

  public convertTorrentToStream({
    torrent,
    isRecommended,
    deviceToken,
    season,
    episode,
    preferredLanguage,
  }: {
    torrent: TorrentDetails;
    isRecommended: boolean;
    deviceToken: string;
    season: number | undefined;
    episode: number | undefined;
    preferredLanguage: Language;
  }): Stream {
    const config = this.configService.getConfig();
    const torrentFileIndex = torrent.getMediaFileIndex({ season, episode });

    const sourceName = encodeURIComponent(torrent.sourceName);
    const sourceId = encodeURIComponent(torrent.sourceId);
    const infoHash = encodeURIComponent(torrent.infoHash);
    const fileIndex = encodeURIComponent(torrentFileIndex);

    const description = this.getStreamDescription(
      torrent,
      isRecommended,
      {
        season,
        episode,
      },
      preferredLanguage,
    );
    const basePlayUrl = `${config.addonUrl}/api/auth/${deviceToken}/stream/play/${sourceName}/${sourceId}/${infoHash}`;

    const subtitles = torrent.files
      .map((file, idx) => ({ file, idx }))
      .filter(({ file }) => isSubtitleFile(file.name))
      .map(({ file, idx }) => ({
        id: `sub-${idx}`,
        url: `${basePlayUrl}/${idx}`,
        lang: detectSubtitleLanguage(file.name),
      }));

    return {
      url: `${basePlayUrl}/${fileIndex}`,
      description,
      subtitles: subtitles.length > 0 ? subtitles : undefined,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: torrent.infoHash,
        seeders: torrent.getSeeders(),
      },
    };
  }

  private getStreamDescription(
    torrent: TorrentDetails,
    isRecommended: boolean,
    { season, episode }: { season: number | undefined; episode: number | undefined },
    preferredLanguage: Language,
  ): string {
    const languageEmoji = languageEmojiMap[torrent.getLanguage()];
    const fileIndex = torrent.getMediaFileIndex({ season, episode });
    const file = torrent.files[fileIndex] as TorrentFileDetails;
    const fileSizeString = formatBytes(file.length);

    const isShow = season && episode;
    let mediaType = '';
    switch (preferredLanguage) {
      case Language.HU:
        mediaType = isShow ? 'sorozat' : 'film';
        break;
      default:
        mediaType = isShow ? 'show' : 'movie';
    }

    let recommendedLine = '';
    if (isRecommended && !torrent.isSpeculated) {
      switch (preferredLanguage) {
        case Language.HU:
          recommendedLine = '⭐️ Ajánlott\n';
          break;
        default:
          recommendedLine = '⭐️ Recommended\n';
      }
    }

    let warningLine = '';
    if (torrent.isSpeculated) {
      switch (preferredLanguage) {
        case Language.HU:
          warningLine = `⚠️ Bizonytalan forrás ⚠️\nEz lehet egy másik ${mediaType}!\n`;
          break;
        default:
          warningLine = `⚠️ Speculated source ⚠️\nThis might be a different ${mediaType}!\n`;
      }
    }

    const typeLine = `${languageEmoji} | ${torrent.displayResolution(torrent.getResolution(file.name))} | ${fileSizeString}\n`;
    const title = isShow ? `${file.name}\n` : `${torrent.getName()}\n`;
    const seeders = `👤 ${torrent.getSeeders()}\n`;
    return warningLine + recommendedLine + typeLine + title + seeders;
  }

  public async orderTorrents({
    torrents,
    user,
    season,
    episode,
  }: {
    torrents: TorrentDetails[];
    user: User;
    season: number | undefined;
    episode: number | undefined;
  }): Promise<TorrentDetails[]> {
    const { preferredLanguage, preferredResolutions } = user;

    return rateList(torrents, [
      (torrent) => (preferredLanguage === torrent.getLanguage() ? 3 : 0),
      (torrent) => {
        const fileIndex = torrent.getMediaFileIndex({ season, episode });
        const resolution = torrent.getResolution(torrent.files[fileIndex]!.name);
        return preferredResolutions.includes(resolution) ? 2 : 0;
      },
    ]);
  }
}

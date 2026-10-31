![banner](./docs/stremio-ncore-addon-banner.png)

# nCore addon

A self-hostable Stremio addon that lets you stream content straight from nCore.

https://github.com/user-attachments/assets/9fa6c837-78de-44fe-b1da-ae63ff44631e

> [!WARNING]
> This project is very much in its alpha phase. The setup is still a bit rough and even a full rewrite is not out of the picture. It's the early days of the project, so don't expect stability yet, but feel free to experiment with it.
> When you update, expect new or removed env vars and new or removed volumes from the docker compose config.

> [!IMPORTANT]
> I maintain this project in my free time as a hobby. Feel free to leave suggestions or feedback in the form of issues, but don't _expect_ free labor. Rude or entitled issues will be deleted without explanation.
> The project is source-available, meaning that I currently don't accept contributions.

## FAQ

### What is Stremio?

<details>
<summary>
View answer
</summary>

Stremio is a media hub for your Smart TV, phone, or computer, just like Netflix, Disney+, or other services.

The differe is that Stremio doesn't provide any media sources by default, you have to use addons for that.

Learn more about Stremio [here](https://www.stremio.com/), or download the apps [here](https://www.stremio.com/downloads).

</details>

### What is this addon?

<details>
<summary>
View answer
</summary>

This project is an addon that connects your nCore account to Stremio. Without an addon, stremio will show no "streams" for any media.

Once you configure this addon, you will be able to click on any movie/show and you will see a list of all torrents for that particular media from nCore.

The addon will even rank them based on your configured preferences (language + resolution).

</details>

### What do I need to get started?

<details>
<summary>
View answer
</summary>

- nCore account (that isn't banned)
- A computer to host this program on
  - Docker needs to be installed
  - Needs enough free space where the downloaded files will fit.
  - This computer should ideally always be on (because it needs to seed the files back to nCore)
- A device that can run Stremio (newer LG/Samsung Smart TVs, an Android TV box, or just a laptop/PC)

</details>

## Features

- Self-hostable. The downloading PC/server can be anywhere and you can stream remotely.
- Seeds torrents after download.
- Saves torrent files and downloads to disk. If you come back the next day, the files will already be downloaded, so you won't have to wait too long.
- Configurable to delete torrents when you no longer have to seed them. (Hit'n'run checker)
- Multiple users without having to tell your nCore password to anyone.
- Recommendations and torrent ordering based on user preferences (Language + Resolution).
- Automatic HTTPS on LAN.

## Setup

**Server**: the computer where you will host this addon.

**Client**: the device where you will watch the content through the Stremio app.

### Beginner guide

If you're not familiar with selfhosting, follow one of these guides:

- [Remotely accessible beginner's guide](./docs/installation-guides/beginners/remote-with-domain.md) (Use this if you want to share the addon with friends and family, or you want to use it outside of your own home network. Requires you to buy or have a domain).

- ["Local only" beginner's guide](./docs/installation-guides/beginners/local-only.md) (Use this if you only want to use the addon in your home network. You don't need your own domain for this.)

### Advanced guide

[If you know your way around selfhosting and Docker, follow this guide.](./docs/installation-guides/advanced/advanced.md)

## Fork notes (stream-stall fixes)

- Stream responses carry `behaviorHints.seeders` and a `👤 <seeders>` description line (read by AIOStreams). The `seeders` field is typed via `patches/@types__stremio-addon-sdk.patch`; after editing a patch, update its `patch_hash` entries in `pnpm-lock.yaml` (base32 md5 of the LF-normalized patch, or regenerate with `pnpm patch-commit`).
- The Dockerfile pins pnpm 9.12.2 via corepack, installs with `--frozen-lockfile`, sets `GIN_MODE=release` and has a HEALTHCHECK on the torrent server (`/torrents`). Build the image on a machine with enough memory, not the HA host.
- The former image-only `sed` patch on `dist/.../stream.service.js` is now part of the source; drop that step from whatever builds the `svc-fix` image.

## Roadmap

- [x] Admin panel for torrents
- [x] Sort torrents based on user preferences
- [x] Add database + install flow in WebUI to replace most environment variables
- [x] Integrate with [local-ip.medicmobile.org](https://local-ip.medicmobile.org/) to allow https for local network
- [ ] Add more unit tests to backend
- [ ] Add unit tests to frontend

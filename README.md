# Synchroplayer

Synchronized video player for watching videos together remotely.

[![](header.png)](https://movie.tom32i.fr)

Demo: https://movie.tom32i.fr

## Currently supported contents

| Content | Format | Method |
| ------- | ------ | ------ |
| Local video files | `.mp4`, `.mkv`, `.mov` | Drag & drop |
| Local subtitles files | `.vtt`, `.srt` | Drag & drop |
| Remote video url | Any url | Copy & paste |
| Youtube video url | `https://www.youtube.com/watch?v=BathEBfiG1s`, `https://youtu.be/BathEBfiG1s` | Copy & paste |

Local video files are uploaded to the server once, so every member — including
late joiners — plays the same content from a replayable address.

## Synchronization

Source switching, late-joiner snapshots and local-file replay are documented
in [doc/synchronization.md](./doc/synchronization.md).

## Tests

```sh
npm install
npm test
```

Runs the synchronization, codec, HTTP endpoint, client-store and end-to-end
(websocket) test suites with the built-in Node test runner.

## License

[MIT](./LICENSE)

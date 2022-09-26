const axios = require('axios')
require('dotenv').config()
const { get } = require('lodash')
const fs = require('fs')
const config = require('./config.js')
const YoutubeMp3Downloader = require("youtube-mp3-downloader");

run()

async function run() {

  if (!config.useDump) {
    const playlists = await getPlaylists(process.env.CHANNEL_ID)

    const playlistNames = playlists.map(playlist => playlist.snippet.title)

    const playlistItems = {}
    const songs = []
    const songMap = {}
    for (const playlist of playlists) {
      if (config.whitelist.includes(playlist.snippet.title)) {
        const items = await getPlaylistItems(playlist)
        playlistItems[playlist.snippet.title] = items
        items.forEach(item => {
          const song = {
            title: item.snippet.title,
            id: item.contentDetails.videoId,
            playlist: playlist.snippet.title,
          }
          songMap[song.id] = song
          songs.push(song)
        })
      }
    }

    fs.writeFileSync('playlistItems.json', JSON.stringify(playlistItems, null, 2))
    fs.writeFileSync('songs.json', JSON.stringify(songs, null, 2))
    fs.writeFileSync('songMap.json', JSON.stringify(songMap, null, 2))
  }

  if (!!config.download) {

    const songs = JSON.parse(fs.readFileSync('songs.json'))
    const songMap = JSON.parse(fs.readFileSync('songMap.json'))

    if (!fs.existsSync(config.outputDir)) {
      fs.mkdirSync(config.outputDir, { recursive: true })
    }
    if (!fs.existsSync(config.tmpDir)) {
      fs.mkdirSync(config.tmpDir, { recursive: true })
    }

    const stats = {
      downloaded: 0,
      skipped: 0,
      errors: 0,
      total: songs.length
    }

    setInterval(() => {
      console.log('Stats: downloaded', stats.downloaded, 'of', stats.total - stats.skipped, 'with', stats.skipped, 'skipped', stats.total, 'songs found')
    }, 2500)

    const YD = new YoutubeMp3Downloader({
      "ffmpegPath": config.ffmpegPath || "/usr/local/bin/ffmpeg",        // FFmpeg binary location
      "outputPath": config.tmpDir,    // Output file location (default: the home directory)
      "youtubeVideoQuality": "highestaudio",  // Desired video quality (default: highestaudio)
      "queueParallelism": 9,                  // Download parallelism (default: 1)
      "progressTimeout": 10000,                // Interval in ms for the progress reports (default: 1000)
      "allowWebm": true                      // Enable download from WebM sources (default: false)
    });

    YD.on("error", function (error) {
      stats.errors++
      // console.error(error);
    })

    YD.on("progress", function (progress) {
      console.log('Downloaded', Math.round(progress.progress.percentage) + '%', 'of', progress.videoId);
    })

    YD.on("finished", function (err, data) {
      const song = songMap[data.videoId]
      const safePlaylistName = song.playlist.replace(/\//gi, '-')
      const path = createPathFromSong(song)
      console.log('Finished downloading, moving to', path);
      fs.renameSync(data.file, path)
      stats.downloaded++
    })

    for (const song of songs) {

      const safePlaylistName = song.playlist.replace(/\//gi, '-')

      if (!fs.existsSync(config.outputDir + '/' + safePlaylistName)) {
        fs.mkdirSync(config.outputDir + '/' + safePlaylistName, { recursive: true })
      }

      if (!fs.existsSync(createPathFromSong(song))) {
        YD.download(song.id, `${song.id}.mp3`);
      } else {
        // console.log('Already downloaded', song.title, createPathFromSong(song))
        stats.skipped++
      }

    }
  }

}

function createPathFromSong(song) {
  const safePlaylistName = song.playlist.replace(/\//gi, '-')
  return `${config.outputDir}/${safePlaylistName}/${song.title}.mp3`
}

async function getPlaylistItems(playlist, items = [], pageToken = null) {

  console.log('Getting playlist items, playlist:', playlist.snippet.title, 'page:', pageToken)
  const resp = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
    params: {
      part: 'snippet,contentDetails',
      playlistId: playlist.id,
      pageToken,
      maxResults: 100,
      key: process.env.YOUTUBE_API_KEY,
    }
  }).catch(err => console.error(err))

  if (get(resp, 'data.items')) {
    items.push(...resp.data.items)
    if (resp.data.nextPageToken) {
      await getPlaylistItems(playlist, items, resp.data.nextPageToken)
    }
  }

  return items
}
async function getPlaylists(channelId, playlists = [], pageToken = null) {

  console.log('Getting playlists. Channel ID:', channelId, 'page:', pageToken)

  const resp = await axios.get('https://www.googleapis.com/youtube/v3/playlists', {
    params: {
      part: 'snippet,contentDetails',
      channelId,
      pageToken,
      maxResults: 100,
      key: process.env.YOUTUBE_API_KEY,
    }
  }).catch(err => console.error(err))

  if (get(resp, 'data.items')) {
    playlists.push(...resp.data.items)
    if (resp.data.nextPageToken) {
      await getPlaylists(channelId, playlists, resp.data.nextPageToken)
    }
  }

  return playlists
}

// Catches all uncaught errors so process never dies
process.on('uncaughtException', err => {
  console.log('Caught exception: ', err);
});

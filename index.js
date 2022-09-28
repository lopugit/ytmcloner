const axios = require('axios')
require('dotenv').config()
const { get } = require('lodash')
const fs = require('fs')
const config = require('./config.js')
const YoutubeMp3Downloader = require("youtube-mp3-downloader");
const ytdl = require('ytdl-core')
const promiseQueue = require('promise-queue')
const cp = require('child_process')
const ffmpeg = require('ffmpeg-static')

run()

async function run() {

  if (!config.useDump) {
    const playlists = await getPlaylists(process.env.CHANNEL_ID)

    const playlistNames = playlists.map(playlist => playlist.snippet.title)

    const playlistItems = {}
    const songs = []
    const songMap = {}
    for (const playlist of playlists) {
      const scrapePlaylist = config.whitelist && config.whitelist.length ? config.whitelist.includes(playlist.snippet.title) : true
      if (scrapePlaylist) {
        const items = await getPlaylistItems(playlist)
        playlistItems[playlist.snippet.title] = items
        items.forEach(item => {
          let song = songs.find(song => song.id === item.contentDetails.videoId)
          if (!song) {
            song = {
              title: item.snippet.title,
              id: item.contentDetails.videoId,
              playlists: [],
            }
            songs.push(song)
          }
          song.playlists.push(playlist.snippet.title)
          songMap[song.id] = song
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
      total: songs.reduce((total, song) => total + song.playlists.length, 0)
    }

    setInterval(() => {
      const totalToDownload = ((stats.total - stats.skipped) - stats.errors)
      console.log('Stats:', stats.downloaded, 'downloaded out of', totalToDownload, ',', stats.skipped, 'skipped,', stats.errors, 'errors,', stats.total, 'total songs, ', stats.skipped + stats.downloaded, 'stored')
      if (stats.downloaded === totalToDownload) {
        console.log('Finished downloading, exiting...')
        process.exit(0)
      }
    }, 2500)

    const queue = new promiseQueue(5, Infinity)

    for (const song of songs) {

      const songPaths = createPathsFromSong(song)
      let downloadStarted = false
      songPaths.forEach((path, i) => {
        const safePlaylistName = song.playlists[i].replace(/\//gi, '-')

        if (!fs.existsSync(config.outputDir + '/' + safePlaylistName)) {
          fs.mkdirSync(config.outputDir + '/' + safePlaylistName, { recursive: true })
        }

        const songExists = fs.existsSync(path)
        if (!songExists && !downloadStarted) {
          downloadStarted = true
          const path = config.tmpDir + '/' + song.id + '.mp3'
          queue.add(() => {
            return new Promise(resolve => {
              try {
                const audio = ytdl(song.id, {
                  quality: 'highestaudio',
                  ...(config.cookie ? {
                    requestOptions: {
                      headers: {
                        cookie: config.cookie
                      }
                    }
                  } : {})
                })
                  .on('response', (res) => {
                    console.log('Started downloading song', song.title, song.id, 'for playlists', song.playlists.join(', '))
                  })
                  .on('error', err => {
                    // console.error('Error downloading song', song.title, song.id, 'for playlists', song.playlists.join(', '), err)
                    stats.errors++
                    resolve()
                  })
                const ffmpegProcess = cp.spawn(ffmpeg, [
                  // Remove ffmpeg's console spamming
                  '-loglevel', '8', '-hide_banner',
                  // Redirect/Enable progress messages
                  '-progress', 'pipe:3',
                  // Set inputs
                  '-i', 'pipe:4',
                  // Map audio & video from streams
                  '-map', '0:a',
                  // Keep encoding
                  '-c:v', 'copy',
                  // set bitrate
                  '-b:a', '320k',
                  // Define output file
                  path,
                ], {
                  windowsHide: true,
                  stdio: [
                    /* Standard: stdin, stdout, stderr */
                    'inherit', 'inherit', 'inherit',
                    /* Custom: pipe:3, pipe:4, pipe:5 */
                    'pipe', 'pipe', 'pipe',
                  ],
                });

                ffmpegProcess.on('close', () => {
                  try {
                    setTimeout(() => {
                      const paths = createPathsFromSong(song)
                      for (const newPath of paths) {
                        console.log('Finished downloading, moving to', newPath);
                        fs.copyFileSync(path, newPath)
                      }
                      fs.unlinkSync(path)
                      stats.downloaded++
                      resolve()
                    }, 1000)
                  } catch (err) {
                    console.error(err)
                    stats.errors++
                    resolve()
                  }
                });

                audio.pipe(ffmpegProcess.stdio[4])
              } catch (err) {
                resolve()
              }
            })
          })
        } else {
          // console.log('Already downloaded', song.title, createPathFromSong(song))
          stats.skipped++
        }
      })

    }
  }

}

function createPathsFromSong(song) {
  const paths = []
  song.playlists.forEach(playlist => {
    const path = createPathFromSong(song, playlist)
    paths.push(path)
  })
  return paths
}
function createPathFromSong(song, playlist) {
  const safePlaylistName = playlist.replace(/\//gi, '-')
  const safeSongTitle = song.title.replace(/\//gi, '-')
  return `${config.outputDir}/${safePlaylistName}/${safeSongTitle}.mp3`
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

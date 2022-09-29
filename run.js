import axios from 'axios'
import { get } from 'lodash-es'
import fs from 'fs'
import config from './config.js'
import ytdl from 'ytdl-core'
import promiseQueue from 'promise-queue'
import cp from 'child_process'
import ffmpeg from 'ffmpeg-static'

import { consoleLogToFile } from "console-log-to-file";

consoleLogToFile({
  logFilePath: "log/default.log",
});

run()

async function run() {

  if (!config.useDump) {
    const playlistsRaw = await getPlaylists(config.channelId)
    const playlists = playlistsRaw
      .filter(playlist => {
        return config.useBlacklist && config.blacklist ? !config.blacklist.includes(playlist.snippet.title) : true
      })
      .filter(playlist => {
        return config.useWhitelist && config.whitelist ? config.whitelist.includes(playlist.snippet.title) : true
      })

    const playlistNames = playlists.map(playlist => playlist.snippet.title)

    const playlistItems = {}
    const songs = []
    const songMap = {}
    for (const playlist of playlists) {
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

    fs.writeFileSync('playlistNames.json', JSON.stringify(playlistNames, null, 2))
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
      private: 0,
      errors: 0,
      total: songs.reduce((total, song) => total + song.playlists.length, 0),
      sameCount: 0,
      prevDownloaded: 0,
      prevTotal: 1
    }

    const logInterval = setInterval(() => {
      const totalToDownload = ((stats.total - stats.skipped) - stats.errors) - stats.private
      console.log('Stats:', stats.downloaded, 'downloaded out of', totalToDownload, ',', stats.skipped, 'skipped,', stats.errors, 'errors,', stats.skipped + stats.downloaded, 'stored,', stats.private, 'private', stats.total, 'total songs')

      if (stats.prevDownloaded === stats.downloaded && stats.prevTotal === totalToDownload) {
        stats.sameCount++
      } else {
        stats.prevDownloaded = stats.downloaded
        stats.prevTotal = totalToDownload
        stats.sameCount = 0
      }

      if (stats.sameCount > 30 || stats.downloaded === totalToDownload) {
        console.log('Finished downloading, exiting...')
        clearInterval(logInterval)
        // process.exit(0)
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
        if (!songExists && !downloadStarted && song.title !== 'Private video') {
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
                    /* Custom: pipe:3, pipe:4 */
                    'pipe', 'pipe',
                  ],
                });

                ffmpegProcess.on('close', (res, res2) => {
                  // console.log(res, res2)
                  if (res === 0 && res2 === null) {
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
                  } else {
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
          if (song.title !== 'Private video') {
            stats.skipped++
          } else {
            stats.private++
          }
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
      key: config.youtubeApiKey,
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
      key: config.youtubeApiKey,
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

export default run
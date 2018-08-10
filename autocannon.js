#! /usr/bin/env node

'use strict'

const minimist = require('minimist')
const fs = require('fs')
const path = require('path')
const URL = require('url').URL
const nitm = require('nitm')
const managePath = require('manage-path')
const hasAsyncHooks = require('has-async-hooks')
const help = fs.readFileSync(path.join(__dirname, 'help.txt'), 'utf8')
const run = require('./lib/run')
const track = require('./lib/progressTracker')

if (typeof URL !== 'function') {
  console.error('autocannon requires the WHATWG URL API, but it is not available. Please upgrade to Node 6.13+.')
  process.exit(1)
}

module.exports = run
module.exports.track = track

module.exports.start = start
module.exports.parseArguments = parseArguments

function parseArguments (argvs) {
  const argv = minimist(argvs, {
    boolean: ['json', 'n', 'help', 'renderLatencyTable', 'renderProgressBar', 'forever', 'idReplacement', 'excludeErrorStats', 'onPort'],
    alias: {
      connections: 'c',
      pipelining: 'p',
      timeout: 't',
      duration: 'd',
      amount: 'a',
      json: 'j',
      renderLatencyTable: ['l', 'latency'],
      onPort: 'on-port',
      method: 'm',
      headers: ['H', 'header'],
      body: 'b',
      servername: 's',
      bailout: 'B',
      input: 'i',
      maxConnectionRequests: 'M',
      maxOverallRequests: 'O',
      connectionRate: 'r',
      overallRate: 'R',
      reconnectRate: 'D',
      renderProgressBar: 'progress',
      title: 'T',
      version: 'v',
      forever: 'f',
      idReplacement: 'I',
      socketPath: 'S',
      excludeErrorStats: 'x',
      help: 'h'
    },
    default: {
      connections: 10,
      timeout: 10,
      pipelining: 1,
      duration: 10,
      reconnectRate: 0,
      renderLatencyTable: false,
      renderProgressBar: true,
      json: false,
      forever: false,
      method: 'GET',
      idReplacement: false,
      excludeErrorStats: false
    },
    '--': true
  })

  argv.url = argv._[0]

  if (argv.onPort) {
    argv.spawn = argv['--']
  }

  // support -n to disable the progress bar and results table
  if (argv.n) {
    argv.renderProgressBar = false
    argv.renderResultsTable = false
  }

  if (argv.version) {
    console.log('autocannon', 'v' + require('./package').version)
    console.log('node', process.version)
    return
  }

  if (!argv.url || argv.help) {
    console.error(help)
    return
  }

  // if PORT is set (like by `0x`), target `localhost:PORT/path` by default.
  // this allows doing:
  //     0x --on-port 'autocannon /path' -- node server.js
  if (process.env.PORT) {
    argv.url = new URL(argv.url, `http://localhost:${process.env.PORT}`).href
  }
  // Add http:// if it's not there and this is not a /path
  if (argv.url.indexOf('http') !== 0 && argv.url[0] !== '/') {
    argv.url = `http://${argv.url}`
  }

  // check that the URL is valid.
  try {
    // If --on-port is given, it's acceptable to not have a hostname
    if (argv.onPort) {
      new URL(argv.url, 'http://localhost') // eslint-disable-line no-new
    } else {
      new URL(argv.url) // eslint-disable-line no-new
    }
  } catch (err) {
    console.error(err.message)
    console.error('')
    console.error('When targeting a path without a hostname, the PORT environment variable must be available.')
    console.error('Use a full URL or set the PORT variable.')
    process.exit(1)
  }

  if (argv.input) {
    argv.body = fs.readFileSync(argv.input)
  }

  if (argv.headers) {
    if (!Array.isArray(argv.headers)) {
      argv.headers = [argv.headers]
    }

    argv.headers = argv.headers.reduce((obj, header) => {
      let index
      if (
        (index = header.indexOf('=')) > 0 ||
        (index = header.indexOf(':')) > 0
      ) {
        obj[header.slice(0, index)] = header.slice(index + 1)
        return obj
      } else throw new Error(`An HTTP header was not correctly formatted: ${header}`)
    }, {})
  }

  return argv
}

function start (argv) {
  if (!argv) {
    // we are printing the help
    return
  }

  if (argv.onPort) {
    if (!hasAsyncHooks()) {
      console.error('The --on-port flag requires the async_hooks builtin module, but it is not available. Please upgrade to Node 8.1+.')
      process.exit(1)
    }

    // manage-path always uses the $PATH variable, but we can pretend
    // that it is equal to $NODE_PATH
    const alterPath = managePath({ PATH: process.env.NODE_PATH })
    alterPath.unshift(path.join(__dirname, 'injects'))

    const proc = nitm(['-r', 'autocannonDetectPort'], argv.spawn, {
      stdio: ['ignore', 'inherit', 'inherit', 'pipe'],
      env: Object.assign({}, process.env, {
        NODE_PATH: alterPath.get()
      })
    })

    proc.stdio[3].once('data', (chunk) => {
      const port = chunk.toString()
      const url = new URL(argv.url, `http://localhost:${port}`).href
      const opts = Object.assign({}, argv, {
        onPort: false,
        url: url
      })
      runTracker(opts, () => {
        // `nitm` catches the SIGINT so we write it to a file descriptor
        // instead of doing proc.kill()
        proc.stdio[3].write('SIGINT')
        // Not closing the stream 3 here, calling .end() will throw an error:
        // https://github.com/nodejs/node/issues/13542
        // The child will exit cleanly and close the pipe then.
      })
    })
  } else {
    runTracker(argv)
  }
}

function runTracker (argv, ondone) {
  const tracker = run(argv)

  tracker.on('done', (result) => {
    if (ondone) ondone()
    if (argv.json) {
      console.log(JSON.stringify(result))
    }
  })

  tracker.on('error', (err) => {
    if (err) {
      throw err
    }
  })

  // if not rendering json, or if std isn't a tty, track progress
  if (!argv.json || !process.stdout.isTTY) track(tracker, argv)

  process.once('SIGINT', () => {
    tracker.stop()
  })
}

if (require.main === module) {
  start(parseArguments(process.argv.slice(2)))
}

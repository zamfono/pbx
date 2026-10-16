// The voice bot `inbound-forward-web-socket` hands its call to (§9.4 "WebSocket targets"): a
// Vonage-protocol WebSocket server on 8765, run from the api image with its `ws`. It keeps the
// `websocket:connected` frame and the caller's audio, sends two seconds of a 1 kHz tone at 16 kHz
// little-endian, then a `notify`; once that comes back it hangs the call up through the API with
// its session token, and writes what it saw to /tmp/voice-bot/result.json as its socket closes.
const fs = require('node:fs');
const { WebSocketServer } = require('ws');

const RATE = 16000;
const TONE_HZ = 1000;
const dir = '/tmp/voice-bot';
fs.mkdirSync(dir, { recursive: true });

/** Two seconds of the tone, 16-bit little-endian, at half scale. */
function tone() {
  const samples = RATE * 2;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(
      Math.round(16000 * Math.sin((2 * Math.PI * TONE_HZ * i) / RATE)),
      i * 2
    );
  }
  return pcm;
}

new WebSocketServer({ port: 8765 }, () => {
  fs.writeFileSync('/tmp/voice-bot.pid', String(process.pid));
  fs.writeFileSync(`${dir}/listening`, '');
}).on('connection', (socket, request) => {
  const result = {
    path: request.url,
    connected: null,
    audioBytes: 0,
    notified: null,
    hangup: null
  };
  const audio = [];
  // Written once the socket has closed and the hangup request, if any, has its answer.
  let closed = false;
  let hangingUp = null;
  const finish = () => {
    fs.writeFileSync(`${dir}/caller.raw`, Buffer.concat(audio));
    fs.writeFileSync(`${dir}/result.json`, JSON.stringify(result));
  };
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      audio.push(data);
      result.audioBytes += data.length;
      return;
    }
    const frame = JSON.parse(data.toString());
    if (frame.event === 'websocket:connected') {
      result.connected = frame;
      const pcm = tone();
      for (let at = 0; at < pcm.length; at += 640) {
        socket.send(pcm.subarray(at, at + 640));
      }
      socket.send(
        JSON.stringify({ action: 'notify', payload: { played: 'tone' } })
      );
    } else if (frame.event === 'websocket:notify') {
      result.notified = frame.payload;
      // Inside the Compose network `api` answers on 3000; `apiUrl` names the public FQDN.
      hangingUp = fetch(
        `http://api:3000/api/v1/calls/${result.connected.callId}/hangup`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${result.connected.sessionToken}`,
            'content-type': 'application/json'
          },
          body: '{}'
        }
      ).then(response => {
        result.hangup = response.status;
        if (closed) {
          finish();
        }
      });
    }
  });
  socket.on('close', () => {
    closed = true;
    if (hangingUp === null || result.hangup !== null) {
      finish();
    }
  });
});

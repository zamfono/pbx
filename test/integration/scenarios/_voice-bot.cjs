// The voice bot the `inbound-forward-web-socket*` scenarios hand their call to (§9.4 "WebSocket
// targets"): a WebSocket server on 8765, run from the api image with its `ws`, speaking
// `PROTOCOL` (`vonage`, the default, or `twilio`) at `RATE` Hz (16000 unless given; `twilio` is
// always 8000). It keeps the stream's opening metadata and the caller's audio as 16-bit
// little-endian linear (a `twilio` bot's μ-law decoded here), sends two seconds of a 1 kHz tone,
// then a marker (Vonage's `notify`, Twilio's `mark`); once that comes back it hangs the call up
// through the API with its session token, and writes what it saw to /tmp/voice-bot/result.json
// as its socket closes.
const fs = require('node:fs');
const { WebSocketServer } = require('ws');

const PROTOCOL = process.env.PROTOCOL || 'vonage';
const RATE = PROTOCOL === 'twilio' ? 8000 : Number(process.env.RATE || 16000);
const TONE_HZ = 1000;
// 20 ms of the tone per frame sent.
const FRAME_SAMPLES = RATE / 50;
const dir = '/tmp/voice-bot';
fs.mkdirSync(dir, { recursive: true });

/** Two seconds of the tone at half scale, as samples. */
function tone() {
  return Array.from({ length: RATE * 2 }, (_, i) =>
    Math.round(16000 * Math.sin((2 * Math.PI * TONE_HZ * i) / RATE))
  );
}

/** G.711 μ-law, the reference C's segment table. */
function ulawEncode(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  const biased = Math.min(Math.abs(sample), 32635) + 0x84;
  const segment = 31 - Math.clz32(biased) - 7;
  const step = (biased >> (segment + 3)) & 0x0f;
  return ~(sign | (segment << 4) | step) & 0xff;
}

function ulawDecode(code) {
  const inverted = ~code & 0xff;
  const magnitude =
    ((((inverted & 0x0f) << 3) + 0x84) << ((inverted >> 4) & 7)) - 0x84;
  return inverted & 0x80 ? -magnitude : magnitude;
}

function linear(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => pcm.writeInt16LE(sample, i * 2));
  return pcm;
}

/** What each protocol's frames mean to the bot: the opening metadata, the caller's audio, and the
 * marker coming back; and what it sends: its audio and a marker. */
const protocols = {
  vonage: {
    opened: frame => (frame.event === 'websocket:connected' ? frame : null),
    audio: (data, isBinary) => (isBinary ? data : null),
    marked: frame =>
      frame.event === 'websocket:notify' ? frame.payload : null,
    send: (socket, samples) => socket.send(linear(samples)),
    mark: socket =>
      socket.send(
        JSON.stringify({ action: 'notify', payload: { played: 'tone' } })
      )
  },
  twilio: {
    opened: frame =>
      frame.event === 'start'
        ? {
            ...frame.start.customParameters,
            callSid: frame.start.callSid,
            streamSid: frame.start.streamSid,
            mediaFormat: frame.start.mediaFormat
          }
        : null,
    audio: (data, isBinary) => {
      if (isBinary) return null;
      const frame = JSON.parse(data.toString());
      if (frame.event !== 'media') return null;
      return linear(
        [...Buffer.from(frame.media.payload, 'base64')].map(ulawDecode)
      );
    },
    marked: frame =>
      frame.event === 'mark' ? { played: frame.mark.name } : null,
    send: (socket, samples) =>
      socket.send(
        JSON.stringify({
          event: 'media',
          media: {
            payload: Buffer.from(samples.map(ulawEncode)).toString('base64')
          }
        })
      ),
    mark: socket =>
      socket.send(JSON.stringify({ event: 'mark', mark: { name: 'tone' } }))
  }
};
const protocol = protocols[PROTOCOL];

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
    const pcm = protocol.audio(data, isBinary);
    if (pcm !== null) {
      audio.push(pcm);
      result.audioBytes += pcm.length;
      return;
    }
    if (isBinary) return;
    const frame = JSON.parse(data.toString());
    const opened = protocol.opened(frame);
    const marked = protocol.marked(frame);
    if (opened !== null) {
      result.connected = opened;
      const samples = tone();
      for (let at = 0; at < samples.length; at += FRAME_SAMPLES) {
        protocol.send(socket, samples.slice(at, at + FRAME_SAMPLES));
      }
      protocol.mark(socket);
    } else if (marked !== null) {
      result.notified = marked;
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

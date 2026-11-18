// The HTTP receiver the request scenarios send to (§10.6 "HTTP requests"): a plain HTTP server on
// 8766, run from the api image in the `voice-bot` container, as a system on the LAN would be
// reached. It keeps every request it gets, one JSON line each, in /tmp/http-receiver/requests.jsonl:
//   GET /lookup   a call flow's HTTP request (`inbound-http-request`): answers the JSON the
//                 scenario's decision routes on, `{ "data": { "tier": "vip" } }`.
//   POST /calls   an after-call request (`inbound-after-call-request`): answers 200, then does
//                 what a receiver is given the recording links for, a GET of `downloadUrl` and a
//                 DELETE of `deleteUrl`, and notes what each answered. Inside the Compose
//                 network `api` answers on 3000; the links name the public FQDN.
const fs = require('node:fs');
const http = require('node:http');

const dir = '/tmp/http-receiver';
fs.mkdirSync(dir, { recursive: true });

function note(entry) {
  fs.appendFileSync(`${dir}/requests.jsonl`, `${JSON.stringify(entry)}\n`);
}

/** `url` on the stack's public origin, as `api` answers it inside the Compose network. */
function internal(url) {
  const parsed = new URL(url);
  return `http://api:3000${parsed.pathname}${parsed.search}`;
}

async function useLinks(record) {
  const [recording] = record.recordings || [];
  if (!recording || !recording.downloadUrl || !recording.deleteUrl) {
    return { links: 'missing' };
  }
  const download = await fetch(internal(recording.downloadUrl));
  const audio = Buffer.from(await download.arrayBuffer());
  const removed = await fetch(internal(recording.deleteUrl), {
    method: 'DELETE'
  });
  const again = await fetch(internal(recording.downloadUrl));
  return {
    recordingId: recording.id,
    download: download.status,
    audioBytes: audio.length,
    riff: audio.subarray(0, 4).toString('latin1'),
    delete: removed.status,
    downloadAfterDelete: again.status
  };
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      };
      if (req.url.startsWith('/lookup')) {
        note(entry);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { tier: 'vip' } }));
        return;
      }
      res.writeHead(200).end();
      useLinks(JSON.parse(body))
        .catch(error => ({ error: String(error) }))
        .then(links => note({ ...entry, links }));
    });
  })
  .listen(8766, () => {
    fs.writeFileSync('/tmp/http-receiver.pid', String(process.pid));
    fs.writeFileSync(`${dir}/listening`, '');
  });

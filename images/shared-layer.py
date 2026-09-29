"""Checks that two images share the layer one `RUN` step produced: api and core start their runtime
stage with the same ffmpeg step, byte for byte (images/{api,core}/Dockerfile), so one bake run
builds it once and both images carry its ~460 MB layer only once, in CI's image archive and in an
operator's pull. Separate builds would each make a layer of their own, so only a pair from one
bake run passes; ci.yaml's image-tests job runs it on the images the `images` job built.

  python3 images/shared-layer.py <image> <image> <text of the step's command>

`docker history` shows no layer ids, so each image's config is read from `docker save`'s output
instead: its `history` entries that are not `empty_layer` line up one to one with
`rootfs.diff_ids`.
"""
import json
import subprocess
import sys
import tarfile


def small_blobs(image: str) -> dict[str, bytes]:
    """Every blob under 1 MB in `docker save`'s output, by digest: the index, manifests and config
    are, the layers stream past unread."""
    save = subprocess.Popen(['docker', 'save', image], stdout=subprocess.PIPE)
    blobs = {}
    with tarfile.open(fileobj=save.stdout, mode='r|') as archive:
        for member in archive:
            if member.isfile() and member.size < 1_000_000 and member.name.startswith('blobs/'):
                blobs['sha256:' + member.name.rsplit('/', 1)[1]] = archive.extractfile(member).read()
    save.wait()
    return blobs


def config_of(image: str) -> dict:
    """The image's config. Its id is the digest of the config itself with Docker's classic image
    store, and of an index with the containerd store, which leads through the manifest for
    linux/amd64 (or the only one) to the config."""
    digest = subprocess.run(
        ['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    blobs = small_blobs(image)
    doc = json.loads(blobs[digest])
    while 'manifests' in doc:
        images = [m for m in doc['manifests']
                  if m.get('platform', {}).get('os') not in (None, 'unknown')]
        chosen = next((m for m in images if m['platform'].get('architecture') == 'amd64'),
                      (images or doc['manifests'])[0])
        doc = json.loads(blobs[chosen['digest']])
    # A manifest points at its config by digest; a config's own `config` holds Env, Cmd and the
    # like, and no digest.
    if 'digest' in doc.get('config', {}):
        doc = json.loads(blobs[doc['config']['digest']])
    return doc


def layer_of(image: str, needle: str) -> str:
    config = config_of(image)
    layers = iter(config['rootfs']['diff_ids'])
    for entry in config['history']:
        layer = None if entry.get('empty_layer') else next(layers)
        if needle in entry.get('created_by', ''):
            return layer
    sys.exit(f'{image} has no step containing {needle!r}')


first, second, needle = sys.argv[1:4]
a, b = layer_of(first, needle), layer_of(second, needle)
if a != b:
    sys.exit(f'{first} and {second} each have their own layer for {needle!r}: {a} and {b}')
print(f'{first} and {second} share {a}')

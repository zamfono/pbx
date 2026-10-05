# Run in the `devices` container by `inbound-device-contacts.setup.sh`: waits until an INVITE has
# reached both of the device's phones (their baresip SIP traces, `$1` and `$2`), then tells the
# second one to answer over its `ctrl_tcp` port `$3`, so the race is won by a phone that rang
# alongside the other, never before the other was dialled.
import json
import socket
import sys
import time

ring_log, answer_log, port = sys.argv[1], sys.argv[2], int(sys.argv[3])


def rang(path):
    try:
        with open(path, errors='replace') as trace:
            return 'INVITE sip:' in trace.read()
    except OSError:
        return False


deadline = time.time() + 90
while not (rang(ring_log) and rang(answer_log)):
    if time.time() > deadline:
        sys.exit('no INVITE reached both phones within 90 s')
    time.sleep(0.2)
command = json.dumps({'command': 'accept', 'params': '', 'token': 'ci'}).encode()
with socket.create_connection(('127.0.0.1', port)) as control:
    control.sendall(b'%d:%s,' % (len(command), command))
    control.recv(4096)

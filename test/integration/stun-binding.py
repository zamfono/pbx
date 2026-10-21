# §6.1 STUN, run by steps.sh's `step_stun` inside a peer on `internal`: sends one RFC 5389 Binding
# request to `$1`:3478/udp and checks the answer names this socket's own address and port in
# XOR-MAPPED-ADDRESS, which no NAT changes on `internal`, and carries neither SOFTWARE
# (`--no-software-attribute`) nor RESPONSE-ORIGIN, which would name the container's own address
# in the ports mode (compose.yaml's `stun`).
import os
import socket
import struct
import sys

COOKIE = 0x2112A442
XOR_MAPPED_ADDRESS, SOFTWARE, RESPONSE_ORIGIN = 0x0020, 0x8022, 0x802B

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(5)
sock.connect((sys.argv[1], 3478))
local = sock.getsockname()
transaction = os.urandom(12)
sock.send(struct.pack('!HHI', 0x0001, 0, COOKIE) + transaction)
answer = sock.recv(2048)
if answer[:2] != b'\x01\x01' or answer[8:20] != transaction:
    sys.exit(f'not a Binding success response to this request: {answer.hex()}')

attributes = {}
at = 20
while at + 4 <= len(answer):
    kind, size = struct.unpack_from('!HH', answer, at)
    attributes[kind] = answer[at + 4:at + 4 + size]
    at += 4 + (size + 3) // 4 * 4

for kind, name in ((SOFTWARE, 'SOFTWARE'), (RESPONSE_ORIGIN, 'RESPONSE-ORIGIN')):
    if kind in attributes:
        sys.exit(f'the answer carries {name}')
value = attributes.get(XOR_MAPPED_ADDRESS)
if value is None or value[1] != 0x01:
    sys.exit('the answer carries no IPv4 XOR-MAPPED-ADDRESS')
port = struct.unpack_from('!H', value, 2)[0] ^ (COOKIE >> 16)
address = socket.inet_ntoa(struct.pack('!I', struct.unpack_from('!I', value, 4)[0] ^ COOKIE))
if (address, port) != local:
    sys.exit(f'the answer names {address}:{port}, not the asking {local[0]}:{local[1]}')
print(f'   {address}:{port} named in XOR-MAPPED-ADDRESS, no SOFTWARE, no RESPONSE-ORIGIN')

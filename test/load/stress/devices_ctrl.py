#!/usr/bin/env python3
"""test/load/stress: drives the devices' calls through baresip's ctrl_tcp, one baresip process
after the other, spaced <interval_s> apart. Runs inside the devices container, where each
process's ctrl_tcp listens on 127.0.0.1:<first_port + index> (one account per process).

  hangup  ends each process's current call from the device side, spaced like the ramp that set
          the calls up (so every call lasts about as long as the ramp made it, and the drain is
          as bunched as the ramp was)
  dial    places one outbound call per process to <number_prefix><index:03d>@<domain> (the
          stack routes it out through the trunk, where the provider-side sipp UAS answers it)
  rereg   has the <count> accounts of the one process on <first_port> register anew, at once,
          with gen_baresip.py's interval (`uareg <regint> <index>`): what a Ringotel app does on
          `api`'s `rereg` push (docs/spec.md §10.4 "After a restart")

Usage: devices_ctrl.py hangup <first_port> <count> <interval_s>
       devices_ctrl.py dial <first_port> <count> <interval_s> <number_prefix> <domain>
       devices_ctrl.py rereg <first_port> <count> <interval_s>
"""
import json
import socket
import sys
import time


def netstring(payload: bytes) -> bytes:
    return str(len(payload)).encode() + b':' + payload + b','


def command(port: int, name: str, params: str) -> str:
    msg = json.dumps({'command': name, 'params': params, 'token': str(port)}).encode()
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=3) as s:
            s.sendall(netstring(msg))
            s.settimeout(3)
            return s.recv(4096).decode(errors='replace')[:160]
    except OSError as error:
        return f'ERR {error}'


def main() -> None:
    action, first, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    interval = float(sys.argv[4])
    start = time.time()
    for i in range(count):
        port, name, params = first + i, action, ''
        if action == 'dial':
            params = f'sip:{sys.argv[5]}{i:03d}@{sys.argv[6]}'
        elif action == 'rereg':
            port, name, params = first, 'uareg', f'600 {i}'
        reply = command(port, name, params)
        print(f'{time.time() - start:6.2f}s port {port} {name} {params}: {reply}',
              flush=True)
        time.sleep(max(0.0, start + (i + 1) * interval - time.time()))


if __name__ == '__main__':
    main()

---
name: Bug report
about: Something in the stack behaves differently from the admin guide or the specification
labels: [bug]
---

<!--
Security problems go to the private advisory form, not here (see SECURITY.md).
Bugs in Asterisk itself belong upstream: https://github.com/asterisk/asterisk/issues
Remove phone numbers, e-mail addresses, credentials and tokens from everything you paste.
-->

**What happened, and what did you expect?**

**How to reproduce it** (the REST calls or MCP requests, or the call you placed: from where, to
which number):

**Version and runtime:**

- image tag (`ZAMFONO_VERSION`, or `latest`):
- Docker or Podman, and its version:
- overlay (`compose.ports.yaml` or `compose.macvlan.yaml`):

**Logs** from around the time it happened:

```
docker compose logs --since 10m api core asterisk
```

**For a call:** the call's routing trace from its call history entry (trace level `events` or
`sip`, §7 of the specification), and the softphone or trunk involved.

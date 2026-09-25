#!/usr/bin/env python3
"""test/load: (re)generates load-caller.xml, load-provider.xml and load-provider-ulaw.xml from
the templates below. Not part of the measurement run itself -- the three files it writes are
committed and read as plain sipp scenario XML; this script only exists so the repeat count (call
hold duration) or the CDATA bodies can be changed in one place instead of by hand in three files.
Run from anywhere; writes into its own directory's scenarios/ subdirectory.
"""
from pathlib import Path

REPO = str(Path(__file__).resolve().parent.parent.parent)

# play_pcap_audio is asynchronous (RFC of sipp's own docs: it schedules the pcap's packets onto
# the RTP socket in the background and returns immediately; it does NOT block the scenario for
# the pcap's duration). A first attempt without the trailing <pause> raced through all repeats in
# a couple of milliseconds -- one real debug call showed "8 Total RTP pckts sent" for an 8x loop
# of a 236-packet pcap and a 28ms call length, instead of ~56s -- because each new
# play_pcap_audio call interrupts the previous one's still-in-flight send. Following each one with
# a <pause> at least as long as the pcap's own real duration (g711a.pcap: 236 packets, ~7.05s,
# measured from its own timestamps) lets it fully play out before the next call retriggers it,
# and is what actually produces a real, sustained ~N*7s hold with continuous RTP.
PCAP_DURATION_MS = 7050

BLOCK = '''
  <nop>
    <action>
      <exec play_pcap_audio="{pcap}"/>
    </action>
  </nop>
  <pause milliseconds="{pause_ms}"/>
'''


def repeated(pcap, times):
    return "".join(
        BLOCK.format(pcap=pcap, pause_ms=PCAP_DURATION_MS) for _ in range(times)
    )


CALLER_TMPL = '''<?xml version="1.0" encoding="ISO-8859-1"?>
<!--
  test/load: the trunk-side caller leg of the concurrent-call load steps (docs/spec.md §6.6
  "Sizing envelope"). Modelled on test/integration/scenarios/inbound-forward-external.xml: the
  ring group answers immediately to play hold music while the sole member's unconditional
  forward is dialled back out over the trunk to sipp-provider (load-provider.xml /
  load-provider-ulaw.xml). Unlike the single-call CI scenario, this leg plays real RTP audio
  (sipp's own /sipp/g711a.pcap, replayed {reps} times, ~{secs}s) for the plateau hold instead of a
  bare pause, so Asterisk actually relays media both ways for the duration docker stats samples.
-->
<scenario name="load caller">
  <send retrans="500">
    <![CDATA[
      INVITE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: <sip:+15559999@[local_ip]>;tag=[call_number]
      To: <sip:[service]@[remote_ip]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: <sip:+15559999@[local_ip]:[local_port];transport=[transport]>
      Max-Forwards: 70
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=user1 53655765 2353687637 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP 8
      a=rtpmap:8 PCMA/8000
    ]]>
  </send>

  <recv response="100" optional="true" />
  <recv response="180" optional="true" />
  <recv response="183" optional="true" />
  <recv response="200" rtd="true" timeout="40000" />

  <send>
    <![CDATA[
      ACK sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: <sip:+15559999@[local_ip]>;tag=[call_number]
      To: <sip:[service]@[remote_ip]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 1 ACK
      Max-Forwards: 70
      Content-Length: 0
    ]]>
  </send>

  <!-- Real bidirectional RTP for the plateau hold, once the forwarded leg has had time to answer
       (the group's own answer above is immediate MOH; the bridge to the forwarded party follows
       a moment later). {reps} plays of the ~7s pcap hold this leg up for roughly {secs}s. -->
{plays}
  <send retrans="500">
    <![CDATA[
      BYE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: <sip:+15559999@[local_ip]>;tag=[call_number]
      To: <sip:[service]@[remote_ip]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 2 BYE
      Max-Forwards: 70
      Content-Length: 0
    ]]>
  </send>

  <recv response="200" crlf="true" />
</scenario>
'''

PROVIDER_TMPL = '''<?xml version="1.0" encoding="ISO-8859-1"?>
<!--
  test/load: the trunk-side answering leg for the forwarded call (played in the sipp-provider
  container, one process per load step serving every concurrent forwarded INVITE Asterisk sends
  it). Modelled on test/integration/scenarios/uas/answer-outbound.xml, but plays real RTP audio
  back ({reps} plays of {pcap_desc}, ~{secs}s) instead of silence, and never sends its own BYE:
  the caller leg (load-caller.xml) ends the call after its own hold, and this side just waits for
  it.
-->
<scenario name="load provider">
  <recv request="INVITE" rrs="true" />

  <send>
    <![CDATA[
      SIP/2.0 180 Ringing
      [last_Via:]
      [last_From:]
      [last_To:];tag=[call_number]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:[local_ip]:[local_port];transport=[transport]>
      Content-Length: 0
    ]]>
  </send>

  <send retrans="500">
    <![CDATA[
      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:];tag=[call_number]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:[local_ip]:[local_port];transport=[transport]>
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=phone 53655765 2353687637 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP {payload}
      a=rtpmap:{payload} {codec}/8000
    ]]>
  </send>

  <recv request="ACK" rtd="true" crlf="true" />

{plays}
  <recv request="BYE" timeout="40000" />

  <send>
    <![CDATA[
      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Content-Length: 0
    ]]>
  </send>
</scenario>
'''

# ~42s/~35s holds (not the task text's ~90s): the whole flock-wrapped session -- stack bring-up,
# 4 load steps' ramp+hold+drain, the 200-endpoint bulk create, teardown -- has to fit one
# Bash-tool call's 10-minute ceiling, confirmed tight even after fixing the two bugs below (a
# 12-13 minute run at 8/6 reps and a 40s hold, measured before the fixes, barely dropped under budget
# after them since most of that time is ramp_timeout/hold/drain polling that runs regardless of
# whether calls succeed). Raise these if that budget is not a constraint for a given run.
#
# Two bugs this repeat-with-pause design and the session.sh listener fix (see
# test/load/session.sh, "registering the one answering device") work around, found by hand with
# test/load/session.sh's single-call debug driver (not committed -- see git history/session notes
# if reproducing): (1) play_pcap_audio is asynchronous in sipp 3.5.1 and returns immediately, so a
# run of bare <exec> actions with no <pause> between them raced through in milliseconds instead of
# holding for real time; (2) phone.sh's own `register` action binds the contact and exits, leaving
# nothing to answer Asterisk's ongoing qualify OPTIONS probes, so core's Presence-based
# registeredDevices() (packages/core/src/calls/ringGroupState.ts) sees the member as unregistered
# within seconds and ringGroup.ts's ringable() drops it before ever looking at its forwarding
# rule -- every call fell straight through to voicemail until a persistent `phone.sh listen`
# process was added alongside the one-shot register.
CALLER_REPS = 6
PROVIDER_REPS = 5

caller = CALLER_TMPL.format(
    reps=CALLER_REPS, secs=CALLER_REPS * PCAP_DURATION_MS // 1000,
    plays=repeated('/sipp/g711a.pcap', CALLER_REPS)
)
with open(f'{REPO}/test/load/scenarios/load-caller.xml', 'w') as f:
    f.write(caller)

provider_alaw = PROVIDER_TMPL.format(
    reps=PROVIDER_REPS, secs=PROVIDER_REPS * PCAP_DURATION_MS // 1000,
    pcap_desc='sipp\'s own g711a.pcap (alaw, matching the caller leg, no transcoding)',
    plays=repeated('/sipp/g711a.pcap', PROVIDER_REPS),
    payload=8, codec='PCMA'
)
with open(f'{REPO}/test/load/scenarios/load-provider.xml', 'w') as f:
    f.write(provider_alaw)

provider_ulaw = PROVIDER_TMPL.format(
    reps=PROVIDER_REPS, secs=PROVIDER_REPS * PCAP_DURATION_MS // 1000,
    pcap_desc='a ulaw transcode of it, forcing Asterisk to transcode alaw/ulaw on the bridge',
    plays=repeated('/load-gen/g711u.pcap', PROVIDER_REPS),
    payload=0, codec='PCMU'
)
with open(f'{REPO}/test/load/scenarios/load-provider-ulaw.xml', 'w') as f:
    f.write(provider_ulaw)

print('wrote load-caller.xml, load-provider.xml, load-provider-ulaw.xml')

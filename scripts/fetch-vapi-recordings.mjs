import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const KEY = env.VAPI_PRIVATE_KEY || env.VAPI_API_KEY;
if (!KEY) throw new Error('no VAPI_PRIVATE_KEY');

const ids = process.argv.slice(2);
mkdirSync('/tmp/vapi-rec', { recursive: true });

for (const id of ids) {
  try {
    const res = await fetch(`https://api.vapi.ai/call/${id}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) {
      console.log(`\n=== ${id} :: HTTP ${res.status} ===`);
      console.log((await res.text()).slice(0, 300));
      continue;
    }
    const call = await res.json();
    const rec = call.recordingUrl || call.artifact?.recordingUrl || call.stereoRecordingUrl || call.artifact?.stereoRecordingUrl || '';
    const transcript = call.transcript || call.artifact?.transcript || '';
    const messages = call.messages || call.artifact?.messages || [];
    const summary = call.summary || call.analysis?.summary || '';
    writeFileSync(`/tmp/vapi-rec/${id}.json`, JSON.stringify(call, null, 2));

    console.log(`\n============================================================`);
    console.log(`CALL ${id}`);
    console.log(`customer=${call.customer?.number || ''} status=${call.status} endedReason=${call.endedReason || ''}`);
    console.log(`started=${call.startedAt || ''} ended=${call.endedAt || ''} costUsd=${call.cost ?? ''}`);
    console.log(`recordingUrl=${rec || 'NONE'}`);
    if (summary) console.log(`SUMMARY: ${summary}`);
    console.log(`--- TRANSCRIPT ---`);
    if (transcript) {
      console.log(transcript);
    } else if (Array.isArray(messages) && messages.length) {
      for (const m of messages) {
        const role = m.role || m.speaker || '?';
        const text = (m.message || m.content || m.text || '').toString().trim();
        if (text) console.log(`[${role}] ${text}`);
      }
    } else {
      console.log('(no transcript in Vapi payload)');
    }

    if (rec) {
      const audioRes = await fetch(rec);
      if (audioRes.ok) {
        const buf = Buffer.from(await audioRes.arrayBuffer());
        const ext = rec.includes('.wav') ? 'wav' : 'mp3';
        writeFileSync(`/tmp/vapi-rec/${id}.${ext}`, buf);
        console.log(`SAVED /tmp/vapi-rec/${id}.${ext} (${buf.length} bytes)`);
      } else {
        console.log(`recording download HTTP ${audioRes.status}`);
      }
    }
  } catch (e) {
    console.log(`\n=== ${id} :: ERROR ${e?.message || e} ===`);
  }
}
console.log('\nDONE');
